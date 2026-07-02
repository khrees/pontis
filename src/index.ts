import pkg from "../package.json";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { extractApiKey, authErrorResponse } from "./auth";
import {
  matchesApiPath,
  resolveModelAndUpstream,
  requestHasImages,
  routeConfig,
  upstreamFormat,
} from "./config";
import { debugLog } from "./logger";
import { handleModelsRequest } from "./handlers/models";
import { handleResponsesRequest } from "./handlers/responses";
import {
  anthropicHeaders,
  fetchWithTimeout,
  generateRequestId,
  jsonResponse,
  openaiAuthHeaders,
  passthroughResponse,
  SSE_HEADERS,
  upstreamErrorResponse,
  wrapProxyRequest,
} from "./http";
import { formatAnthropicToOpenAI } from "./translate/request/anthropic-to-openai";
import { formatOpenAIToAnthropic } from "./translate/request/openai-to-anthropic";
import { formatOpenAIToAnthropic as toAnthropicResponse } from "./translate/response/openai-to-anthropic";
import { formatAnthropicToOpenAI as toOpenAIResponse } from "./translate/response/anthropic-to-openai";
import { streamOpenAIToAnthropic } from "./translate/stream/openai-to-anthropic";
import { streamAnthropicToOpenAI } from "./translate/stream/anthropic-to-openai";
import {
  formatOpenAICompletionToOpenAIChat,
  formatOpenAIChatToOpenAICompletion,
  streamOpenAIChatToOpenAICompletion,
  formatAnthropicToOpenAICompletion,
  formatOpenAICompletionToAnthropic,
  formatAnthropicToOpenAICompletionResponse as toOpenAICompletionResponse,
  formatOpenAICompletionToAnthropicResponse as toAnthropicResponseFromCompletion,
  streamAnthropicToOpenAICompletion,
  streamOpenAICompletionToAnthropic,
} from "./translate/completions";
import type {
  AnthropicRequest,
  AnthropicResponse,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
  OpenAIRequest,
  OpenAIResponse,
} from "./types";

// ──────────────────────────────────────────────
//  Per-endpoint handlers
// ──────────────────────────────────────────────

/** POST /v1/messages — Anthropic → OpenAI / completions / passthrough */
async function handleV1Messages(
  reqId: string,
  request: Request,
  route: ReturnType<typeof routeConfig>,
  fmt: ReturnType<typeof upstreamFormat>,
  key: string | null,
): Promise<Response> {
  return wrapProxyRequest(reqId, async () => {
    const req = (await request.json()) as AnthropicRequest;
    const originalModel = req.model;
    if (route.modelOverride) req.model = route.modelOverride;

    debugLog(`[${reqId}] Received Anthropic messages count: ${req.messages?.length}`);

    const { model: resolvedModel, upstream, authErr } = resolveModelAndUpstream(
      request,
      route.upstream,
      req.model,
      { hasVision: requestHasImages(req.messages) },
    );
    if (authErr) return authErrorResponse(authErr);
    req.model = resolvedModel;
    debugLog(`[${reqId}] POST /v1/messages → ${upstream} (model=${resolvedModel})`);

    if (fmt === "openai") {
      const openaiReq = formatAnthropicToOpenAI(req);
      debugLog(`[${reqId}] Translated OpenAI messages: ${JSON.stringify(openaiReq.messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 100) + "..." : m.content })))}`);

      const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
        body: JSON.stringify(openaiReq),
      });
      debugLog(`[${reqId}] Upstream fetch headers received (status=${res.status})`);

      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

      if (openaiReq.stream) {
        debugLog(`[${reqId}] Returning stream Response`);
        return new Response(
          streamOpenAIToAnthropic(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            originalModel,
          ),
          { headers: SSE_HEADERS },
        );
      }
      const jsonVal = await res.json();
      return jsonResponse(
        toAnthropicResponse(jsonVal as OpenAIResponse, originalModel),
      );
    }

    if (fmt === "openai-completions") {
      const completionReq = formatAnthropicToOpenAICompletion(req);
      const res = await fetchWithTimeout(`${upstream}/completions`, {
        method: "POST",
        headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
        body: JSON.stringify(completionReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

      if (completionReq.stream) {
        return new Response(
          streamOpenAICompletionToAnthropic(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            originalModel,
          ),
          { headers: SSE_HEADERS },
        );
      }
      return jsonResponse(
        toAnthropicResponseFromCompletion(
          (await res.json()) as OpenAICompletionResponse,
          originalModel,
        ),
      );
    }

    // Anthropic passthrough
    const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
      method: "POST",
      headers: { ...anthropicHeaders(request, key!), "X-Request-Id": reqId },
      body: JSON.stringify(req),
    });
    if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);
    return passthroughResponse(res);
  });
}

/** POST /v1/chat/completions — OpenAI Chat → Anthropic / passthrough */
async function handleChatCompletions(
  reqId: string,
  request: Request,
  route: ReturnType<typeof routeConfig>,
  fmt: ReturnType<typeof upstreamFormat>,
  key: string | null,
): Promise<Response> {
  return wrapProxyRequest(reqId, async () => {
    const req = (await request.json()) as OpenAIRequest;
    const { model: resolvedModel, upstream, authErr } = resolveModelAndUpstream(
      request,
      route.upstream,
      req.model || "gpt-5.4-mini",
    );
    if (authErr) return authErrorResponse(authErr);
    req.model = resolvedModel;
    debugLog(`[${reqId}] POST /v1/chat/completions → ${upstream} (model=${resolvedModel})`);

    if (fmt === "anthropic") {
      const anthReq = formatOpenAIToAnthropic(req);
      const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
        method: "POST",
        headers: { ...anthropicHeaders(request, key!), "X-Request-Id": reqId },
        body: JSON.stringify(anthReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

      if (anthReq.stream) {
        return new Response(
          streamAnthropicToOpenAI(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            anthReq.model,
          ),
          { headers: SSE_HEADERS },
        );
      }
      return jsonResponse(
        toOpenAIResponse((await res.json()) as AnthropicResponse, anthReq.model),
      );
    }

    // Rewrite developer role for upstreams that don't support it
    for (const msg of req.messages || []) {
      if (msg.role === "developer") {
        msg.role = "system";
        debugLog(`[${reqId}] Rewriting developer role message to system for upstream compatibility`);
      }
    }

    const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
      method: "POST",
      headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
      body: JSON.stringify(req),
    });
    if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);
    return passthroughResponse(res);
  });
}

/** POST /v1/completions — Legacy completions → chat / Anthropic / passthrough */
async function handleV1Completions(
  reqId: string,
  request: Request,
  route: ReturnType<typeof routeConfig>,
  fmt: ReturnType<typeof upstreamFormat>,
  key: string | null,
): Promise<Response> {
  return wrapProxyRequest(reqId, async () => {
    const req = (await request.json()) as OpenAICompletionRequest;
    const { model: resolvedModel, upstream, authErr } = resolveModelAndUpstream(
      request,
      route.upstream,
      req.model || "gpt-5.4-mini",
    );
    if (authErr) return authErrorResponse(authErr);
    req.model = resolvedModel;
    debugLog(`[${reqId}] POST /v1/completions → ${upstream} (model=${resolvedModel})`);

    if (fmt === "openai") {
      const chatReq = formatOpenAICompletionToOpenAIChat(req);
      const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
        body: JSON.stringify(chatReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

      if (chatReq.stream) {
        return new Response(
          streamOpenAIChatToOpenAICompletion(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            req.model,
          ),
          { headers: SSE_HEADERS },
        );
      }
      return jsonResponse(
        formatOpenAIChatToOpenAICompletion(
          (await res.json()) as OpenAIResponse,
          req.model,
        ),
      );
    }

    if (fmt === "anthropic") {
      const anthReq = formatOpenAICompletionToAnthropic(req);
      const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
        method: "POST",
        headers: { ...anthropicHeaders(request, key!), "X-Request-Id": reqId },
        body: JSON.stringify(anthReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

      if (anthReq.stream) {
        return new Response(
          streamAnthropicToOpenAICompletion(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            anthReq.model,
          ),
          { headers: SSE_HEADERS },
        );
      }
      return jsonResponse(
        toOpenAICompletionResponse(
          (await res.json()) as AnthropicResponse,
          anthReq.model,
        ),
      );
    }

    // Completions passthrough
    const res = await fetchWithTimeout(`${upstream}/completions`, {
      method: "POST",
      headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
      body: JSON.stringify(req),
    });
    if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);
    return passthroughResponse(res);
  });
}

/** GET /v1/models or / — model discovery or root info */
async function handleModelsOrInfo(
  reqId: string,
  request: Request,
  route: ReturnType<typeof routeConfig>,
): Promise<Response> {
  const reqUrlPath = new URL(request.url).pathname;
  const isModelsPath =
    route.path === "/v1/models" ||
    route.path.startsWith("/v1/models/") ||
    reqUrlPath === "/models" ||
    reqUrlPath.startsWith("/models/");
  if (isModelsPath) {
    return handleModelsRequest(request, route);
  }

  return jsonResponse(
    {
      name: "pontis-proxy",
      version: pkg.version,
      request_id: reqId,
      endpoints: {
        "/v1/messages": "Anthropic → upstream (translated when upstream is OpenAI)",
        "/v1/chat/completions": "OpenAI Chat → upstream (translated when upstream is Anthropic)",
        "/v1/completions": "OpenAI Completions → upstream (translated when needed)",
        "/v1/responses": "OpenAI Responses → chat completions (Codex CLI)",
        "/v1/models": "Model discovery proxy",
      },
    },
    route.path === "/" ? 200 : 404,
  );
}

// ──────────────────────────────────────────────
//  Main request dispatch
// ──────────────────────────────────────────────

async function handleRequest(request: Request): Promise<Response> {
  const reqId = generateRequestId();
  const route = routeConfig(request);
  const fmt = upstreamFormat();
  const reqUrlPath = new URL(request.url).pathname;
  const key = extractApiKey(request.headers);

  // ── Anthropic messages ──
  if (route.path === "/v1/messages" && request.method === "POST") {
    return handleV1Messages(reqId, request, route, fmt, key);
  }

  // ── OpenAI chat completions ──
  if (matchesApiPath(route.path, reqUrlPath, "/chat/completions") && request.method === "POST") {
    return handleChatCompletions(reqId, request, route, fmt, key);
  }

  // ── OpenAI legacy completions ──
  if (route.path === "/v1/completions" && request.method === "POST") {
    return handleV1Completions(reqId, request, route, fmt, key);
  }

  // ── OpenAI Responses API (Codex CLI) ──
  if (matchesApiPath(route.path, reqUrlPath, "/responses") && request.method === "POST") {
    return handleResponsesRequest(request, route.upstream, reqId);
  }

  // ── GET: models or info ──
  if (request.method === "GET") {
    return handleModelsOrInfo(reqId, request, route);
  }

  // ── Unrecognised ──
  return jsonResponse(
    {
      name: "pontis-proxy",
      version: pkg.version,
      request_id: reqId,
      endpoints: {
        "/v1/messages": "Anthropic → upstream (translated when upstream is OpenAI)",
        "/v1/chat/completions": "OpenAI Chat → upstream (translated when upstream is Anthropic)",
        "/v1/completions": "OpenAI Completions → upstream (translated when needed)",
        "/v1/responses": "OpenAI Responses → chat completions (Codex CLI)",
        "/v1/models": "Model discovery proxy",
      },
    },
    route.path === "/" ? 200 : 404,
  );
}

// ──────────────────────────────────────────────
//  Hono app
// ──────────────────────────────────────────────

const app = new Hono();
app.use("*", logger());

// Security headers + CORS (H3, L1)
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta");
      }
    } catch {}
    if (c.req.method === "OPTIONS") return c.body(null, 204);
  }
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/install", (c) =>
  c.redirect("https://raw.githubusercontent.com/khrees/pontis/main/install.sh", 302),
);
app.all("*", (c) => handleRequest(c.req.raw));

export default app;
