/**
 * Converts Anthropic Messages streaming SSE to OpenAI Chat Completions streaming SSE.
 */
import { OpenAIMessage } from '../../types';

interface AnthropicSSEEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

export function streamAnthropicToOpenAI(anthropicStream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const chatId = "chatcmpl-" + Math.floor(Date.now() / 1000);

  const enqueueSSE = (controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) => {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = anthropicStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Tool call tracking: index → { id, name, args }
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
      let contentBlockIndex = -1;

      function emitChunk(delta: Partial<OpenAIMessage>, finishReason?: string) {
        const chunk: Record<string, unknown> = {
          id: chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta }],
        };
        if (finishReason) {
          (chunk.choices as { finish_reason?: string }[])[0].finish_reason = finishReason;
        }
        enqueueSSE(controller, chunk);
      }

      function processEvents(lines: string[]) {
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let evt: AnthropicSSEEvent;
          try { evt = JSON.parse(raw); } catch { continue; }

          switch (evt.type) {
            case "message_start":
              contentBlockIndex = -1;
              toolCallMap.clear();
              break;

            case "content_block_start": {
              const block = evt.content_block;
              if (evt.index !== undefined) {
                contentBlockIndex = evt.index;
              }

              if (block?.type === "tool_use") {
                // Emit the initial tool_call chunk with id, name, empty args
                const tcId = block.id || `call_${Date.now()}`;
                toolCallMap.set(contentBlockIndex, { id: tcId, name: block.name || "", args: "" });
                emitChunk({
                  tool_calls: [{
                    id: tcId,
                    type: "function" as const,
                    function: { name: block.name || "", arguments: "" },
                  }],
                });
              }
              break;
            }

            case "content_block_delta": {
              const delta = evt.delta;
              if (delta?.type === "text_delta") {
                emitChunk({ content: delta.text || "" });
              } else if (delta?.type === "thinking_delta") {
                emitChunk({ reasoning_content: delta.thinking || "" });
              } else if (delta?.type === "input_json_delta") {
                // Accumulate and emit tool call argument deltas
                const tc = toolCallMap.get(contentBlockIndex);
                if (tc) {
                  tc.args += delta.partial_json || "";
                  emitChunk({
                    tool_calls: [{
                      id: tc.id,
                      type: "function" as const,
                      function: { arguments: delta.partial_json || "" },
                    }],
                  });
                }
              }
              break;
            }

            case "content_block_stop":
              break;

            case "message_delta": {
              const stopReason = evt.delta?.stop_reason;
              if (stopReason) {
                const finishReason = stopReason === "tool_use" ? "tool_calls" : "stop";
                emitChunk({}, finishReason);
              }
              break;
            }

            case "message_stop":
              // Nothing extra needed
              break;
          }
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Process complete SSE frames (delimited by double newline)
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || ""; // keep incomplete last part

          for (const frame of parts) {
            if (frame.trim()) {
              processEvents(frame.split("\n"));
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          processEvents(buffer.split("\n"));
        }
      } finally {
        reader.releaseLock();
      }

      // Send [DONE]
      enqueueSSE(controller, "[DONE]");
      controller.close();
    },
  });
}
