import type { OpenAIMessage, ResponsesOutputItem } from "./types";

/** Build a Chat Completions assistant message from Responses API output items. */
export function assistantMessageFromOutputItems(
  output: ResponsesOutputItem[],
): OpenAIMessage {
  const assistantMsg: OpenAIMessage = { role: "assistant", content: null };
  const textParts: string[] = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];

  for (const item of output) {
    if (item.type === "message") {
      const text = item.content.find((c) => c.type === "text")?.text || "";
      if (text) textParts.push(text);
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    }
  }

  if (textParts.length > 0) assistantMsg.content = textParts.join("\n");
  if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
  return assistantMsg;
}

/** Build a Chat Completions assistant message from an upstream chat response. */
export function assistantMessageFromChatMessage(message: OpenAIMessage): OpenAIMessage {
  const assistantMsg: OpenAIMessage = { role: "assistant", content: null };
  if (typeof message.content === "string") assistantMsg.content = message.content;
  if (message.tool_calls && message.tool_calls.length > 0) {
    assistantMsg.tool_calls = message.tool_calls;
  }
  return assistantMsg;
}
