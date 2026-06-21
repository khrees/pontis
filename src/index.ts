import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';

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
  streamOpenAICompletionToAnthropic
} from './translate/completions';

import {
  AnthropicRequest,
  OpenAIRequest,
  OpenAIResponse,
  AnthropicResponse,
  OpenAICompletionRequest,
  OpenAICompletionResponse
} from './types';

const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = GO_UPSTREAM;
const VISION_MODEL = "qwen3.6-plus";
const DEFAULT_FREE_MODEL = "mimo-v2.5-free";

// Known OpenCode model prefixes — anything NOT matching these gets remapped
const KNOWN_OPENCODE_PREFIXES = [
  "mimo", "deepseek", "big-pickle", "nemotron", "qwen", "llama",
  "mistral", "gemma", "phi", "starcoder", "codestral", "command",
  "minimax", "north",
];

function resolveModel(model: string): string {
  if (!model) return DEFAULT_FREE_MODEL;
  const lower = model.toLowerCase();
  // If it matches a known OpenCode model prefix, keep it as-is
  if (KNOWN_OPENCODE_PREFIXES.some(p => lower.startsWith(p))) return model;
  // If it looks like a Claude/Anthropic model name, remap to default
  if (lower.includes("claude") || lower.includes("haiku") || lower.includes("sonnet") || lower.includes("opus")) {
    console.log(`[proxy] Remapping unsupported model "${model}" → "${DEFAULT_FREE_MODEL}"`);
    return DEFAULT_FREE_MODEL;
  }
  // Unknown model — let it pass through (OpenCode will validate)
  return model;
}

const API_START_PATHS = new Set(['v1', 'v2']);

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

function extractModelSegment(path: string): { path: string; model: string | null } {
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.length > 0 && segments[0] && !API_START_PATHS.has(segments[0])) {
    return { path: '/' + segments.slice(1).join('/'), model: segments[0] };
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
  const envUpstream = typeof process !== 'undefined' ? process.env.PONTIS_UPSTREAM_URL : undefined;
  return request.headers.get("X-Upstream-Url") || envUpstream || routeUpstream;
}

function upstreamFormat(request: Request): "openai" | "anthropic" | "openai-completions" {
  const envFormat = typeof process !== 'undefined' ? process.env.PONTIS_UPSTREAM_FORMAT : undefined;
  const fmt = (request.headers.get("X-Upstream-Format") || envFormat || "openai").toLowerCase();
  if (fmt === "openai-completions" || fmt === "openai-codex" || fmt === "codex") {
    return "openai-completions";
  }
  return fmt === "anthropic" ? "anthropic" : "openai";
}

function anthropicHeaders(request: Request, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version": request.headers.get("Anthropic-Version") || "2023-06-01",
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

function hasImages(body: AnthropicRequest): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) =>
    Array.isArray(msg.content) && msg.content.some((part) => part.type === "image")
  );
}

function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of ["Content-Type", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

async function handleRequest(request: Request): Promise<Response> {
  const route = routeConfig(request);
  const upstream = getUpstream(request, route.upstream);
  const fmt = upstreamFormat(request);

  console.log(`[proxy] Incoming: ${request.method} ${request.url} | route.path: ${route.path} | fmt: ${fmt} | upstream: ${upstream}`);
  const headersObj: Record<string, string> = {};
  request.headers.forEach((val, key) => { headersObj[key] = val; });
  console.log(`[proxy] Headers: ${JSON.stringify(headersObj)}`);

  // Anthropic → OpenAI (for Claude Desktop/Cowork → any OpenAI API)
  if (route.path === '/v1/messages' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
      if (err) return authErrorResponse(err);

      if (fmt === "openai") {
        const req = (await request.json()) as AnthropicRequest;
        const originalModel = req.model;
        if (route.modelOverride) req.model = route.modelOverride;
        // Remap unsupported models (e.g. claude-3-5-haiku) to a valid OpenCode model if using OpenCode
        if (upstream.includes("opencode.ai")) {
          req.model = resolveModel(req.model);
          if (hasImages(req)) {
            req.model = VISION_MODEL;
          }
        }
        const openaiReq = formatAnthropicToOpenAI(req);
        const upstreamUrl = `${upstream}/chat/completions`;
        const res = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "Authorization": `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(openaiReq),
        });
        if (!res.ok) {
          const errorBody = await res.text();
          console.log(`[proxy] Upstream error: ${res.status} from ${upstreamUrl}`);
          console.log(`[proxy] Model: ${req.model} (original: ${originalModel})`);
          console.log(`[proxy] Response: ${errorBody.slice(0, 500)}`);
          return upstreamErrorResponse(res, errorBody);
        }

        if (openaiReq.stream) {
          return new Response(streamOpenAIToAnthropic((res.body || new ReadableStream()) as ReadableStream<Uint8Array>, originalModel), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data = (await res.json()) as OpenAIResponse;
        return new Response(JSON.stringify(toAnthropicResponse(data, originalModel)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (fmt === "openai-completions") {
        const req = (await request.json()) as AnthropicRequest;
        const originalModel = req.model;
        if (route.modelOverride) req.model = route.modelOverride;
        if (upstream.includes("opencode.ai")) {
          req.model = resolveModel(req.model);
        }
        const completionReq = formatAnthropicToOpenAICompletion(req);
        const upstreamUrl = `${upstream}/completions`;
        const res = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "Authorization": `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(completionReq),
        });
        if (!res.ok) {
          const errorBody = await res.text();
          return upstreamErrorResponse(res, errorBody);
        }

        if (completionReq.stream) {
          return new Response(streamOpenAICompletionToAnthropic((res.body || new ReadableStream()) as ReadableStream<Uint8Array>, originalModel), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data = (await res.json()) as OpenAICompletionResponse;
        return new Response(JSON.stringify(toAnthropicResponseFromCompletion(data, originalModel)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to Anthropic upstream
      const res = await fetch(`${upstream}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(request, key!),
        body: await request.text(),
      });
      return res;
  }

  // OpenAI Chat Completions → Anthropic (or pass-through)
  if (route.path === '/v1/chat/completions' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
      if (err) return authErrorResponse(err);

      if (fmt === "anthropic") {
        const req = (await request.json()) as OpenAIRequest;
        const anthReq = formatOpenAIToAnthropic(req);
        const res = await fetch(`${upstream}/v1/messages`, {
          method: "POST",
          headers: anthropicHeaders(request, key!),
          body: JSON.stringify(anthReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (anthReq.stream) {
          return new Response(streamAnthropicToOpenAI((res.body || new ReadableStream()) as ReadableStream<Uint8Array>, anthReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data = (await res.json()) as AnthropicResponse;
        return new Response(JSON.stringify(toOpenAIResponse(data, anthReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to OpenAI upstream
      const res = await fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        },
        body: await request.text(),
      });
      return res;
  }

  // OpenAI Legacy Completions → Anthropic OR Chat API (or pass-through)
  if (route.path === '/v1/completions' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
      if (err) return authErrorResponse(err);

      // Translate legacy completions to modern chat completions (for OpenCode / standard OpenAI endpoint)
      if (fmt === "openai") {
        const req = (await request.json()) as OpenAICompletionRequest;
        const chatReq = formatOpenAICompletionToOpenAIChat(req);
        const upstreamUrl = `${upstream}/chat/completions`;
        const res = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "Authorization": `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(chatReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (chatReq.stream) {
          return new Response(streamOpenAIChatToOpenAICompletion((res.body || new ReadableStream()) as ReadableStream<Uint8Array>, req.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data = (await res.json()) as OpenAIResponse;
        return new Response(JSON.stringify(formatOpenAIChatToOpenAICompletion(data, req.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (fmt === "anthropic") {
        const req = (await request.json()) as OpenAICompletionRequest;
        const anthReq = formatOpenAICompletionToAnthropic(req);
        const res = await fetch(`${upstream}/v1/messages`, {
          method: "POST",
          headers: anthropicHeaders(request, key!),
          body: JSON.stringify(anthReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (anthReq.stream) {
          return new Response(streamAnthropicToOpenAICompletion((res.body || new ReadableStream()) as ReadableStream<Uint8Array>, anthReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data = (await res.json()) as AnthropicResponse;
        return new Response(JSON.stringify(toOpenAICompletionResponse(data, anthReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to OpenAI completions upstream
      const res = await fetch(`${upstream}/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        },
        body: await request.text(),
      });
      return res;
  }

  // Model discovery
  if (route.path === '/v1/models' && request.method === 'GET') {
      const key = extractApiKey(request.headers);
      const err = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
      if (err) return authErrorResponse(err);

      const res = fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key!),
          })
        : await fetch(`${upstream}/models`, {
            method: "GET",
            headers: {
              ...(key ? { "Authorization": `Bearer ${key}` } : {}),
            },
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    name: "opencode-cowork-proxy",
    upstream,
    routes: {
      "/go": GO_UPSTREAM,
      "/zen": ZEN_UPSTREAM,
    },
    endpoints: {
      "/v1/messages": "Anthropic → upstream (translated if upstream=openai or openai-completions)",
      "/v1/chat/completions": "OpenAI Chat → upstream (translated if upstream=anthropic)",
      "/v1/completions": "OpenAI Completions/Codex → upstream (translated if upstream=anthropic or openai)",
      "/v1/models": "Model discovery proxy",
    },
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: route.path === '/' ? 200 : 404,
  });
}

const app = new Hono();
app.use('*', logger());
app.all('*', (c) => handleRequest(c.req.raw));

export default app;
