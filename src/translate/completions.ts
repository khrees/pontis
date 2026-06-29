import {
  OpenAICompletionRequest,
  OpenAIRequest,
  OpenAIResponse,
  OpenAICompletionResponse,
  AnthropicRequest,
  AnthropicResponse
} from '../types';
import { extractCachedTokens, extractOutputTokens, extractUncachedInputTokens, extractInputTokens } from '../cache';
import { warnLog } from '../logger';
import { StreamBufferOverflowError, StreamParseError } from '../errors';
import { getTextEncoder, getTextDecoder, getOptimalBufferConfig } from '../stream-utils';

const BUFFER_CONFIG = getOptimalBufferConfig();
const MAX_BUFFER_SIZE = BUFFER_CONFIG.maxSize;

// ==========================================
// OpenAI Legacy Completion <-> OpenAI Chat
// ==========================================

export function formatOpenAICompletionToOpenAIChat(body: OpenAICompletionRequest): OpenAIRequest {
  const { model, prompt, temperature, max_tokens, top_p, stop, stream } = body;
  const chatRequest: OpenAIRequest = {
    model,
    messages: [{ role: "user", content: prompt || "" }],
    stream,
  };
  if (max_tokens !== undefined) chatRequest.max_tokens = max_tokens;
  if (temperature !== undefined) chatRequest.temperature = temperature;
  if (top_p !== undefined) chatRequest.top_p = top_p;
  if (stop) chatRequest.stop = stop;
  return chatRequest;
}

export function formatOpenAIChatToOpenAICompletion(response: OpenAIResponse, model: string): OpenAICompletionResponse {
  const message = response.choices?.[0]?.message;
  let text = "";
  if (typeof message?.content === "string") {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content.map(p => p.type === "text" ? p.text : "").join("");
  }
  if (message?.reasoning_content) {
    text = message.reasoning_content + (text ? "\n" + text : "");
  }

  const finishReason = response.choices?.[0]?.finish_reason;
  const finishReasonMapped = finishReason === "length" ? "length" as const : "stop" as const;

  return {
    id: response.id || "cmpl-" + Date.now(),
    object: "text_completion",
    created: response.created || Math.floor(Date.now() / 1000),
    model: model || response.model,
    choices: [
      {
        text,
        index: 0,
        finish_reason: finishReasonMapped,
      },
    ],
    usage: response.usage,
  };
}

export function streamOpenAIChatToOpenAICompletion(chatStream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const fallbackId = "cmpl-" + Math.floor(Date.now() / 1000);
  const encoder = getTextEncoder();
  const decoder = getTextDecoder();
  
  const enqueueSSE = (controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) => {
    controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
  };
  
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = chatStream.getReader();
      let buffer = "";
      
      function processEvents(lines: string[]) {
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          if (raw === "[DONE]") {
            enqueueSSE(controller, "[DONE]");
            continue;
          }
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch (e) {
            throw new StreamParseError(raw, e instanceof Error ? e : new Error(String(e)));
          }
          const delta = parsed.choices?.[0]?.delta;
          const text = delta?.content || delta?.reasoning_content || "";
          const finishReason = parsed.choices?.[0]?.finish_reason;
          const completionChunk = {
            id: parsed.id || fallbackId,
            object: "text_completion",
            created: parsed.created || Math.floor(Date.now() / 1000),
            model: model || parsed.model || "",
            choices: [{ text, index: 0, logprobs: null, finish_reason: finishReason || null }]
          };
          enqueueSSE(controller, completionChunk);
        }
      }
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          if (buffer.length > MAX_BUFFER_SIZE) {
            reader.releaseLock();
            throw new StreamBufferOverflowError(buffer.length, MAX_BUFFER_SIZE);
          }
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const frame of parts) {
            if (frame.trim()) processEvents(frame.split("\n"));
          }
        }
        if (buffer.trim()) processEvents(buffer.split("\n"));
      } finally {
        reader.releaseLock();
      }
      controller.close();
    },
  });
}

// ==========================================
// OpenAI Legacy Completion <-> Anthropic Messages
// ==========================================

export function formatAnthropicToOpenAICompletion(body: AnthropicRequest): OpenAICompletionRequest {
  const { model, messages, system, temperature, max_tokens, top_p, stop_sequences, stream } = body;
  let prompt = "";
  if (system) {
    const systemText = typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system.map(s => typeof s === "string" ? s : (s.text || "")).join("\n")
        : "";
    if (systemText.trim()) prompt += `<|system|>\n${systemText.trim()}\n<|end|>\n\n`;
  }
  for (const msg of messages || []) {
    const roleName = msg.role === "user" ? "User" : "Assistant";
    let contentText = "";
    if (typeof msg.content === "string") {
      contentText = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentText = msg.content.map(part => {
        if (part.type === "text") return part.text;
        if (part.type === "tool_use") return `[Tool Use: ${part.name} with input ${JSON.stringify(part.input)}]`;
        if (part.type === "tool_result") return `[Tool Result: ${part.content}]`;
        if (part.type === "thinking") return `[Thinking: ${part.thinking}]`;
        return "";
      }).join("\n");
    }
    prompt += `<|${roleName.toLowerCase()}|>\n${contentText}\n<|end|>\n\n`;
  }
  prompt += "<|assistant|>\n";

  const data: OpenAICompletionRequest = { model, prompt };
  if (max_tokens !== undefined) data.max_tokens = max_tokens;
  if (temperature !== undefined) data.temperature = temperature;
  if (top_p !== undefined) data.top_p = top_p;
  if (stream !== undefined) data.stream = stream;
  if (stop_sequences) data.stop = stop_sequences;
  return data;
}

export function formatOpenAICompletionToAnthropic(body: OpenAICompletionRequest): AnthropicRequest {
  const { model, prompt, temperature, max_tokens, top_p, stop, stream } = body;
  const anthRequest: AnthropicRequest = {
    model,
    messages: [{ role: "user", content: prompt || "" }],
    max_tokens: max_tokens || 4096,
    stream,
  };
  if (temperature !== undefined) anthRequest.temperature = temperature;
  if (top_p !== undefined) anthRequest.top_p = top_p;
  if (stop) anthRequest.stop_sequences = Array.isArray(stop) ? stop : [stop];
  return anthRequest;
}

export function formatAnthropicToOpenAICompletionResponse(response: AnthropicResponse, model: string): OpenAICompletionResponse {
  const content = response.content || [];
  let textContent = "";
  for (const block of content) {
    if (block.type === "text") textContent += block.text;
  }
  return {
    id: "cmpl-" + Date.now(),
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ text: textContent, index: 0, finish_reason: response.stop_reason === "max_tokens" ? "length" : "stop" }],
    usage: response.usage
      ? (() => {
          const input = extractInputTokens(response.usage);
          const output = extractOutputTokens(response.usage);
          return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
        })()
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function formatOpenAICompletionToAnthropicResponse(completion: OpenAICompletionResponse, model: string): AnthropicResponse {
  const text = completion.choices?.[0]?.text || "";
  const finishReason = completion.choices?.[0]?.finish_reason;
  let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
  if (finishReason === "length") stopReason = "max_tokens";
  const result: AnthropicResponse = {
    id: completion.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    model,
  };
  if (completion.usage) {
    const cached = extractCachedTokens(completion.usage);
    result.usage = {
      input_tokens: extractUncachedInputTokens(completion.usage),
      output_tokens: extractOutputTokens(completion.usage),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    };
  }
  return result;
}

export function streamAnthropicToOpenAICompletion(anthropicStream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const chatId = "cmpl-" + Math.floor(Date.now() / 1000);
  const encoder = getTextEncoder();
  const decoder = getTextDecoder();
  
  const enqueueSSE = (controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = anthropicStream.getReader();
      let buffer = "";
      
      function processEvents(lines: string[]) {
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let evt: any;
          try { evt = JSON.parse(raw); } catch (e) {
            throw new StreamParseError(raw, e instanceof Error ? e : new Error(String(e)));
          }
          switch (evt.type) {
            case "content_block_delta": {
              const delta = evt.delta;
              if (delta?.type === "text_delta") emitChunk(delta.text || "");
              break;
            }
            case "message_delta": {
              const stopReason = evt.delta?.stop_reason;
              if (stopReason) {
                const finishReason = stopReason === "max_tokens" ? "length" : "stop";
                emitChunk("", finishReason);
              }
              break;
            }
          }
        }
      }
      
      function emitChunk(text: string, finishReason?: string) {
        const chunk = {
          id: chatId,
          object: "text_completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, text, logprobs: null, finish_reason: finishReason || null }],
        };
        enqueueSSE(controller, chunk);
      }
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          if (buffer.length > MAX_BUFFER_SIZE) {
            reader.releaseLock();
            throw new StreamBufferOverflowError(buffer.length, MAX_BUFFER_SIZE);
          }
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const frame of parts) {
            if (frame.trim()) processEvents(frame.split("\n"));
          }
        }
        if (buffer.trim()) processEvents(buffer.split("\n"));
      } finally {
        reader.releaseLock();
      }
      enqueueSSE(controller, "[DONE]");
      controller.close();
    },
  });
}

export function streamOpenAICompletionToAnthropic(openaiStream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const messageId = "msg_" + Date.now();
  const encoder = getTextEncoder();
  const decoder = getTextDecoder();
  
  const enqueueSSE = (controller: ReadableStreamDefaultController<Uint8Array>, eventType: string, data: unknown) => {
    controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const contentBlockIndex = 0;
      let hasStartedTextBlock = false;
      let lastUsage: Record<string, number> | null = null;
      let finishReason: string | null = null;
      let messageStarted = false;
      const reader = openaiStream.getReader();
      let buffer = '';
      
      function processStreamDelta(text: string, parsed: any) {
        if (parsed.usage) {
          lastUsage = {
            input_tokens: extractUncachedInputTokens(parsed.usage),
            output_tokens: extractOutputTokens(parsed.usage),
            cache_read_input_tokens: extractCachedTokens(parsed.usage),
            cache_creation_input_tokens: 0,
          };
        }
        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
        }
        if (text !== undefined) {
          if (!hasStartedTextBlock) {
            if (!messageStarted) {
              enqueueSSE(controller, "message_start", {
                type: "message_start",
                message: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  content: [],
                  model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              });
              messageStarted = true;
            }
            enqueueSSE(controller, "content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            });
            hasStartedTextBlock = true;
          }
          enqueueSSE(controller, "content_block_delta", {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "text_delta", text },
          });
        }
      }
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              const lines = buffer.split('\n');
              for (const line of lines) {
                if (line.trim() && line.startsWith('data: ')) {
                  const data = line.slice(6).trim();
                  if (data === '[DONE]') continue;
                  try {
                    const parsed = JSON.parse(data);
                    const text = parsed.choices?.[0]?.text;
                    if (text !== undefined) processStreamDelta(text, parsed);
                  } catch (e) {
                    throw new StreamParseError(data, e instanceof Error ? e : new Error(String(e)));
              }
                }
              }
            }
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          if (buffer.length > MAX_BUFFER_SIZE) {
            reader.releaseLock();
            throw new StreamBufferOverflowError(buffer.length, MAX_BUFFER_SIZE);
          }
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim() && line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                const text = parsed.choices?.[0]?.text;
                if (text !== undefined) processStreamDelta(text, parsed);
              } catch (e) {
                throw new StreamParseError(data, e instanceof Error ? e : new Error(String(e)));
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (hasStartedTextBlock) {
        enqueueSSE(controller, "content_block_stop", {
          type: "content_block_stop",
          index: contentBlockIndex,
        });
      }
      let stopReason = "end_turn";
      if (finishReason === "length") stopReason = "max_tokens";
      enqueueSSE(controller, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: lastUsage || { input_tokens: 0, output_tokens: 0 },
      });
      enqueueSSE(controller, "message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}
