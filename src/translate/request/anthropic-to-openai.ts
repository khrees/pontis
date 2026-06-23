import { hashSystemPrompt } from '../../cache';
import {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicImageBlock,
  OpenAIRequest,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAIToolCall
} from '../../types';

const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"]);

function isValidImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // Block private/internal IPs
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return false;
    if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return false;
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function translateImageBlock(part: AnthropicImageBlock): OpenAIContentPart | null {
  const src = part.source;
  if (!src) return null;
  if (src.type === "url" && src.url) {
    if (!isValidImageUrl(src.url)) {
      return { type: "text" as const, text: "[Image URL blocked: private/invalid URL]" };
    }
    return { type: "image_url", image_url: { url: src.url } };
  }
  if (src.type === "base64") {
    const safeMediaType = SAFE_IMAGE_TYPES.has(src.media_type || "") ? src.media_type : "image/jpeg";
    return { type: "image_url", image_url: { url: `data:${safeMediaType};base64,${src.data}` } };
  }
  return null;
}

export function formatAnthropicToOpenAI(body: AnthropicRequest): OpenAIRequest {
  const { model, messages, system, temperature, max_tokens, top_p, stop_sequences, tools, stream } = body;

  const openAIMessages: OpenAIMessage[] = Array.isArray(messages)
    ? messages.flatMap((msg) => {
        if (typeof msg.content === "string") {
          return [{ role: msg.role, content: msg.content }];
        }
        if (!Array.isArray(msg.content)) return [];

        const result: OpenAIMessage[] = [];

        if (msg.role === "assistant") {
          const assistantMsg: OpenAIMessage = { role: "assistant", content: null };
          let text = "";
          let reasoningContent = "";
          const toolCalls: OpenAIToolCall[] = [];

          (msg.content as AnthropicContentBlock[]).forEach((part) => {
            if (part.type === "text") {
              text += (typeof part.text === "string" ? part.text : JSON.stringify(part.text)) + "\n";
            } else if (part.type === "thinking") {
              reasoningContent += (typeof part.thinking === "string" ? part.thinking : JSON.stringify(part.thinking)) + "\n";
            } else if (part.type === "tool_use") {
              toolCalls.push({
                id: part.id,
                type: "function",
                function: { name: part.name, arguments: JSON.stringify(part.input) },
              });
            }
          });

          const trimmed = text.trim();
          const trimmedReasoning = reasoningContent.trim();
          if (trimmed) assistantMsg.content = trimmed;
          if (trimmedReasoning) assistantMsg.reasoning_content = trimmedReasoning;
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
          if (assistantMsg.content || assistantMsg.reasoning_content || assistantMsg.tool_calls) {
            result.push(assistantMsg);
          }
        }

        if (msg.role === "user") {
          let userText = "";
          const contentParts: OpenAIContentPart[] = [];
          const toolResults: OpenAIMessage[] = [];

          (msg.content as AnthropicContentBlock[]).forEach((part) => {
            if (part.type === "text") {
              userText += (typeof part.text === "string" ? part.text : JSON.stringify(part.text)) + "\n";
            } else if (part.type === "image") {
              const translated = translateImageBlock(part);
              if (translated) contentParts.push(translated);
            } else if (part.type === "tool_result") {
              toolResults.push({
                role: "tool",
                tool_call_id: part.tool_use_id,
                content: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
              });
            }
          });

          const trimmed = userText.trim();

          result.push(...toolResults);

          if (contentParts.length > 0) {
            if (trimmed) contentParts.unshift({ type: "text", text: trimmed });
            result.push({ role: "user", content: contentParts });
          } else if (trimmed) {
            result.push({ role: "user", content: trimmed });
          }
        }

        return result;
      })
    : [];

  const systemMessages: OpenAIMessage[] = Array.isArray(system)
    ? system.map((item) => ({ role: "system", content: typeof item === "string" ? item : (item.text || "") }))
    : typeof system === "string"
      ? [{ role: "system", content: system }]
      : [];

  const data: OpenAIRequest = {
    model,
    messages: [...systemMessages, ...openAIMessages],
  };

  if (max_tokens !== undefined) data.max_tokens = max_tokens;
  if (temperature !== undefined) data.temperature = temperature;
  if (top_p !== undefined) data.top_p = top_p;
  if (stream !== undefined) data.stream = stream;
  if (stream) data.stream_options = { include_usage: true };
  if (stop_sequences) data.stop = stop_sequences;

  if (tools) {
    data.tools = tools.map((item) => ({
      type: "function",
      function: {
        name: item.name,
        description: item.description,
        parameters: item.input_schema,
      },
    }));
  }

  // Translate Anthropic tool_choice to OpenAI format
  //   { type: "auto" }               → "auto" (default, can omit)
  //   { type: "any" }                → "required"
  //   { type: "tool", name: "xxx" }  → { type: "function", function: { name: "xxx" } }
  if (body.tool_choice) {
    const tc = body.tool_choice as Record<string, unknown>;
    if (tc.type === "any") {
      data.tool_choice = "required";
    } else if (tc.type === "tool" && tc.name) {
      data.tool_choice = { type: "function", function: { name: tc.name } };
    }
    // { type: "auto" } is the default in OpenAI too, so we omit it
  }

  const cacheKey = hashSystemPrompt(system);
  if (cacheKey) {
    data.prompt_cache_key = cacheKey;
  }

  return data;
}
