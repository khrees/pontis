import { extractApiKey, validateApiKey, authErrorResponse } from "../auth";
import {
  assistantMessageFromChatMessage,
  assistantMessageFromOutputItems,
} from "../assistant-message";
import { getUpstream, resolveModel, selectUpstream } from "../config";
import { fetchWithTimeout, jsonResponse, openaiAuthHeaders, proxyErrorResponse, SSE_HEADERS, upstreamErrorResponse } from "../http";
import { debugLog, warnLog } from "../logger";
import { responseCache } from "../responses-cache";
import type { OpenAIMessage, OpenAIResponse, ResponsesApiRequest, ResponsesApiUsage } from "../types";
import {
  buildChatRequest,
  chatResponseToOutput,
  extractUsage,
  responsesToChatMessages,
} from "../translate/request/responses-to-chat";
import {
  streamChatToResponses,
  type StreamCompleteEvent,
} from "../translate/stream/chat-to-responses";

function createResponseId(): string {
  return `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function cacheTurn(
  responseId: string,
  model: string,
  originalModel: string,
  fullMessages: unknown[],
  usage: ResponsesApiUsage,
): void {
  responseCache.set(responseId, {
    responseId,
    model,
    originalModel,
    fullMessages,
    usage,
  });
}

function logResponsesTranslation(
  reqId: string,
  req: ResponsesApiRequest,
  chatReq: { messages?: unknown[]; tools?: unknown[]; stream?: boolean },
): void {
  const inputItemCount = Array.isArray(req.input) ? req.input.length : 0;
  const messageCount = chatReq.messages?.length || 0;

  debugLog(
    `[${reqId}] Responses → Chat: ${inputItemCount} input items → ${messageCount} messages, ${chatReq.tools?.length || 0} tools, stream=${chatReq.stream}`,
  );

  if (inputItemCount > 0 && messageCount < inputItemCount / 2) {
    const types = (req.input || []).map(
      (item) => item.type || item.role || "?",
    );
    warnLog(
      `[${reqId}] Possible input conversion loss. Input types: ${types.join(", ")}`,
    );
  }
}

export async function handleResponsesRequest(
  request: Request,
  routeUpstream: string,
  reqId: string,
): Promise<Response> {
  try {
    const key = extractApiKey(request.headers);
    const req = (await request.json()) as ResponsesApiRequest;
    const originalModel = req.model || "gpt-5.4-mini";

    let resolvedModel = originalModel;
    const baseUpstream = getUpstream(request, routeUpstream);
    if (baseUpstream.includes("opencode.ai")) {
      resolvedModel = resolveModel(resolvedModel);
    }
    req.model = resolvedModel;

    const upstream = selectUpstream(request, routeUpstream, resolvedModel);
    const authErr = upstream.includes("opencode.ai") ? validateApiKey(key) : null;
    if (authErr) return authErrorResponse(authErr);

    debugLog(
      `[${reqId}] POST /v1/responses → ${upstream} (model=${resolvedModel})`,
    );

    const cachedPrevious = req.previous_response_id
      ? responseCache.get(req.previous_response_id)
      : undefined;

    if (req.previous_response_id && !cachedPrevious) {
      warnLog(
        `[${reqId}] Unknown previous_response_id=${req.previous_response_id}; relying on request input for context`,
      );
    }

    const { messages } = responsesToChatMessages(
      req,
      resolvedModel,
      cachedPrevious?.fullMessages as OpenAIMessage[] | undefined,
    );

    const acceptHeader = request.headers.get("Accept") || "";
    const shouldStream =
      req.stream !== undefined
        ? req.stream
        : acceptHeader.includes("text/event-stream");

    const chatReq = buildChatRequest(req, req.model, messages);
    chatReq.stream = shouldStream;
    if (shouldStream) {
      chatReq.stream_options = { include_usage: true };
    } else {
      delete chatReq.stream_options;
    }

    logResponsesTranslation(reqId, req, chatReq);

    const res = await fetchWithTimeout(`${upstream}/chat/completions`, {
      method: "POST",
      headers: { ...openaiAuthHeaders(key), "X-Request-Id": reqId },
      body: JSON.stringify(chatReq),
    });
    if (!res.ok) return upstreamErrorResponse(res, await res.text(), reqId);

    const responseId = createResponseId();

    if (chatReq.stream) {
      cacheTurn(responseId, resolvedModel, originalModel, chatReq.messages, {
        input_tokens: 0,
        output_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });

      return new Response(
        streamChatToResponses(
          (res.body || new ReadableStream()) as ReadableStream<Uint8Array>,
          originalModel,
          req.previous_response_id,
          responseId,
          (completeEvt: StreamCompleteEvent) => {
            const assistantMsg = assistantMessageFromOutputItems(completeEvt.output);
            cacheTurn(
              responseId,
              resolvedModel,
              originalModel,
              [...chatReq.messages, assistantMsg],
              completeEvt.usage,
            );
          },
        ),
        { headers: SSE_HEADERS },
      );
    }

    const chatRes = (await res.json()) as OpenAIResponse;
    const message = chatRes.choices?.[0]?.message || { role: "assistant" as const };
    const { output } = chatResponseToOutput(message);
    const usage = extractUsage(chatRes);

    cacheTurn(
      responseId,
      resolvedModel,
      originalModel,
      [...chatReq.messages, assistantMessageFromChatMessage(message)],
      usage,
    );

    return jsonResponse({
      id: responseId,
      object: "response",
      model: originalModel,
      ...(req.previous_response_id
        ? { previous_response_id: req.previous_response_id }
        : {}),
      status: "completed",
      usage,
      output,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      warnLog(`[${reqId}] Upstream request timed out`);
      return proxyErrorResponse("upstream_timeout", "Upstream did not respond in time", { requestId: reqId });
    }
    warnLog(`[${reqId}] Responses request failed: ${err instanceof Error ? err.message : String(err)}`);
    return proxyErrorResponse("proxy_error", err instanceof Error ? err.message : String(err), { requestId: reqId });
  }
}
