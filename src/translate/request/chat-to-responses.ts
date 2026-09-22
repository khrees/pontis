import type {
  OpenAIMessage,
  OpenAIResponse,
  OpenAITool,
  OpenAIToolCall,
  OpenAIUsage,
  ResponseInputItem,
} from "../../types";

export interface ResponsesUpstreamRequest {
  model: string;
  input: ResponseInputItem[];
  instructions?: string;
  tools?: { type: "function"; name: string; description?: string; parameters?: Record<string, unknown> }[];
  stream: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
}

function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertTools(tools: OpenAITool[] | undefined) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .filter((t) => t && t.type === "function" && t.function?.name)
    .map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  return out.length > 0 ? out : undefined;
}

export function buildResponsesRequest(
  model: string,
  messages: OpenAIMessage[],
  opts?: {
    tools?: OpenAITool[];
    stream?: boolean;
    max_tokens?: number;
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
  },
): ResponsesUpstreamRequest {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];

  for (const msg of messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = textOf(msg.content);
      if (text) instructions.push(text);
      continue;
    }
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: textOf(msg.content),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const text = textOf(msg.content);
      if (text) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text" as const, text }],
        });
      }
      for (const tc of msg.tool_calls || []) {
        input.push({
          type: "function_call",
          call_id: tc.id || "",
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
      continue;
    }
    const text = textOf(msg.content);
    if (text) {
      input.push({
        role: "user",
        content: [{ type: "input_text" as const, text }],
      });
    }
  }

  const rawTokens = opts?.max_output_tokens ?? opts?.max_tokens;
  const maxOutputTokens = rawTokens !== undefined ? Math.max(16, rawTokens) : undefined;

  return {
    model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n") } : {}),
    ...(convertTools(opts?.tools) ? { tools: convertTools(opts?.tools) } : {}),
    stream: opts?.stream === true,
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts?.top_p !== undefined ? { top_p: opts.top_p } : {}),
  };
}

function toOpenAIUsage(u: any): OpenAIUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const prompt = u.input_tokens ?? u.prompt_tokens ?? 0;
  const completion = u.output_tokens ?? u.completion_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? prompt + completion,
  };
}

export function responsesJsonToChat(resJson: any, model: string): OpenAIResponse {
  const output = Array.isArray(resJson?.output) ? resJson.output : [];
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: item.name || "",
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          (part.type === "output_text" || part.type === "text") &&
          typeof part.text === "string"
        ) {
          textParts.push(part.text);
        }
      }
    }
  }

  const text = textParts.join("");
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (toolCalls.length > 0 ? null : ""),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: toOpenAIUsage(resJson?.usage),
  };
}

export function streamResponsesToChatCompletion(
  responsesStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now().toString(36)}`;

  const chunk = (delta: object, finish: string | null) =>
    encoder.encode(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = responsesStream.getReader();
      let buffer = "";
      let done = false;
      let hasStreamedText = false;

      const finish = (finishReason: string | null) => {
        if (done) return;
        done = true;
        controller.enqueue(chunk({}, finishReason));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        while (true) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let evt: any;
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }
            if (
              (evt.type === "response.output_text.delta" || evt.type === "response.text.delta" || (typeof evt.delta === "string" && !evt.type?.includes("function"))) &&
              typeof evt.delta === "string" &&
              evt.delta
            ) {
              hasStreamedText = true;
              controller.enqueue(chunk({ content: evt.delta }, null));
            } else if (evt.type === "response.output_item.done" && Array.isArray(evt.item?.content)) {
              if (!hasStreamedText) {
                for (const c of evt.item.content) {
                  if (c && (c.type === "output_text" || c.type === "text") && typeof c.text === "string" && c.text) {
                    controller.enqueue(chunk({ content: c.text }, null));
                  }
                }
              }
              hasStreamedText = false;
            } else if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
              const item = evt.item;
              controller.enqueue(
                chunk(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: item.call_id || item.id,
                        type: "function",
                        function: {
                          name: item.name,
                          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
                        },
                      },
                    ],
                  },
                  null,
                ),
              );
            } else if (evt.type === "response.completed" || evt.type === "response.done" || evt.type === "response.incomplete") {
              finish("stop");
            } else if (evt.type === "response.failed" || evt.type === "response.error") {
              finish("stop");
            }
          }
        }
        buffer += decoder.decode();
        finish("stop");
      } catch {
        try {
          finish("stop");
        } catch {}
      }
    },
  });
}
