/**
 * Individual request handlers for different API endpoints.
 * Breaking down the large handleRequest function from index.ts into smaller, focused units.
 */

import { debugLog } from './logger';
import { wrapProxyRequest, fetchWithTimeout, anthropicHeaders, openaiAuthHeaders, SSE_HEADERS, jsonResponse, upstreamErrorResponse, passthroughResponse } from './http';
import { extractApiKey } from './auth';
import { routeConfig, upstreamFormat, requestHasImages, resolveModelAndUpstream, type RouteConfig } from './config';
import { handleModelsRequest } from './handlers/models';
import { handleResponsesRequest } from './handlers/responses';
import type { AnthropicRequest, OpenAIRequest, OpenAICompletionRequest, AnthropicResponse, OpenAIResponse, OpenAICompletionResponse } from './types';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
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
} from './translate/completions';

/**
 * Handle Anthropic /v1/messages requests
 */
export async function handleAnthropicMessages(request: Request, route: RouteConfig, reqId: string): Promise<Response> {
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
    if (authErr) throw authErr;
    req.model = resolvedModel;
    debugLog(`[${reqId}] POST /v1/messages → ${upstream} (model=${resolvedModel})`);

    const fmt = upstreamFormat();
    const key = extractApiKey(request.headers);

    if (fmt === 'openai') {
      return handleAnthropicToOpenAI(req, upstream, key, reqId, originalModel);
    }

    if (fmt === 'openai-completions') {
      return handleAnthropicToCompletions(req, upstream, key, reqId, originalModel);
    }

    return handleAnthropicPassthrough(req, upstream, request, key, reqId);
  });
}

/**
 * Handle Anthropic to OpenAI format translation
 */
async function handleAnthropicToOpenAI(req: AnthropicRequest, upstream: string, key: string | null, reqId: string, originalModel: string): Promise<Response> {
  const openaiReq = formatAnthropicToOpenAI(req);
  debugLog(`[${reqId}] Translated OpenAI messages: ${JSON.stringify(openaiReq.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 100) + '...' : m.content })))}`);

  const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: { ...openaiAuthHeaders(key), 'X-Request-Id': reqId },
    body: JSON.stringify(openaiReq),
  });
  debugLog(`[${reqId}] Upstream fetch headers received (status=${res.status})`);

  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }

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
  return jsonResponse(toAnthropicResponse(jsonVal as OpenAIResponse, originalModel));
}

/**
 * Handle Anthropic to OpenAI completions format translation
 */
async function handleAnthropicToCompletions(req: AnthropicRequest, upstream: string, key: string | null, reqId: string, originalModel: string): Promise<Response> {
  const completionReq = formatAnthropicToOpenAICompletion(req);
  const res = await fetchWithTimeout(`${upstream}/completions`, {
    method: 'POST',
    headers: { ...openaiAuthHeaders(key), 'X-Request-Id': reqId },
    body: JSON.stringify(completionReq),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }

  if (completionReq.stream) {
    return new Response(
      streamOpenAICompletionToAnthropic(
        (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
        originalModel,
      ),
      { headers: SSE_HEADERS },
    );
  }
  return jsonResponse(toAnthropicResponseFromCompletion((await res.json()) as OpenAICompletionResponse, originalModel));
}

/**
 * Handle Anthropic passthrough (no translation needed)
 */
async function handleAnthropicPassthrough(req: AnthropicRequest, upstream: string, request: Request, key: string | null, reqId: string): Promise<Response> {
  const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(request, key!), 'X-Request-Id': reqId },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }
  return passthroughResponse(res);
}

/**
 * Handle OpenAI /v1/chat/completions requests
 */
export async function handleOpenAIChatCompletions(request: Request, route: RouteConfig, reqId: string): Promise<Response> {
  return wrapProxyRequest(reqId, async () => {
    const req = (await request.json()) as OpenAIRequest;
    const { model: resolvedModel, upstream, authErr } = resolveModelAndUpstream(
      request,
      route.upstream,
      req.model || 'gpt-5.4-mini',
    );
    if (authErr) throw authErr;
    req.model = resolvedModel;
    debugLog(`[${reqId}] POST /v1/chat/completions → ${upstream} (model=${resolvedModel})`);

    const fmt = upstreamFormat();
    const key = extractApiKey(request.headers);

    if (fmt === 'anthropic') {
      return handleOpenAIToAnthropic(req, upstream, request, key, reqId);
    }

    // Handle developer role conversion for OpenAI compatibility
    for (const msg of req.messages || []) {
      if (msg.role === 'developer') {
        msg.role = 'system';
        debugLog(`[${reqId}] Rewriting developer role message to system for upstream compatibility`);
      }
    }

    return handleOpenAIPassthrough(req, upstream, key, reqId);
  });
}

/**
 * Handle OpenAI to Anthropic format translation
 */
async function handleOpenAIToAnthropic(req: OpenAIRequest, upstream: string, request: Request, key: string | null, reqId: string): Promise<Response> {
  const anthReq = formatOpenAIToAnthropic(req);
  const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(request, key!), 'X-Request-Id': reqId },
    body: JSON.stringify(anthReq),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }

  if (anthReq.stream) {
    return new Response(
      streamAnthropicToOpenAI(
        (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
        anthReq.model,
      ),
      { headers: SSE_HEADERS },
    );
  }
  return jsonResponse(toOpenAIResponse((await res.json()) as AnthropicResponse, anthReq.model));
}

/**
 * Handle OpenAI passthrough (no translation needed)
 */
async function handleOpenAIPassthrough(req: OpenAIRequest, upstream: string, key: string | null, reqId: string): Promise<Response> {
  const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: { ...openaiAuthHeaders(key), 'X-Request-Id': reqId },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }
  return passthroughResponse(res);
}

/**
 * Handle OpenAI /v1/completions requests
 */
export async function handleOpenAICompletions(request: Request, route: RouteConfig, reqId: string): Promise<Response> {
  return wrapProxyRequest(reqId, async () => {
    const req = (await request.json()) as OpenAICompletionRequest;
    const { model: resolvedModel, upstream, authErr } = resolveModelAndUpstream(
      request,
      route.upstream,
      req.model || 'gpt-5.4-mini',
    );
    if (authErr) throw authErr;
    req.model = resolvedModel;
    debugLog(`[${reqId}] POST /v1/completions → ${upstream} (model=${resolvedModel})`);

    const fmt = upstreamFormat();
    const key = extractApiKey(request.headers);

    if (fmt === 'openai') {
      return handleCompletionsToChat(req, upstream, key, reqId);
    }

    if (fmt === 'anthropic') {
      return handleCompletionsToAnthropic(req, upstream, request, key, reqId);
    }

    return handleCompletionsPassthrough(req, upstream, key, reqId);
  });
}

/**
 * Handle OpenAI completions to chat format translation
 */
async function handleCompletionsToChat(req: OpenAICompletionRequest, upstream: string, key: string | null, reqId: string): Promise<Response> {
  const chatReq = formatOpenAICompletionToOpenAIChat(req);
  const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: { ...openaiAuthHeaders(key), 'X-Request-Id': reqId },
    body: JSON.stringify(chatReq),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }

  if (chatReq.stream) {
    return new Response(
      streamOpenAIChatToOpenAICompletion(
        (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
        req.model,
      ),
      { headers: SSE_HEADERS },
    );
  }
  return jsonResponse(formatOpenAIChatToOpenAICompletion((await res.json()) as OpenAIResponse, req.model));
}

/**
 * Handle OpenAI completions to Anthropic format translation
 */
async function handleCompletionsToAnthropic(req: OpenAICompletionRequest, upstream: string, request: Request, key: string | null, reqId: string): Promise<Response> {
  const anthReq = formatOpenAICompletionToAnthropic(req);
  const res = await fetchWithTimeout(`${upstream}/v1/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(request, key!), 'X-Request-Id': reqId },
    body: JSON.stringify(anthReq),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }

  if (anthReq.stream) {
    return new Response(
      streamAnthropicToOpenAICompletion(
        (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
        anthReq.model,
      ),
      { headers: SSE_HEADERS },
    );
  }
  return jsonResponse(toOpenAICompletionResponse((await res.json()) as AnthropicResponse, anthReq.model));
}

/**
 * Handle OpenAI completions passthrough (no translation needed)
 */
async function handleCompletionsPassthrough(req: OpenAICompletionRequest, upstream: string, key: string | null, reqId: string): Promise<Response> {
  const res = await fetchWithTimeout(`${upstream}/completions`, {
    method: 'POST',
    headers: { ...openaiAuthHeaders(key), 'X-Request-Id': reqId },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw upstreamErrorResponse(res, errorBody, reqId);
  }
  return passthroughResponse(res);
}