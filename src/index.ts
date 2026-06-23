import { Hono } from "hono";
import { logger } from "hono/logger";
import { extractApiKey, validateApiKey, authErrorResponse } from "./auth";
import {
  getUpstream,
  matchesApiPath,
  resolveModel,
  routeConfig,
  selectUpstream,
  upstreamFormat,
  VISION_MODEL,
  GO_UPSTREAM,
  ZEN_UPSTREAM,
} from "./config";
import { handleModelsRequest } from "./handlers/models";
import { handleResponsesRequest } from "./handlers/responses";
import {
  anthropicHeaders,
  fetchWithTimeout,
  generateRequestId,
  jsonResponse,
  openaiAuthHeaders,
  proxyErrorResponse,
  SSE_HEADERS,
  upstreamErrorResponse,
} from "./http";
import { debugLog, warnLog } from "./logger";
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

function hasImages(body: AnthropicRequest): boolean {
  return (body.messages || []).some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((part) => part.type === "image"),
  );
}

function resolveOpenCodeModel(
  request: Request,
  routeUpstream: string,
  model: string,
  options: { vision?: AnthropicRequest } = {},
): { resolvedModel: string; upstream: string; authErr: ReturnType<typeof validateApiKey> } {
  const key = extractApiKey(request.headers);
  let resolvedModel = model;
  const baseUpstream = getUpstream(request, routeUpstream);

  if (baseUpstream.includes("opencode.ai")) {
    resolvedModel = resolveModel(resolvedModel);
    if (options.vision && hasImages(options.vision)) {
      resolvedModel = VISION_MODEL;
    }
  }

  const upstream = selectUpstream(request, routeUpstream, resolvedModel);
  const authErr = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
  return { resolvedModel, upstream, authErr };
}

async function handleRequest(request: Request): Promise<Response> {
  const reqId = generateRequestId();
  const route = routeConfig(request);
  const fmt = upstreamFormat(request);
  const reqUrlPath = new URL(request.url).pathname;
  const key = extractApiKey(request.headers);

  if (route.path === "/v1/messages" && request.method === "POST") {
    try {
      const req = (await request.json()) as AnthropicRequest;
      const originalModel = req.model;
      if (route.modelOverride) req.model = route.modelOverride;

      const { resolvedModel, upstream, authErr } = resolveOpenCodeModel(
        request,
        route.upstream,
        req.model,
        { vision: req },
      );
      if (authErr) return authErrorResponse(authErr);
      req.model = resolvedModel;
      debugLog(`[${reqId}] POST /v1/messages → ${upstream} (model=${resolvedModel})`);

      if (fmt === "openai") {
        const openaiReq = formatAnthropicToOpenAI(req);
        const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
          method: "POST",
          headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
          body: JSON.stringify(openaiReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

        if (openaiReq.stream) {
          return new Response(
            streamOpenAIToAnthropic(
              (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
              originalModel,
            ),
            { headers: SSE_HEADERS },
          );
        }
        return jsonResponse(
          toAnthropicResponse((await res.json()) as OpenAIResponse, originalModel),
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

      const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
        method: "POST",
        headers: { ...anthropicHeaders(request, key!), "X-Request-Id": reqId },
        body: JSON.stringify(req),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);
      return new Response(await res.text(), {
        status: res.status,
        headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        warnLog(`[${reqId}] Upstream request timed out`);
        return proxyErrorResponse("upstream_timeout", "Upstream did not respond in time", { requestId: reqId });
      }
      warnLog(`[${reqId}] Request failed: ${err instanceof Error ? err.message : String(err)}`);
      return proxyErrorResponse("proxy_error", err instanceof Error ? err.message : String(err), { requestId: reqId });
    }
  }

  if (
    matchesApiPath(route.path, reqUrlPath, "/chat/completions") &&
    request.method === "POST"
  ) {
    try {
      const req = (await request.json()) as OpenAIRequest;
      const { resolvedModel, upstream, authErr } = resolveOpenCodeModel(
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

      for (const msg of req.messages || []) {
        if (msg.role === "developer") msg.role = "system";
      }

      const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
        body: JSON.stringify(req),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);
      return new Response(await res.text(), {
        status: res.status,
        headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        warnLog(`[${reqId}] Upstream request timed out`);
        return proxyErrorResponse("upstream_timeout", "Upstream did not respond in time", { requestId: reqId });
      }
      warnLog(`[${reqId}] Request failed: ${err instanceof Error ? err.message : String(err)}`);
      return proxyErrorResponse("proxy_error", err instanceof Error ? err.message : String(err), { requestId: reqId });
    }
  }

  if (route.path === "/v1/completions" && request.method === "POST") {
    try {
      const req = (await request.json()) as OpenAICompletionRequest;
      const { resolvedModel, upstream, authErr } = resolveOpenCodeModel(
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

      const res = await fetchWithTimeout(`${upstream}/completions`, {
        method: "POST",
        headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
        body: JSON.stringify(req),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);
      return new Response(await res.text(), {
        status: res.status,
        headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        warnLog(`[${reqId}] Upstream request timed out`);
        return proxyErrorResponse("upstream_timeout", "Upstream did not respond in time", { requestId: reqId });
      }
      warnLog(`[${reqId}] Request failed: ${err instanceof Error ? err.message : String(err)}`);
      return proxyErrorResponse("proxy_error", err instanceof Error ? err.message : String(err), { requestId: reqId });
    }
  }

  if (
    matchesApiPath(route.path, reqUrlPath, "/responses") &&
    request.method === "POST"
  ) {
    return handleResponsesRequest(request, route.upstream, reqId);
  }

  if (request.method === "GET") {
    const isModelsPath =
      route.path === "/v1/models" ||
      route.path.startsWith("/v1/models/") ||
      reqUrlPath === "/models" ||
      reqUrlPath.startsWith("/models/");
    if (isModelsPath) {
      return handleModelsRequest(request, route);
    }
  }

  const upstream = getUpstream(request, route.upstream);
  return jsonResponse(
    {
      name: "pontis-proxy",
      version: "1.0.0",
      upstream,
      request_id: reqId,
      routes: { "/go": GO_UPSTREAM, "/zen": ZEN_UPSTREAM },
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

const app = new Hono();
app.use("*", logger());
app.get("/install", (c) =>
  c.redirect("https://raw.githubusercontent.com/khrees/pontis/main/install.sh", 302),
);
app.all("*", (c) => handleRequest(c.req.raw));

export default app;
