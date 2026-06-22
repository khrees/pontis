import { Hono } from "hono";
import { logger } from "hono/logger";
import { extractApiKey, validateApiKey, authErrorResponse } from "./auth";
import { formatAnthropicToOpenAI } from "./translate/request/anthropic-to-openai";
import { formatOpenAIToAnthropic } from "./translate/request/openai-to-anthropic";
import { formatOpenAIToAnthropic as toAnthropicResponse } from "./translate/response/openai-to-anthropic";
import { formatAnthropicToOpenAI as toOpenAIResponse } from "./translate/response/anthropic-to-openai";
import { streamOpenAIToAnthropic } from "./translate/stream/openai-to-anthropic";
import { streamChatToResponses } from "./translate/stream/chat-to-responses";

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
  if (route.path === "/v1/chat/completions" && request.method === "POST") {
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
  if (route.path === "/v1/responses" && request.method === "POST") {
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

    // Convert input/instructions to standard OpenAI chat completion messages
    const messages: any[] = [];
    if (req.instructions) {
      messages.push({ role: "system", content: req.instructions });
    }
    if (Array.isArray(req.input)) {
      for (const inputItem of req.input) {
        let role = inputItem.role || "user";
        if (role === "developer") role = "system";

        const contentParts = Array.isArray(inputItem.content) ? inputItem.content : [];
        const textParts: string[] = [];
        const toolResults: { tool_use_id: string; content: string }[] = [];
        const toolUses: { id: string; name: string; arguments: string }[] = [];

        if (typeof inputItem.content === "string") {
          textParts.push(inputItem.content);
        } else if (contentParts.length > 0) {
          for (const part of contentParts) {
            if (part.type === "input_text" || part.type === "text") {
              textParts.push(part.text || "");
            } else if (part.type === "tool_use") {
              toolUses.push({
                id: part.id || "",
                name: part.name || "",
                arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input || {}),
              });
            } else if (part.type === "tool_result") {
              const resultContent = typeof part.content === "string"
                ? part.content
                : Array.isArray(part.content)
                  ? part.content.map((c: any) => c.text || "").join("\n")
                  : JSON.stringify(part.content || "");
              toolResults.push({ tool_use_id: part.tool_use_id || "", content: resultContent });
            }
          }
        }

        if (role === "assistant") {
          const msg: any = {};
          msg.role = "assistant";
          msg.content = textParts.length > 0 ? textParts.join("\n").trim() || null : null;
          if (toolUses.length > 0) {
            msg.tool_calls = toolUses.map((tu) => ({
              id: tu.id,
              type: "function",
              function: { name: tu.name, arguments: tu.arguments },
            }));
          }
          if (msg.content !== null || (msg.tool_calls && msg.tool_calls.length > 0)) {
            messages.push(msg);
          }
        } else if (role === "user") {
          // Flush text as a user message
          const text = textParts.join("\n").trim();
          if (text) {
            messages.push({ role: "user", content: text });
          }
          // Flush tool_results as tool role messages
          for (const tr of toolResults) {
            messages.push({ role: "tool", content: tr.content, tool_call_id: tr.tool_use_id });
          }
        } else {
          // tool, system, or other role — preserve as-is with text content
          const text = textParts.join("\n").trim();
          messages.push({ role, content: text || "" });
        }
      }
    }

    const acceptHeader = request.headers.get("Accept") || "";
    const isEventStream = acceptHeader.includes("text/event-stream");
    const shouldStream = req.stream !== undefined ? req.stream : isEventStream;

    const chatReq: any = {
      model: req.model,
      messages,
      stream: shouldStream,
    };
    // Convert Responses API tools → Chat Completions tools
    // Responses API format:  { type: "function", name, description, parameters }
    // Chat Completions format: { type: "function", function: { name, description, parameters } }
    if (Array.isArray(req.tools)) {
      const converted = req.tools
        .filter((t: any) => t && t.type === "function")
        .map((t: any) => ({
          type: "function",
          function: {
            name: t.name || t.function?.name || "",
            description: t.description || t.function?.description,
            parameters: t.parameters || t.function?.parameters,
          },
        }));
      if (converted.length > 0) {
        chatReq.tools = converted;
      }
    }
    console.log(
      `[proxy] Responses → Chat: ${chatReq.messages?.length || 0} messages, ${chatReq.tools?.length || 0} tools, stream=${chatReq.stream}`,
      chatReq.tools ? `tools: ${JSON.stringify(chatReq.tools.map((t: any) => ({ name: t.function?.name })))}` : "",
    );
    if (req.max_tokens !== undefined) chatReq.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) chatReq.temperature = req.temperature;

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
        streamChatToResponses(
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

    const chatRes = (await res.json()) as any;
    const message = chatRes.choices?.[0]?.message || {};
    const output: any[] = [];

    // Add text message output if there's content
    const textContent = message.content || "";
    if (textContent) {
      output.push({
        id: "out_" + Date.now(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: textContent }],
      });
    }

    // Add function_call outputs for any tool calls
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const callId = tc.id || `call_${Date.now()}`;
        const argsStr = typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}";
        output.push({
          id: `item_${callId}`,
          type: "function_call",
          name: tc.function?.name || "",
          call_id: callId,
          arguments: argsStr,
          status: "completed",
        });
      }
    }

    // Fallback: if output is empty, send a minimal text response
    if (output.length === 0) {
      output.push({
        id: "out_" + Date.now(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "" }],
      });
    }

    const responsePayload = {
      id: chatRes.id || "resp_" + Date.now(),
      object: "response",
      model: originalModel,
      status: "completed",
      usage: chatRes.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      output,
    };

    return new Response(JSON.stringify(responsePayload), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Model discovery
  if ((route.path === "/v1/models" || route.path.startsWith("/v1/models/")) && request.method === "GET") {
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

    const url = new URL(request.url);
    const isCodex =
      url.searchParams.has("client_version") ||
      (request.headers.get("user-agent") || "").toLowerCase().includes("codex");

    if (isCodex) {
      const data = (await res.json()) as any;
      const rawModels = (data.data || []).filter((m: any) =>
        m.id === "big-pickle" || (m.id.endsWith("-free") && m.id !== "minimax-m3-free")
      );
      const models = rawModels.map((m: any) => ({
        slug: m.id,
        display_name: m.id,
        description: `${m.id} model via Pontis`,
        supported_in_api: true,
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          {
            effort: "low",
            description: "Fast responses with lighter reasoning",
          },
          {
            effort: "medium",
            description: "Balances speed and reasoning depth",
          },
          { effort: "high", description: "Greater reasoning depth" },
        ],
        shell_type: "shell_command",
        priority: 1,
        base_instructions: "",
        supports_reasoning_summaries: false,
        support_verbosity: false,
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        truncation_policy: {
          mode: "tokens",
          limit: 128000,
        },
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        context_window: 128000,
        max_context_window: 128000,
      }));

      if (route.path.startsWith("/v1/models/")) {
        const parts = route.path.split("/");
        const modelId = parts[parts.length - 1];
        const matched = models.find((m: any) => m.slug === modelId);
        if (matched) {
          return new Response(JSON.stringify(matched), {
            headers: { "Content-Type": "application/json" },
          });
        }
        const fallbackModel = {
          slug: modelId,
          display_name: modelId,
          description: `${modelId} model via Pontis`,
          supported_in_api: true,
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            {
              effort: "low",
              description: "Fast responses with lighter reasoning",
            },
            {
              effort: "medium",
              description: "Balances speed and reasoning depth",
            },
            { effort: "high", description: "Greater reasoning depth" },
          ],
          shell_type: "shell_command",
          priority: 1,
          base_instructions: "",
          supports_reasoning_summaries: false,
          support_verbosity: false,
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text",
          truncation_policy: {
            mode: "tokens",
            limit: 128000,
          },
          supports_parallel_tool_calls: true,
          experimental_supported_tools: [],
          context_window: 128000,
          max_context_window: 128000,
        };
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
