/**
 * Converts OpenAI Chat Completions request to Anthropic Messages request.
 */
import {
  OpenAIRequest,
  OpenAIMessage,
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock
} from '../../types';

function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function imageSourceFromUrl(url: string | undefined): { type: "base64" | "url"; media_type?: string; data?: string; url?: string } {
  const match = (url || "").match(/^data:([^;]+);base64,(.*)$/);
  if (match) {
    return { type: "base64", media_type: match[1], data: match[2] };
  }
  // If it's an HTTP(S) URL, use Anthropic's url source type
  if (url?.startsWith("http://") || url?.startsWith("https://")) {
    return { type: "url" as any, url };
  }
  // Fallback for unknown formats
  return { type: "base64", media_type: "image/jpeg", data: url || "" };
}

export function formatOpenAIToAnthropic(body: OpenAIRequest): AnthropicRequest {
  const { model, messages, temperature, max_tokens, top_p, stop, tools, stream } = body;

  // Separate system messages from conversation
  const systemMessages: string[] = [];
  const conversationMessages: OpenAIMessage[] = [];

  for (const msg of messages || []) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemMessages.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((part) => {
          if (part.type === "text") systemMessages.push(part.text);
        });
      }
    } else {
      conversationMessages.push(msg);
    }
  }

  // Convert OpenAI messages to Anthropic format
  const anthropicMessages: AnthropicMessage[] = [];

  for (let i = 0; i < conversationMessages.length; i++) {
    const msg = conversationMessages[i];

    if (msg.role === "user") {
      const content: AnthropicContentBlock[] = [];

      if (typeof msg.content === "string") {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((part) => {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "image_url") {
            content.push({
              type: "image",
              source: imageSourceFromUrl(part.image_url?.url),
            });
          }
        });
      }

      // Collect tool results from immediately following tool messages
      const nextMsg = conversationMessages[i + 1];
      if (nextMsg && nextMsg.role === "tool") {
        i++; // consume the tool message

        // If there are consecutive tool messages, collect them all
        const toolMessages = [nextMsg];
        while (i + 1 < conversationMessages.length && conversationMessages[i + 1].role === "tool") {
          toolMessages.push(conversationMessages[++i]);
        }

        for (const toolMsg of toolMessages) {
          content.push({
            type: "tool_result",
            tool_use_id: toolMsg.tool_call_id || "",
            content: typeof toolMsg.content === "string"
              ? toolMsg.content
              : JSON.stringify(toolMsg.content),
          });
        }
      }

      anthropicMessages.push({ role: "user", content });
    } else if (msg.role === "tool") {
      // Standalone tool message (not immediately after a user message).
      // Convert to a user message with tool_result blocks.
      // Collect consecutive tool messages.
      const toolMessages = [msg];
      while (i + 1 < conversationMessages.length && conversationMessages[i + 1].role === "tool") {
        toolMessages.push(conversationMessages[++i]);
      }
      const content: AnthropicContentBlock[] = toolMessages.map((toolMsg) => ({
        type: "tool_result",
        tool_use_id: toolMsg.tool_call_id || "",
        content: typeof toolMsg.content === "string"
          ? toolMsg.content
          : JSON.stringify(toolMsg.content),
      }));
      anthropicMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content: AnthropicContentBlock[] = [];

      if (msg.content) {
        content.push({ type: "text", text: msg.content as string });
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "",
            input: parseToolArguments(tc.function?.arguments),
          });
        }
      }

      if (content.length > 0) {
        anthropicMessages.push({ role: "assistant", content });
      }
    }
  }

  // Build Anthropic request
  const anthropicRequest: AnthropicRequest = {
    model,
    messages: anthropicMessages,
    max_tokens: max_tokens || 4096,
    stream,
  };

  if (systemMessages.length > 0) {
    anthropicRequest.system = systemMessages.length === 1
      ? systemMessages[0]
      : systemMessages;
  }

  if (temperature !== undefined) {
    anthropicRequest.temperature = temperature;
  }

  if (top_p !== undefined) {
    anthropicRequest.top_p = top_p;
  }

  if (stop) {
    anthropicRequest.stop_sequences = Array.isArray(stop) ? stop : [stop];
  }

  if (tools) {
    anthropicRequest.tools = tools.map((t) => ({
      name: t.function?.name || "",
      description: t.function?.description,
      input_schema: t.function?.parameters || { type: "object", properties: {} },
    }));
  }

  return anthropicRequest;
}
