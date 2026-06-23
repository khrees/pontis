export function streamChatToResponses(chatStream: ReadableStream<Uint8Array>, originalModel: string, previousResponseId?: string): ReadableStream<Uint8Array> {
  const reader = chatStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasStreamedReasoning = false;
  let fullText = "";

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

  const responseId = "resp_" + Date.now();
  let itemId = "out_" + Date.now();

  let pendingText = "";
  let inDsml = false;
  let toolCallCount = 0;
  let accumulatedUsage: any = null;
  const completedOutputs: any[] = [];

  function ensureTextItem(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!textItemStarted) {
      enqueueSSE(controller, "response.output_item.added", {
        type: "response.output_item.added",
        response_id: responseId,
        output_index: 0,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          content: []
        }
      });
      textItemStarted = true;
    }
    if (!textContentStarted) {
      enqueueSSE(controller, "response.content_part.added", {
        type: "response.content_part.added",
        response_id: responseId,
        item_id: itemId,
        part: {
          type: "text",
          text: ""
        }
      });
      textContentStarted = true;
    }
  }

  function processTextDelta(text: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    pendingText += text;

    let searchAgain = true;
    while (searchAgain) {
      searchAgain = false;

      if (!inDsml) {
        // Look for the start of a DSML block
        const startRegex = /<[|｜]{2}DSML[|｜]{2}tool_calls>/i;
        const startMatch = pendingText.match(startRegex);

        if (startMatch) {
          const startIndex = startMatch.index!;
          // 1. Flush any text before the DSML block starts
          const textBefore = pendingText.slice(0, startIndex);
          if (textBefore) {
            ensureTextItem(controller);
            fullText += textBefore;
            enqueueSSE(controller, "response.output_text.delta", {
              type: "response.output_text.delta",
              response_id: responseId,
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: textBefore
            });
          }
          closeTextItem(controller);

          // 2. Remove the start tag and everything before it
          pendingText = pendingText.slice(startIndex + startMatch[0].length);
          inDsml = true;
          searchAgain = true;
        } else {
          // If start tag is not found, we want to stream text, but we must
          // avoid flushing a partial tag if it's currently at the end of the buffer.
          const matchStart = "<｜｜DSML｜｜tool_calls>";
          const matchStartAlt = "<||DSML||tool_calls>";

          let potentialPrefix = false;
          for (let i = 1; i <= 30; i++) {
            if (pendingText.length < i) break;
            const endSlice = pendingText.slice(-i);
            if (matchStart.startsWith(endSlice) || matchStartAlt.startsWith(endSlice)) {
              potentialPrefix = true;
              break;
            }
          }

          if (potentialPrefix) {
            if (pendingText.length > 30) {
              const toFlush = pendingText.slice(0, -30);
              pendingText = pendingText.slice(-30);
              if (toFlush) {
                ensureTextItem(controller);
                fullText += toFlush;
                enqueueSSE(controller, "response.output_text.delta", {
                  type: "response.output_text.delta",
                  response_id: responseId,
                  item_id: itemId,
                  output_index: 0,
                  content_index: 0,
                  delta: toFlush
                });
              }
            }
          } else {
            if (pendingText) {
              ensureTextItem(controller);
              fullText += pendingText;
              enqueueSSE(controller, "response.output_text.delta", {
                type: "response.output_text.delta",
                response_id: responseId,
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta: pendingText
              });
              pendingText = "";
            }
          }
        }
      } else {
        // Inside DSML block — look for complete invoke blocks
        const invokeRegex = /<[|｜]{2}DSML[|｜]{2}invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}invoke\s*>/i;
        const invokeMatch = pendingText.match(invokeRegex);

        if (invokeMatch) {
          const toolName = invokeMatch[1];
          const innerContent = invokeMatch[2];
          const matchedString = invokeMatch[0];
          const matchIndex = invokeMatch.index!;

          // Parse parameters inside the invoke block
          const args: Record<string, string> = {};
          const paramRegex = /<[|｜]{2}DSML[|｜]{2}parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}parameter\s*>/gi;
          let paramMatch;
          while ((paramMatch = paramRegex.exec(innerContent)) !== null) {
            args[paramMatch[1]] = paramMatch[2].trim();
          }

          const callId = "call_" + Math.random().toString(36).substring(2, 15);
          const toolItemId = "item_" + callId;
          const argsStr = JSON.stringify(args);
          toolCallCount++;

          enqueueSSE(controller, "response.output_item.added", {
            type: "response.output_item.added",
            response_id: responseId,
            output_index: toolCallCount,
            item: {
              id: toolItemId,
              type: "function_call",
              name: toolName,
              call_id: callId,
              arguments: ""
            }
          });

          enqueueSSE(controller, "response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            item_id: toolItemId,
            output_index: toolCallCount,
            call_id: callId,
            delta: argsStr
          });

          enqueueSSE(controller, "response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            response_id: responseId,
            item_id: toolItemId,
            output_index: toolCallCount,
            call_id: callId,
            arguments: argsStr
          });

          enqueueSSE(controller, "response.output_item.done", {
            type: "response.output_item.done",
            response_id: responseId,
            item: {
              id: toolItemId,
              type: "function_call",
              name: toolName,
              call_id: callId,
              arguments: argsStr
            }
          });

          // Remove the matched invoke block from pendingText
          pendingText = pendingText.slice(0, matchIndex) + pendingText.slice(matchIndex + matchedString.length);
          searchAgain = true;
        } else {
          // Check if the DSML block has closed
          const endRegex = /<\/[|｜]{2}DSML[|｜]{2}tool_calls>/i;
          const endMatch = pendingText.match(endRegex);

          if (endMatch) {
            const endIndex = endMatch.index!;
            pendingText = pendingText.slice(endIndex + endMatch[0].length);
            inDsml = false;
            searchAgain = true;
          }
        }
      }
    }
  }

  function closeTextItem(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (textContentStarted) {
      enqueueSSE(controller, "response.output_text.done", {
        type: "response.output_text.done",
        response_id: responseId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: fullText
      });

      enqueueSSE(controller, "response.content_part.done", {
        type: "response.content_part.done",
        response_id: responseId,
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
        response_id: responseId,
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
        content: [{ type: "text", text: fullText }]
      });
      textItemStarted = false;
      textContentStarted = false;
      fullText = "";
      itemId = "out_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    }
  }

  function finalizeToolCalls(controller: ReadableStreamDefaultController<Uint8Array>) {
    for (const [idx, activeTc] of activeToolCalls.entries()) {
      enqueueSSE(controller, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        response_id: responseId,
        item_id: activeTc.itemId,
        output_index: idx + 1,
        call_id: activeTc.id,
        arguments: activeTc.arguments
      });

      enqueueSSE(controller, "response.output_item.done", {
        type: "response.output_item.done",
        response_id: responseId,
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
          id: responseId,
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
          if (inDsml) {
            // Process any complete invoke blocks from pendingText
            const invokeRegex = /<[|｜]{2}DSML[|｜]{2}invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}invoke\s*>/i;
            let invokeMatch = pendingText.match(invokeRegex);
            while (invokeMatch) {
              const toolName = invokeMatch[1];
              const innerContent = invokeMatch[2];
              const matchedString = invokeMatch[0];
              const matchIndex = invokeMatch.index!;

              const args: Record<string, string> = {};
              const paramRegex = /<[|｜]{2}DSML[|｜]{2}parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}parameter\s*>/gi;
              let paramMatch;
              while ((paramMatch = paramRegex.exec(innerContent)) !== null) {
                args[paramMatch[1]] = paramMatch[2].trim();
              }

              const callId = "call_" + Math.random().toString(36).substring(2, 15);
              const toolItemId = "item_" + callId;
              const argsStr = JSON.stringify(args);
              toolCallCount++;

              enqueueSSE(controller, "response.output_item.added", {
                type: "response.output_item.added",
                response_id: responseId,
                output_index: toolCallCount,
                item: {
                  id: toolItemId,
                  type: "function_call",
                  name: toolName,
                  call_id: callId,
                  arguments: ""
                }
              });

              enqueueSSE(controller, "response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                response_id: responseId,
                item_id: toolItemId,
                output_index: toolCallCount,
                call_id: callId,
                delta: argsStr
              });

              enqueueSSE(controller, "response.function_call_arguments.done", {
                type: "response.function_call_arguments.done",
                response_id: responseId,
                item_id: toolItemId,
                output_index: toolCallCount,
                call_id: callId,
                arguments: argsStr
              });

              enqueueSSE(controller, "response.output_item.done", {
                type: "response.output_item.done",
                response_id: responseId,
                item: {
                  id: toolItemId,
                  type: "function_call",
                  name: toolName,
                  call_id: callId,
                  arguments: argsStr
                }
              });

              // Track DSML tool call for response.completed
              completedOutputs.push({
                id: toolItemId,
                type: "function_call",
                name: toolName,
                call_id: callId,
                arguments: argsStr,
                status: "completed"
              });

              pendingText = pendingText.slice(0, matchIndex) + pendingText.slice(matchIndex + matchedString.length);
              invokeMatch = pendingText.match(invokeRegex);
            }
            inDsml = false;
          }

          // Flush any final normal text left in pendingText
          if (pendingText) {
            ensureTextItem(controller);
            fullText += pendingText;
            enqueueSSE(controller, "response.output_text.delta", {
              type: "response.output_text.delta",
              response_id: responseId,
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: pendingText
            });
            pendingText = "";
          }

          if (hasStreamedReasoning) {
            enqueueSSE(controller, "response.reasoning_text.done", {
              type: "response.reasoning_text.done",
              response_id: responseId,
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

          const u = accumulatedUsage || {};
          const promptTokens = u.prompt_tokens || u.input_tokens || 0;
          const completionTokens = u.completion_tokens || u.output_tokens || 0;
          const totalTokens = u.total_tokens || (promptTokens + completionTokens);
          const cachedRead = u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || u.input_tokens_details?.cached_tokens || 0;

          // event: response.completed
          enqueueSSE(controller, "response.completed", {
            type: "response.completed",
            response: {
              id: responseId,
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

          controller.close();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
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
                  if (delta.reasoning_content) {
                    hasStreamedReasoning = true;
                    enqueueSSE(controller, "response.reasoning_text.delta", {
                      type: "response.reasoning_text.delta",
                      response_id: responseId,
                      item_id: itemId,
                      output_index: 0,
                      content_index: 0,
                      delta: delta.reasoning_content
                    });
                  }

                  // Stream standard text content if present
                  if (delta.content) {
                    if (hasStreamedReasoning) {
                      enqueueSSE(controller, "response.reasoning_text.done", {
                        type: "response.reasoning_text.done",
                        response_id: responseId,
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
                          response_id: responseId,
                          output_index: idx + 1,
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
                          response_id: responseId,
                          item_id: activeTc.itemId,
                          output_index: idx + 1,
                          call_id: activeTc.id,
                          delta: argDelta
                        });
                      }
                    }
                  }
                }
              }
            } catch (e) {
              // Ignore invalid JSON lines
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
