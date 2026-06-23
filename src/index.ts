import { Hono } from "hono";
import { logger } from "hono/logger";
import { extractApiKey, validateApiKey, authErrorResponse } from "./auth";
import { formatAnthropicToOpenAI } from "./translate/request/anthropic-to-openai";
import { formatOpenAIToAnthropic } from "./translate/request/openai-to-anthropic";
import { formatOpenAIToAnthropic as toAnthropicResponse } from "./translate/response/openai-to-anthropic";
import { formatAnthropicToOpenAI as toOpenAIResponse } from "./translate/response/anthropic-to-openai";
import { streamOpenAIToAnthropic } from "./translate/stream/openai-to-anthropic";
import { streamAnthropicToOpenAI } from "./translate/stream/anthropic-to-openai";
import { streamChatToResponses } from "./translate/stream/chat-to-responses";
import { responsesToChatMessages, buildChatRequest, chatResponseToOutput, extractUsage } from "./translate/request/responses-to-chat";
import { buildCodexModelEntry, KNOWN_MODEL_METADATA } from "./model-metadata";
import { responseCache } from "./responses-cache";

declare const process: any;

// Import completion translators from consolidated module
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

import {
  AnthropicRequest,
  OpenAIRequest,
  OpenAIResponse,
  AnthropicResponse,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
} from "./types";

const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = GO_UPSTREAM;
const VISION_MODEL = "qwen3.6-plus";
function getDefaultFreeModel(): string {
  return (
    (typeof process !== "undefined" && process.env.PONTIS_MODEL) ||
    "mimo-v2.5-free"
  );
}

// Known OpenCode model prefixes — anything NOT matching these gets remapped
const KNOWN_OPENCODE_PREFIXES = [
  "mimo",
  "deepseek",
  "big-pickle",
  "nemotron",
  "qwen",
  "llama",
  "mistral",
  "gemma",
  "phi",
  "starcoder",
  "codestral",
  "command",
  "minimax",
  "north",
];

function resolveModel(model: string): string {
  const defaultFreeModel = getDefaultFreeModel();
  if (!model) return defaultFreeModel;
  const lower = model.toLowerCase();

  // Map known OpenCode paid/pro models to their free counterparts
  if (lower === "deepseek-v4-flash") {
    return "deepseek-v4-flash-free";
  }
  if (lower === "mimo-v2.5") {
    return "mimo-v2.5-free";
  }
  if (lower === "nemotron-3-ultra") {
    return "nemotron-3-ultra-free";
  }
  if (lower === "north-mini-code") {
    return "north-mini-code-free";
  }

  // Handle general family prefixes for free tiers
  if (lower.startsWith("deepseek") && !lower.endsWith("-free")) {
    return "deepseek-v4-flash-free";
  }
  if (lower.startsWith("mimo") && !lower.endsWith("-free")) {
    return "mimo-v2.5-free";
  }
  if (lower.startsWith("nemotron") && !lower.endsWith("-free")) {
    return "nemotron-3-ultra-free";
  }
  if (lower.startsWith("north") && !lower.endsWith("-free")) {
    return "north-mini-code-free";
  }

  // If it matches a known OpenCode model prefix, keep it as-is
  if (KNOWN_OPENCODE_PREFIXES.some((p) => lower.startsWith(p))) return model;
  // If it looks like a Claude/Anthropic or GPT model name, remap to default
  if (
    lower.includes("claude") ||
    lower.includes("haiku") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.includes("gpt")
  ) {
    console.log(
      `[proxy] Remapping unsupported model "${model}" → "${defaultFreeModel}"`,
    );
    return defaultFreeModel;
  }
  // Unknown model — let it pass through (OpenCode will validate)
  return model;
}

const API_START_PATHS = new Set(["v1", "v2"]);

type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
};

function stripPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

function extractModelSegment(path: string): {
  path: string;
  model: string | null;
} {
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.length > 0 && segments[0] && !API_START_PATHS.has(segments[0])) {
    return { path: "/" + segments.slice(1).join("/"), model: segments[0] };
  }
  return { path, model: null };
}

function routeConfig(request: Request): RouteConfig {
  const path = new URL(request.url).pathname;
  const goPath = stripPrefix(path, "/go");
  if (goPath) {
    const { path: remaining, model } = extractModelSegment(goPath);
    return { path: remaining, upstream: GO_UPSTREAM, modelOverride: model };
  }

  const zenPath = stripPrefix(path, "/zen");
  if (zenPath) {
    const { path: remaining, model } = extractModelSegment(zenPath);
    return { path: remaining, upstream: ZEN_UPSTREAM, modelOverride: model };
  }

  const { path: remaining, model } = extractModelSegment(path);
  return { path: remaining, upstream: DEFAULT_UPSTREAM, modelOverride: model };
}

function getUpstream(request: Request, routeUpstream: string): string {
  const envUpstream =
    typeof process !== "undefined"
      ? process.env.PONTIS_UPSTREAM_URL
      : undefined;
  return request.headers.get("X-Upstream-Url") || envUpstream || routeUpstream;
}

function upstreamFormat(
  request: Request,
): "openai" | "anthropic" | "openai-completions" {
  const envFormat =
    typeof process !== "undefined"
      ? process.env.PONTIS_UPSTREAM_FORMAT
      : undefined;
  const fmt = (
    request.headers.get("X-Upstream-Format") ||
    envFormat ||
    "openai"
  ).toLowerCase();
  if (
    fmt === "openai-completions" ||
    fmt === "openai-codex" ||
    fmt === "codex"
  ) {
    return "openai-completions";
  }
  return fmt === "anthropic" ? "anthropic" : "openai";
}

function anthropicHeaders(
  request: Request,
  key: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version":
      request.headers.get("Anthropic-Version") || "2023-06-01",
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

function hasImages(body: AnthropicRequest): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((part) => part.type === "image"),
  );
}

function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of [
    "Content-Type",
    "Retry-After",
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
  ]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

function selectUpstream(
  request: Request,
  routeUpstream: string,
  model: string,
): string {
  const envUpstream =
    typeof process !== "undefined"
      ? process.env.PONTIS_UPSTREAM_URL
      : undefined;
  const targetUpstream = request.headers.get("X-Upstream-Url") || envUpstream;
  if (targetUpstream) return targetUpstream;

  const path = new URL(request.url).pathname;
  const hasExplicitPrefix = path.startsWith("/go") || path.startsWith("/zen");
  if (!hasExplicitPrefix && routeUpstream.includes("opencode.ai")) {
    const isFree = model.endsWith("-free") || model === "big-pickle";
    return isFree ? ZEN_UPSTREAM : GO_UPSTREAM;
  }
  return routeUpstream;
}

async function handleRequest(request: Request): Promise<Response> {
  const route = routeConfig(request);
  const fmt = upstreamFormat(request);
  const reqUrlPath = new URL(request.url).pathname;

  const headersObj: Record<string, string> = {};
  request.headers.forEach((val, key) => {
    headersObj[key] = val;
  });
  console.log(`[proxy] Incoming headers: ${JSON.stringify(headersObj)}`);

  // Anthropic → OpenAI (for Claude Desktop/Cowork → any OpenAI API)
  if (route.path === "/v1/messages" && request.method === "POST") {
    const key = extractApiKey(request.headers);
    const req = (await request.json()) as AnthropicRequest;
    const originalModel = req.model;
    if (route.modelOverride) req.model = route.modelOverride;

    let resolvedModel = req.model;
    const baseUpstream = getUpstream(request, route.upstream);
    if (baseUpstream.includes("opencode.ai")) {
      resolvedModel = resolveModel(req.model);
      if (hasImages(req)) {
        resolvedModel = VISION_MODEL;
      }
    }
    req.model = resolvedModel;

    const dynamicUpstream = selectUpstream(
      request,
      route.upstream,
      resolvedModel,
    );
    const err = dynamicUpstream.includes("opencode.ai")
      ? validateApiKey(key)
      : null;
    if (err) return authErrorResponse(err);

    console.log(
      `[proxy] Incoming: ${request.method} ${request.url} | route.path: ${route.path} | fmt: ${fmt} | upstream: ${dynamicUpstream} | model: ${resolvedModel}`,
    );

    if (fmt === "openai") {
      const openaiReq = formatAnthropicToOpenAI(req);
      if (openaiReq.tools) {
        console.log(`[proxy] Translated ${openaiReq.tools.length} tool(s)`, JSON.stringify(openaiReq.tools.map(t => ({ type: t.type, hasFn: !!t.function, fnName: t.function?.name }))));
      }
      const upstreamUrl = `${dynamicUpstream}/chat/completions`;
      const res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(openaiReq),
      });
      if (!res.ok) {
        const errorBody = await res.text();
        console.log(
          `[proxy] Upstream error: ${res.status} from ${upstreamUrl}`,
        );
        console.log(`[proxy] Model: ${req.model} (original: ${originalModel})`);
        console.log(`[proxy] Tools: ${openaiReq.tools?.length || 0}`);
        console.log(`[proxy] Response: ${errorBody.slice(0, 500)}`);
        return upstreamErrorResponse(res, errorBody);
      }

      if (openaiReq.stream) {
        return new Response(
          streamOpenAIToAnthropic(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            originalModel,
          ),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      }
      const data = (await res.json()) as OpenAIResponse;
      return new Response(
        JSON.stringify(toAnthropicResponse(data, originalModel)),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (fmt === "openai-completions") {
      const completionReq = formatAnthropicToOpenAICompletion(req);
      const upstreamUrl = `${dynamicUpstream}/completions`;
      const res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(completionReq),
      });
      if (!res.ok) {
        const errorBody = await res.text();
        return upstreamErrorResponse(res, errorBody);
      }

      if (completionReq.stream) {
        return new Response(
          streamOpenAICompletionToAnthropic(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            originalModel,
          ),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      }
      const data = (await res.json()) as OpenAICompletionResponse;
      return new Response(
        JSON.stringify(toAnthropicResponseFromCompletion(data, originalModel)),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Pass-through to Anthropic upstream
    const res = await fetch(`${dynamicUpstream}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(request, key!),
      body: JSON.stringify(req),
    });
    return res;
  }

  // OpenAI Chat Completions → Anthropic (or pass-through)
  if ((route.path === "/v1/chat/completions" || reqUrlPath === "/chat/completions" || reqUrlPath === "/v1/chat/completions") && request.method === "POST") {
    const key = extractApiKey(request.headers);
    const req = (await request.json()) as OpenAIRequest;
    const originalModel = req.model || "gpt-5.4-mini";

    let resolvedModel = originalModel;
    const baseUpstream = getUpstream(request, route.upstream);
    if (baseUpstream.includes("opencode.ai")) {
      resolvedModel = resolveModel(resolvedModel);
    }
    req.model = resolvedModel;

    const dynamicUpstream = selectUpstream(
      request,
      route.upstream,
      resolvedModel,
    );
    const err = dynamicUpstream.includes("opencode.ai")
      ? validateApiKey(key)
      : null;
    if (err) return authErrorResponse(err);

    console.log(
      `[proxy] Incoming: ${request.method} ${request.url} | route.path: ${route.path} | fmt: ${fmt} | upstream: ${dynamicUpstream} | model: ${resolvedModel}`,
    );

    if (fmt === "anthropic") {
      const anthReq = formatOpenAIToAnthropic(req);
      const res = await fetch(`${dynamicUpstream}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(request, key!),
        body: JSON.stringify(anthReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());

      if (anthReq.stream) {
        return new Response(
          streamAnthropicToOpenAI(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            anthReq.model,
          ),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      }
      const data = (await res.json()) as AnthropicResponse;
      return new Response(
        JSON.stringify(toOpenAIResponse(data, anthReq.model)),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Normalize developer role to system for OpenAI-compatible upstreams
    if (Array.isArray(req.messages)) {
      for (const msg of req.messages) {
        if (msg.role === "developer") {
          msg.role = "system";
        }
      }
    }

    // Pass-through to OpenAI upstream
    const res = await fetch(`${dynamicUpstream}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(req),
    });
    return res;
  }

  // OpenAI Legacy Completions → Anthropic OR Chat API (or pass-through)
  if (route.path === "/v1/completions" && request.method === "POST") {
    const key = extractApiKey(request.headers);
    const req = (await request.json()) as OpenAICompletionRequest;
    const originalModel = req.model || "gpt-5.4-mini";

    let resolvedModel = originalModel;
    const baseUpstream = getUpstream(request, route.upstream);
    if (baseUpstream.includes("opencode.ai")) {
      resolvedModel = resolveModel(resolvedModel);
    }
    req.model = resolvedModel;

    const dynamicUpstream = selectUpstream(
      request,
      route.upstream,
      resolvedModel,
    );
    const err = dynamicUpstream.includes("opencode.ai")
      ? validateApiKey(key)
      : null;
    if (err) return authErrorResponse(err);

    console.log(
      `[proxy] Incoming: ${request.method} ${request.url} | route.path: ${route.path} | fmt: ${fmt} | upstream: ${dynamicUpstream} | model: ${resolvedModel}`,
    );

    // Translate legacy completions to modern chat completions (for OpenCode / standard OpenAI endpoint)
    if (fmt === "openai") {
      const chatReq = formatOpenAICompletionToOpenAIChat(req);
      const upstreamUrl = `${dynamicUpstream}/chat/completions`;
      const res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(chatReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());

      if (chatReq.stream) {
        return new Response(
          streamOpenAIChatToOpenAICompletion(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            req.model,
          ),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      }
      const data = (await res.json()) as OpenAIResponse;
      return new Response(
        JSON.stringify(formatOpenAIChatToOpenAICompletion(data, req.model)),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (fmt === "anthropic") {
      const anthReq = formatOpenAICompletionToAnthropic(req);
      const res = await fetch(`${dynamicUpstream}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(request, key!),
        body: JSON.stringify(anthReq),
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());

      if (anthReq.stream) {
        return new Response(
          streamAnthropicToOpenAICompletion(
            (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
            anthReq.model,
          ),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      }
      const data = (await res.json()) as AnthropicResponse;
      return new Response(
        JSON.stringify(toOpenAICompletionResponse(data, anthReq.model)),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Pass-through to OpenAI completions upstream
    const res = await fetch(`${dynamicUpstream}/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(req),
    });
    return res;
  }

  // OpenAI Responses API (used by Codex CLI)
  if ((route.path === "/v1/responses" || reqUrlPath === "/responses" || reqUrlPath === "/v1/responses") && request.method === "POST") {
    const key = extractApiKey(request.headers);
    const req = (await request.json()) as any;
    const originalModel = req.model || "gpt-5.4-mini";

    let resolvedModel = originalModel;
    const baseUpstream = getUpstream(request, route.upstream);
    if (baseUpstream.includes("opencode.ai")) {
      resolvedModel = resolveModel(resolvedModel);
    }
    req.model = resolvedModel;

    const dynamicUpstream = selectUpstream(
      request,
      route.upstream,
      resolvedModel,
    );
    const err = dynamicUpstream.includes("opencode.ai")
      ? validateApiKey(key)
      : null;
    if (err) return authErrorResponse(err);

    console.log(
      `[proxy] Incoming: ${request.method} ${request.url} | route.path: ${route.path} | fmt: ${fmt} | upstream: ${dynamicUpstream} | model: ${resolvedModel}`,
    );
    if (req.previous_response_id) {
      console.log('[proxy] Responses API: previous_response_id received:', req.previous_response_id);
    }

    // Convert Responses API request to Chat Completions format
    const cachedPrevious = req.previous_response_id
      ? responseCache.get(req.previous_response_id)
      : undefined;

    if (cachedPrevious) {
      console.log(`[proxy] Responses API: reconstructed ${cachedPrevious.fullMessages.length} cached messages for previous_response_id=${req.previous_response_id}`);
    } else if (req.previous_response_id) {
      console.log(`[proxy] Responses API: WARNING — unknown previous_response_id=${req.previous_response_id}, conversation context lost`);
    }

    const { messages, dsmlFallbackActive } = responsesToChatMessages(
      req,
      resolvedModel,
      cachedPrevious?.fullMessages as any[],
    );

    const acceptHeader = request.headers.get("Accept") || "";
    const isEventStream = acceptHeader.includes("text/event-stream");
    const shouldStream = req.stream !== undefined ? req.stream : isEventStream;

    const chatReq = buildChatRequest(req, req.model, messages);
    chatReq.stream = shouldStream;
    if (shouldStream) chatReq.stream_options = { include_usage: true };
    // Re-apply streaming after buildChatRequest since it reads req.stream
    // but we want the Accept header logic too
    if (!shouldStream) delete chatReq.stream_options;

    if (dsmlFallbackActive) {
      console.log(`[proxy] Responses API: injected DSML fallback prompt for ${resolvedModel}`);
    }

    const inputItemCount = Array.isArray(req.input) ? req.input.length : 0;
    console.log(
      `[proxy] Responses → Chat: ${inputItemCount} input items → ${chatReq.messages?.length || 0} messages, ${chatReq.tools?.length || 0} tools, stream=${chatReq.stream}`,
      chatReq.tools ? `tools: ${JSON.stringify(chatReq.tools.map((t: any) => ({ name: t.function?.name })))}` : "",
    );
    if (inputItemCount > 0 && (chatReq.messages?.length || 0) < inputItemCount / 2) {
      const types = req.input.map((item: any) => item.type || item.role || "?");
      console.log(`[proxy] WARNING — possible input conversion loss. Input types: ${types.join(", ")}`);
    }

    const upstreamUrl = `${dynamicUpstream}/chat/completions`;
    const res = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(chatReq),
    });

    if (!res.ok) return upstreamErrorResponse(res, await res.text());

    // Generate response ID so we can cache conversation state for the next turn
    const responseId = "resp_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);

    if (chatReq.stream) {
      responseCache.set(responseId, {
        responseId,
        model: resolvedModel,
        originalModel,
        fullMessages: chatReq.messages,
        usage: {},
      });

      return new Response(
        streamChatToResponses(
          (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
          originalModel,
          req.previous_response_id,
          responseId,
          (completeEvt) => {
            // Reconstruct assistant message from streamed output items
            const assistantMsg: any = { role: "assistant" };
            const textParts: string[] = [];
            const toolCalls: any[] = [];
            for (const item of completeEvt.output || []) {
              if (item.type === "message") {
                const text = item.content?.find((c: any) => c.type === "text")?.text || "";
                if (text) textParts.push(text);
              } else if (item.type === "function_call") {
                toolCalls.push({
                  id: item.call_id,
                  type: "function",
                  function: { name: item.name, arguments: item.arguments },
                });
              }
            }
            if (textParts.length > 0) assistantMsg.content = textParts.join("\n");
            if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
            const cachedMessages = [...chatReq.messages, assistantMsg];

            responseCache.set(responseId, {
              responseId,
              model: resolvedModel,
              originalModel,
              fullMessages: cachedMessages,
              usage: completeEvt.usage,
            });
          },
        ),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    }

    const chatRes = (await res.json()) as any;
    const message = chatRes.choices?.[0]?.message || {};
    const { output } = chatResponseToOutput(message);
    const usage = extractUsage(chatRes);

    // Append assistant response to the cached messages so the next turn
    // sees the full conversation history (user → assistant → user → ...)
    const assistantMsg: any = { role: "assistant" };
    if (typeof message.content === "string") assistantMsg.content = message.content;
    if (message.tool_calls && message.tool_calls.length > 0) {
      assistantMsg.tool_calls = message.tool_calls;
    }
    const cachedMessages = [...chatReq.messages, assistantMsg];

    responseCache.set(responseId, {
      responseId,
      model: resolvedModel,
      originalModel,
      fullMessages: cachedMessages,
      usage,
    });

    const responsePayload = {
      id: responseId,
      object: "response",
      model: originalModel,
      ...(req.previous_response_id ? { previous_response_id: req.previous_response_id } : {}),
      status: "completed",
      usage,
      output,
    };

    return new Response(JSON.stringify(responsePayload), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Model discovery
  if (request.method === "GET") {
    const reqUrl = new URL(request.url);
    const isModelsPath = route.path === "/v1/models" || route.path.startsWith("/v1/models/") || reqUrl.pathname === "/models" || reqUrl.pathname.startsWith("/models/");
    if (isModelsPath) {
    const key = extractApiKey(request.headers);
    const upstream = getUpstream(request, route.upstream);
    const err = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
    if (err) return authErrorResponse(err);

    const res =
      fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key!),
          })
        : await fetch(`${upstream}/models`, {
            method: "GET",
            headers: {
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
          });
    if (!res.ok) return upstreamErrorResponse(res, await res.text());

    const url = reqUrl;
    const isCodex =
      url.searchParams.has("client_version") ||
      (request.headers.get("user-agent") || "").toLowerCase().includes("codex") ||
      (request.headers.get("user-agent") || "").toLowerCase().includes("openai") ||
      typeof process !== "undefined" && process.env.PONTIS_CODEX_MODE === "true";

    if (isCodex) {
      const data = (await res.json()) as any;
      const rawModels = (data.data || []).filter((m: any) =>
        m.id === "big-pickle" || (m.id.endsWith("-free") && m.id !== "minimax-m3-free")
      );
      
      // Ensure all known models are present so Codex CLI can cache metadata
      // (missing entries cause fallback defaults with aggressive ~10KB truncation).
      for (const id of Object.keys(KNOWN_MODEL_METADATA)) {
        if (!rawModels.some((m: any) => m.id === id)) {
          rawModels.push({ id });
        }
      }

      // Ensure the default free model is in rawModels if not already present
      const defaultModel = getDefaultFreeModel();
      if (defaultModel && !rawModels.some((m: any) => m.id === defaultModel)) {
        rawModels.push({ id: defaultModel });
      }

      const models = rawModels.map((m: any) => buildCodexModelEntry(m.id));

      if (route.path.startsWith("/v1/models/")) {
        const parts = route.path.split("/");
        const modelId = parts[parts.length - 1];
        const matched = models.find((m: any) => m.slug === modelId);
        if (matched) {
          return new Response(JSON.stringify(matched), {
            headers: { "Content-Type": "application/json" },
          });
        }
        const fallbackModel = buildCodexModelEntry(modelId);
        return new Response(JSON.stringify(fallbackModel), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ models }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const bodyText = await res.text();
    return new Response(bodyText, {
      headers: { "Content-Type": "application/json" },
    });
    }
  }

  const upstream = getUpstream(request, route.upstream);
  return new Response(
    JSON.stringify(
      {
        name: "pontis-proxy",
        upstream,
        routes: {
          "/go": GO_UPSTREAM,
          "/zen": ZEN_UPSTREAM,
        },
        endpoints: {
          "/v1/messages":
            "Anthropic → upstream (translated if upstream=openai or openai-completions)",
          "/v1/chat/completions":
            "OpenAI Chat → upstream (translated if upstream=anthropic)",
          "/v1/completions":
            "OpenAI Completions/Codex → upstream (translated if upstream=anthropic or openai)",
          "/v1/models": "Model discovery proxy",
        },
      },
      null,
      2,
    ),
    {
      headers: { "Content-Type": "application/json" },
      status: route.path === "/" ? 200 : 404,
    },
  );
}

const app = new Hono();
app.use("*", logger());

app.get("/install", (c) => {
  return c.redirect(
    "https://raw.githubusercontent.com/khrees/pontis/main/install.sh",
    302,
  );
});

app.all("*", (c) => handleRequest(c.req.raw));

export default app;
