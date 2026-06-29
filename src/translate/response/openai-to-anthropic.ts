import { extractCachedTokens, extractOutputTokens, extractUncachedInputTokens } from '../../cache';
import {
  OpenAIResponse,
  AnthropicResponse,
  AnthropicContentBlock
} from '../../types';
import { isString, isObject } from '../../type-guards';

function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function formatOpenAIToAnthropic(completion: OpenAIResponse, model: string): AnthropicResponse {
  const messageId = "msg_" + Date.now();

  const content: AnthropicContentBlock[] = [];
  const message = completion.choices?.[0]?.message;
  const reasoning = message?.reasoning_content || (message as any)?.reasoning;
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning, signature: "" });
  }

  if (message?.content) {
    if (isString(message.content)) {
      content.push({ text: message.content, type: "text" });
    } else if (Array.isArray(message.content)) {
      const textContent = message.content
        .map(p => (p.type === "text" && isString(p.text) ? p.text : ""))
        .join("");
      content.push({ text: textContent, type: "text" });
    }
  }

  if (message?.tool_calls) {
    content.push(...message.tool_calls.map((item) => ({
      type: 'tool_use' as const,
      id: item.id,
      name: item.function?.name || "",
      input: parseToolArguments(item.function?.arguments),
    })));
  }

  // Map OpenAI finish_reason to Anthropic stop_reason
  const finishReason = completion.choices?.[0]?.finish_reason;
  let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
  if (finishReason === "tool_calls") stopReason = "tool_use";
  else if (finishReason === "length") stopReason = "max_tokens";
  else if (finishReason === "stop") stopReason = "end_turn";

  const result: AnthropicResponse = {
    id: messageId,
    type: "message",
    role: "assistant",
    content,
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
      cache_creation_input_tokens: 0, // OpenAI doesn't expose write tokens
    };
  }

  return result;
}
