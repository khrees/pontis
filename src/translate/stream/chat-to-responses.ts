import type { OpenAIUsage, ResponsesApiUsage, ResponsesOutputItem } from "../../types";
import { warnLog } from "../../logger";

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_ACCUMULATION = 5 * 1024 * 1024; // 5MB

/**
 * Callback fired when the stream completes, with the final state for caching.
 * The caller can use this to persist conversation state for multi-turn.
 */
export interface StreamCompleteEvent {
  responseId: string;
  output: ResponsesOutputItem[];
  usage: ResponsesApiUsage;
  model: string;
}

export function streamChatToResponses(
  chatStream: ReadableStream<Uint8Array>,
  originalModel: string,
  previousResponseId?: string,
  responseId?: string,
  onComplete?: (evt: StreamCompleteEvent) => void,
): ReadableStream<Uint8Array> {
  const reader = chatStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasStreamedReasoning = false;
  let fullText = "";
  let reasoningText = "";

  // Track if the text item was actually emitted (determines output_index for tool calls)
  let textItemWasOutput = false;

  // Track whether the text output_item has been started (lazy)
  let textItemStarted = false;
  let textContentStarted = false;

  // Track tool calls by their stream index
  const activeToolCalls = new Map<number, {
    id: string;
    name: string;
    arguments: string;
    itemId: string;
  }>();

  const enqueueSSE = (controller: ReadableStreamDefaultController<Uint8Array>, eventType: string, data: unknown) => {
    controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const resolvedId = responseId || "resp_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  let itemId = "out_" + Date.now();

  let pendingText = "";
  let inDsml = false;
  let flushMode = false; // when true, processTextDelta skips partial-prefix holdback (used at EOF)
  let toolCallCount = 0;
  let accumulatedUsage: OpenAIUsage | null = null;
  const completedOutputs: ResponsesOutputItem[] = [];

  function emitFunctionCall(
    controller: ReadableStreamDefaultController<Uint8Array>,
    toolName: string,
    args: Record<string, string>,
  ): void {
    toolCallCount++;
    const callId = "call_" + Math.random().toString(36).substring(2, 15);
    const toolItemId = "item_" + callId;
    const argsStr = JSON.stringify(args);
    const outputIndex = toolCallCount;

    enqueueSSE(controller, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: resolvedId,
      output_index: outputIndex,
      item: { id: toolItemId, type: "function_call", name: toolName, call_id: callId, arguments: "" }
    });
    enqueueSSE(controller, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: resolvedId,
      item_id: toolItemId,
      output_index: outputIndex,
      call_id: callId,
      delta: argsStr
    });
    enqueueSSE(controller, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: resolvedId,
      item_id: toolItemId,
      output_index: outputIndex,
      call_id: callId,
      arguments: argsStr
    });
    enqueueSSE(controller, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: resolvedId,
      item: { id: toolItemId, type: "function_call", name: toolName, call_id: callId, arguments: argsStr }
    });
    completedOutputs.push({
      id: toolItemId,
      type: "function_call",
      name: toolName,
      call_id: callId,
      arguments: argsStr,
      status: "completed"
    });
  }

  function ensureMessageItem(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!textItemStarted) {
      enqueueSSE(controller, "response.output_item.added", {
        type: "response.output_item.added",
        response_id: resolvedId,
        output_index: 0,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          content: []
        }
      });
      textItemStarted = true;
      textItemWasOutput = true;
    }
  }

  function ensureTextItem(controller: ReadableStreamDefaultController<Uint8Array>) {
    ensureMessageItem(controller);
    if (!textContentStarted) {
      enqueueSSE(controller, "response.content_part.added", {
        type: "response.content_part.added",
        response_id: resolvedId,
        item_id: itemId,
        part: {
          type: "text",
          text: ""
        }
      });
      textContentStarted = true;
    }
  }

  function flushTextUpTo(upTo: number, controller: ReadableStreamDefaultController<Uint8Array>) {
    const chunk = pendingText.slice(0, upTo);
    pendingText = pendingText.slice(upTo);
    if (!chunk) return;
    ensureTextItem(controller);
    fullText += chunk;
    if (fullText.length > MAX_TEXT_ACCUMULATION) fullText = fullText.slice(-MAX_TEXT_ACCUMULATION);
    enqueueSSE(controller, "response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: resolvedId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: chunk
    });
  }

  function processTextDelta(text: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    pendingText += text;
    if (pendingText.length > MAX_TEXT_ACCUMULATION) {
      pendingText = pendingText.slice(-MAX_TEXT_ACCUMULATION);
    }

    let searchAgain = true;
    while (searchAgain) {
      searchAgain = false;

      if (!inDsml) {
        const dsmlStartMatch = pendingText.match(/<[|｜]{2}DSML[|｜]{2}tool_calls>/i);
        const tcOpenMatch = pendingText.match(/<tool_call>/i);

        // Pick whichever tag appears first
        const dsmlFirst = dsmlStartMatch && (!tcOpenMatch || dsmlStartMatch.index! <= tcOpenMatch.index!);
        const tcFirst = tcOpenMatch && (!dsmlStartMatch || tcOpenMatch.index! < dsmlStartMatch.index!);

        if (dsmlFirst) {
          const startIndex = dsmlStartMatch!.index!;
          flushTextUpTo(startIndex, controller);
          closeTextItem(controller);
          pendingText = pendingText.slice(startIndex + dsmlStartMatch![0].length);
          inDsml = true;
          searchAgain = true;

        } else if (tcFirst) {
          const openIdx = tcOpenMatch!.index!;
          const closeMatch = pendingText.slice(openIdx).match(/<\/tool_call>/i);

          if (!closeMatch) {
            // Incomplete block — flush everything before it and hold the rest
            if (!flushMode) {
              flushTextUpTo(openIdx, controller);
              pendingText = pendingText.slice(openIdx);
            }
          } else {
            flushTextUpTo(openIdx, controller);
            closeTextItem(controller);

            const closeRelIdx = closeMatch.index!;
            const inner = pendingText.slice(openIdx + "<tool_call>".length, openIdx + closeRelIdx);
            pendingText = pendingText.slice(openIdx + closeRelIdx + "</tool_call>".length);

            const nameMatch = inner.match(/^([^<]+)/);
            const toolName = nameMatch ? nameMatch[1].trim() : "unknown";
            const args: Record<string, string> = {};
            const argKeyRegex = /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
            let argMatch;
            while ((argMatch = argKeyRegex.exec(inner)) !== null) {
              args[argMatch[1].trim()] = argMatch[2].trim();
            }
            emitFunctionCall(controller, toolName, args);
            searchAgain = true;
          }

        } else {
          // No tool-call tag found — flush text, holding back any potential partial prefix
          if (!flushMode) {
            const guards = ["<｜｜DSML｜｜tool_calls>", "<||DSML||tool_calls>", "<tool_call>"];
            let potentialPrefix = false;
            for (let i = 1; i <= 30; i++) {
              if (pendingText.length < i) break;
              const tail = pendingText.slice(-i);
              if (guards.some(g => g.startsWith(tail))) { potentialPrefix = true; break; }
            }
            if (potentialPrefix && pendingText.length > 30) {
              flushTextUpTo(pendingText.length - 30, controller);
            } else if (!potentialPrefix) {
              flushTextUpTo(pendingText.length, controller);
            }
          } else {
            flushTextUpTo(pendingText.length, controller);
          }
        }

      } else {
        // Inside DSML block — consume complete invoke blocks
        const invokeRegex = /<[|｜]{2}DSML[|｜]{2}invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}invoke\s*>/i;
        const invokeMatch = pendingText.match(invokeRegex);

        if (invokeMatch) {
          const toolName = invokeMatch[1];
          const inner = invokeMatch[2];
          const matchIndex = invokeMatch.index!;
          const args: Record<string, string> = {};
          const paramRegex = /<[|｜]{2}DSML[|｜]{2}parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}parameter\s*>/gi;
          let paramMatch;
          while ((paramMatch = paramRegex.exec(inner)) !== null) {
            args[paramMatch[1]] = paramMatch[2].trim();
          }
          emitFunctionCall(controller, toolName, args);
          pendingText = pendingText.slice(0, matchIndex) + pendingText.slice(matchIndex + invokeMatch[0].length);
          searchAgain = true;
        } else {
          const endMatch = pendingText.match(/<\/[|｜]{2}DSML[|｜]{2}tool_calls>/i);
          if (endMatch) {
            pendingText = pendingText.slice(endMatch.index! + endMatch[0].length);
            inDsml = false;
            searchAgain = true;
          }
        }
      }
    }
  }

  function getOutputIndexOffset(): number {
    return textItemWasOutput ? 1 : 0;
  }

  function closeTextItem(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (textContentStarted) {
      enqueueSSE(controller, "response.output_text.done", {
        type: "response.output_text.done",
        response_id: resolvedId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: fullText
      });

      enqueueSSE(controller, "response.content_part.done", {
        type: "response.content_part.done",
        response_id: resolvedId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: {
          type: "text",
          text: fullText
        }
      });
    }

    if (textItemStarted) {
      enqueueSSE(controller, "response.output_item.done", {
        type: "response.output_item.done",
        response_id: resolvedId,
        output_index: 0,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: fullText }]
        }
      });
      // Track the completed text output for the response.completed event
      completedOutputs.push({
        id: itemId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: fullText }],
        ...(reasoningText ? { reasoning_content: reasoningText } : {})
      });
      textItemStarted = false;
      textContentStarted = false;
      fullText = "";
      reasoningText = "";
      itemId = "out_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    }
  }

  function finalizeToolCalls(controller: ReadableStreamDefaultController<Uint8Array>) {
    for (const [idx, activeTc] of activeToolCalls.entries()) {
      enqueueSSE(controller, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        response_id: resolvedId,
        item_id: activeTc.itemId,
        output_index: idx + 1,
        call_id: activeTc.id,
        arguments: activeTc.arguments
      });

      enqueueSSE(controller, "response.output_item.done", {
        type: "response.output_item.done",
        response_id: resolvedId,
        item: {
          id: activeTc.itemId,
          type: "function_call",
          name: activeTc.name,
          call_id: activeTc.id,
          arguments: activeTc.arguments
        }
      });

      // Track the completed tool call for the response.completed event
      completedOutputs.push({
        id: activeTc.itemId,
        type: "function_call",
        name: activeTc.name,
        call_id: activeTc.id,
        arguments: activeTc.arguments,
        status: "completed"
      });
    }
    activeToolCalls.clear();
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Only send response.created upfront — text output_item is created lazily
      enqueueSSE(controller, "response.created", {
        type: "response.created",
        response: {
          id: resolvedId,
          object: "response",
          status: "in_progress",
          model: originalModel,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
        }
      });
    },

    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Drain any remaining tool-call blocks and text using the same parser,
          // but in flush mode so the partial-prefix holdback is disabled.
          flushMode = true;
          inDsml = inDsml; // preserve state so DSML block is continued
          processTextDelta("", controller);
          flushMode = false;


          if (hasStreamedReasoning) {
            enqueueSSE(controller, "response.reasoning_text.done", {
              type: "response.reasoning_text.done",
              response_id: resolvedId,
              item_id: itemId,
              output_index: 0,
              content_index: 0
            });
            hasStreamedReasoning = false;
          }

          // Close text output_item if it was started
          closeTextItem(controller);

          // Finalize any active tool calls
          finalizeToolCalls(controller);

          const promptTokens = accumulatedUsage?.prompt_tokens || accumulatedUsage?.input_tokens || 0;
          const completionTokens = accumulatedUsage?.completion_tokens || accumulatedUsage?.output_tokens || 0;
          const totalTokens = accumulatedUsage?.total_tokens || (promptTokens + completionTokens);
          const cachedRead = accumulatedUsage?.cache_read_input_tokens || accumulatedUsage?.prompt_tokens_details?.cached_tokens || accumulatedUsage?.input_tokens_details?.cached_tokens || 0;

          // event: response.completed
          enqueueSSE(controller, "response.completed", {
            type: "response.completed",
            response: {
              id: resolvedId,
              object: "response",
              status: "completed",
              model: originalModel,
              ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
              output: completedOutputs,
              usage: {
                input_tokens: promptTokens,
                output_tokens: completionTokens,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
                cache_read_input_tokens: cachedRead,
                cache_creation_input_tokens: 0
              }
            }
          });

          if (onComplete) {
            onComplete({
              responseId: resolvedId,
              output: completedOutputs,
              usage: {
                input_tokens: accumulatedUsage?.prompt_tokens || accumulatedUsage?.input_tokens || 0,
                output_tokens: accumulatedUsage?.completion_tokens || accumulatedUsage?.output_tokens || 0,
                prompt_tokens: accumulatedUsage?.prompt_tokens || accumulatedUsage?.input_tokens || 0,
                completion_tokens: accumulatedUsage?.completion_tokens || accumulatedUsage?.output_tokens || 0,
                total_tokens: accumulatedUsage?.total_tokens || 0,
                cache_read_input_tokens: accumulatedUsage?.cache_read_input_tokens || accumulatedUsage?.prompt_tokens_details?.cached_tokens || accumulatedUsage?.input_tokens_details?.cached_tokens || 0,
                cache_creation_input_tokens: 0,
              },
              model: originalModel,
            });
          }

          controller.close();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        if (buffer.length > MAX_BUFFER_SIZE) {
          warnLog('[stream] Buffer exceeded maximum size, aborting');
          controller.error(new Error('Stream buffer overflow'));
          reader.releaseLock();
          return;
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const dataJson = JSON.parse(trimmed.slice(6));

              // Capture usage from upstream chunks (usually on the final chunk)
              if (dataJson.usage) {
                accumulatedUsage = dataJson.usage;
              }

              const choices = dataJson.choices;
              if (Array.isArray(choices) && choices.length > 0) {
                const delta = choices[0].delta;
                if (delta) {
                  // Stream reasoning content if present
                  const reasoning = delta.reasoning_content || delta.reasoning;
                  if (reasoning) {
                    hasStreamedReasoning = true;
                    reasoningText += reasoning;
                    ensureMessageItem(controller);
                    enqueueSSE(controller, "response.reasoning_text.delta", {
                      type: "response.reasoning_text.delta",
                      response_id: resolvedId,
                      item_id: itemId,
                      output_index: 0,
                      content_index: 0,
                      delta: reasoning
                    });
                  }

                  // Stream standard text content if present
                  if (delta.content) {
                    if (hasStreamedReasoning) {
                      enqueueSSE(controller, "response.reasoning_text.done", {
                        type: "response.reasoning_text.done",
                        response_id: resolvedId,
                        item_id: itemId,
                        output_index: 0,
                        content_index: 0
                      });
                      hasStreamedReasoning = false;
                    }
                    processTextDelta(delta.content, controller);
                  }

                  // Stream tool calls if present
                  const toolCalls = delta.tool_calls;
                  if (Array.isArray(toolCalls)) {
                    closeTextItem(controller);
                    for (const tc of toolCalls) {
                      const idx = tc.index;
                      if (idx === undefined) continue;

                      const outputIdx = idx + getOutputIndexOffset();

                      if (!activeToolCalls.has(idx)) {
                        const callId = tc.id || `call_${Date.now()}_${idx}`;
                        const functionName = tc.function?.name || "";
                        const toolItemId = `item_${callId}`;

                        activeToolCalls.set(idx, {
                          id: callId,
                          name: functionName,
                          arguments: "",
                          itemId: toolItemId
                        });

                        enqueueSSE(controller, "response.output_item.added", {
                          type: "response.output_item.added",
                          response_id: resolvedId,
                          output_index: outputIdx,
                          item: {
                            id: toolItemId,
                            type: "function_call",
                            name: functionName,
                            call_id: callId,
                            arguments: ""
                          }
                        });
                      }

                      const activeTc = activeToolCalls.get(idx)!;
                      const argDelta = tc.function?.arguments;
                      if (argDelta) {
                        activeTc.arguments += argDelta;

                        enqueueSSE(controller, "response.function_call_arguments.delta", {
                          type: "response.function_call_arguments.delta",
                          response_id: resolvedId,
                          item_id: activeTc.itemId,
                          output_index: outputIdx,
                          call_id: activeTc.id,
                          delta: argDelta
                        });
                      }
                    }
                  }
                }

                // When finish_reason is tool_calls, finalize all active tool calls
                const finishReason = choices[0]?.finish_reason;
                if (finishReason === "tool_calls" && activeToolCalls.size > 0) {
                  for (const [idx, activeTc] of activeToolCalls.entries()) {
                    const outputIdx = idx + getOutputIndexOffset();
                    enqueueSSE(controller, "response.function_call_arguments.done", {
                      type: "response.function_call_arguments.done",
                      response_id: resolvedId,
                      item_id: activeTc.itemId,
                      output_index: outputIdx,
                      call_id: activeTc.id,
                      arguments: activeTc.arguments
                    });

                    enqueueSSE(controller, "response.output_item.done", {
                      type: "response.output_item.done",
                      response_id: resolvedId,
                      item: {
                        id: activeTc.itemId,
                        type: "function_call",
                        name: activeTc.name,
                        call_id: activeTc.id,
                        arguments: activeTc.arguments
                      }
                    });

                    completedOutputs.push({
                      id: activeTc.itemId,
                      type: "function_call",
                      name: activeTc.name,
                      call_id: activeTc.id,
                      arguments: activeTc.arguments,
                      status: "completed"
                    });
                  }
                  activeToolCalls.clear();
                }
              }
            } catch (e) {
              warnLog(`[Chat→Responses stream] Failed to parse SSE chunk: ${e}`);
            }
          }
        }
      }
    },

    cancel() {
      reader.cancel();
    }
  });
}
