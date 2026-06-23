/**
 * Translates OpenAI Responses API requests (Codex CLI) to Chat Completions.
 */

import { getModelMetadata } from "../../model-metadata";
import type {
  OpenAIMessage,
  OpenAIRequest,
  OpenAIUsage,
  OpenAITool,
  OpenAIToolCall,
  ResponseContentPart,
  ResponseInputItem,
  ResponsesApiRequest,
  ResponsesApiTool,
  ResponsesApiUsage,
  ResponsesOutputItem,
} from "../../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContentPart(
  part: unknown,
): part is { type: string; text?: string } {
  return (
    isRecord(part) &&
    (part.type === "input_text" || part.type === "text" || part.type === "output_text")
  );
}

function normalizeFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === "string") return part;
        if (isTextContentPart(part)) return part.text || "";
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (isRecord(output)) {
    if (typeof output.content === "string") return output.content;
    if (Array.isArray(output.content_items)) {
      return normalizeFunctionCallOutput(output.content_items);
    }
    return JSON.stringify(output);
  }
  return String(output ?? "");
}

function extractMcpResultContent(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result) && Array.isArray(result.content)) {
    return result.content
      .map((block: unknown) => {
        if (isRecord(block) && typeof block.text === "string") return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (isRecord(result)) return JSON.stringify(result);
  return "";
}

const SKIPPED_INPUT_TYPES = new Set([
  "reasoning",
  "compaction",
  "compaction_summary",
  "context_compaction",
  "web_search_call",
  "ghost_snapshot",
  "local_shell_call",
]);

function normalizeRole(role: string): OpenAIMessage["role"] {
  if (role === "developer") return "system";
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

function makeToolCall(
  id: string,
  name: string,
  args: string,
): OpenAIToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  };
}

function inputItemToMessages(inputItem: ResponseInputItem): OpenAIMessage[] {
  if (inputItem.type && SKIPPED_INPUT_TYPES.has(inputItem.type)) {
    return [];
  }

  if (inputItem.type === "function_call_output") {
    return [
      {
        role: "tool",
        content: normalizeFunctionCallOutput(inputItem.output),
        tool_call_id: inputItem.call_id || "",
      },
    ];
  }

  if (inputItem.type === "function_call") {
    const args =
      typeof inputItem.arguments === "string"
        ? inputItem.arguments
        : JSON.stringify(inputItem.arguments || {});
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          makeToolCall(
            inputItem.call_id || inputItem.id || "",
            inputItem.name || "",
            args,
          ),
        ],
      },
    ];
  }

  if (inputItem.type === "custom_tool_call") {
    const args =
      typeof inputItem.input === "string"
        ? inputItem.input
        : JSON.stringify(inputItem.input || {});
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          makeToolCall(
            inputItem.call_id || inputItem.id || "",
            inputItem.name || "",
            args,
          ),
        ],
      },
    ];
  }

  if (inputItem.type === "custom_tool_call_output") {
    return [
      {
        role: "tool",
        content: typeof inputItem.output === "string" ? inputItem.output : "",
        tool_call_id: inputItem.call_id || "",
      },
    ];
  }

  if (inputItem.type === "mcp_tool_call_output") {
    return [
      {
        role: "tool",
        content: extractMcpResultContent(inputItem.result ?? inputItem.output),
        tool_call_id: inputItem.call_id || "",
      },
    ];
  }

  if (inputItem.type === "message") {
    const reasoning = inputItem.reasoning_content || (inputItem as any).reasoning;
    return inputItemToMessages({
      role: inputItem.role || "user",
      content: inputItem.content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
  }

  const role = inputItem.role || "user";
  const normalizedRole = normalizeRole(role);
  const contentParts = Array.isArray(inputItem.content) ? inputItem.content : [];
  const textParts: string[] = [];
  const toolResults: { tool_use_id: string; content: string }[] = [];
  const toolUses: { id: string; name: string; arguments: string }[] = [];

  if (typeof inputItem.content === "string") {
    textParts.push(inputItem.content);
  } else if (contentParts.length > 0) {
    for (const part of contentParts as ResponseContentPart[]) {
      if (
        part.type === "input_text" ||
        part.type === "text" ||
        part.type === "output_text"
      ) {
        textParts.push(part.text || "");
      } else if (part.type === "tool_use") {
        toolUses.push({
          id: part.id || "",
          name: part.name || "",
          arguments:
            typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input || {}),
        });
      } else if (part.type === "tool_result") {
        const resultContent =
          typeof part.content === "string"
            ? part.content
            : Array.isArray(part.content)
              ? part.content.map((c) => c.text || "").join("\n")
              : JSON.stringify(part.content || "");
        toolResults.push({
          tool_use_id: part.tool_use_id || "",
          content: resultContent,
        });
      }
    }
  }

  if (normalizedRole === "assistant") {
    const msg: OpenAIMessage = {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n").trim() || null : null,
    };
    const reasoning = inputItem.reasoning_content || (inputItem as any).reasoning;
    if (reasoning) {
      msg.reasoning_content = reasoning;
      (msg as any).reasoning = reasoning;
    }
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((tu) =>
        makeToolCall(tu.id, tu.name, tu.arguments),
      );
    }
    if (msg.content !== null || msg.reasoning_content || (msg as any).reasoning || (msg.tool_calls && msg.tool_calls.length > 0)) {
      return [msg];
    }
    return [];
  }

  if (normalizedRole === "user") {
    const messages: OpenAIMessage[] = [];
    const text = textParts.join("\n").trim();
    if (text) messages.push({ role: "user", content: text });
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: tr.content,
        tool_call_id: tr.tool_use_id,
      });
    }
    return messages;
  }

  const text = textParts.join("\n").trim();
  return [{ role: normalizedRole, content: text || "" }];
}

function buildDsmlPrompt(tools: ResponsesApiTool[]): string {
  const toolList = tools
    .filter((t) => t && t.type === "function")
    .map((t) => {
      const name = t.name || t.function?.name || "";
      const desc = t.description || t.function?.description || "";
      const safeName = name.replace(/[\r\n]+/g, " ").slice(0, 128);
      const safeDesc = desc.replace(/[\r\n]+/g, " ").slice(0, 500);
      return `- ${safeName}: ${safeDesc}`;
    })
    .join("\n");

  return (
    `You have access to the following tools:\n${toolList}\n\n` +
    `When you need to use a tool, output your tool calls using DSML format:\n` +
    `<||DSML||tool_calls>\n` +
    `<||DSML||invoke name="tool_name">\n` +
    `<||DSML||parameter name="param1">value1</||DSML||parameter>\n` +
    `</||DSML||invoke>\n` +
    `</||DSML||tool_calls>`
  );
}

function convertTools(reqTools: ResponsesApiTool[]): OpenAITool[] {
  return reqTools
    .filter((t) => t && t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name || t.function?.name || "",
        description: t.description || t.function?.description,
        parameters: t.parameters || t.function?.parameters,
      },
    }));
}

export function mergeConsecutiveMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length === 0) return [];
  const merged: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (merged.length === 0) {
      merged.push({ ...msg });
      continue;
    }

    const last = merged[merged.length - 1];
    if (last.role === msg.role && msg.role !== "tool") {
      if (last.role === "assistant") {
        if (msg.content) {
          if (last.content) {
            last.content = `${last.content}\n${msg.content}`;
          } else {
            last.content = msg.content;
          }
        }
        const lastReasoning = last.reasoning_content || (last as any).reasoning;
        const msgReasoning = msg.reasoning_content || (msg as any).reasoning;
        if (msgReasoning) {
          if (lastReasoning) {
            const combined = `${lastReasoning}\n${msgReasoning}`;
            last.reasoning_content = combined;
            (last as any).reasoning = combined;
          } else {
            last.reasoning_content = msgReasoning;
            (last as any).reasoning = msgReasoning;
          }
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
      } else if (last.role === "user") {
        if (msg.content) {
          if (typeof last.content === "string" && typeof msg.content === "string") {
            last.content = `${last.content}\n${msg.content}`;
          } else {
            const lastParts = typeof last.content === "string"
              ? [{ type: "text" as const, text: last.content }]
              : last.content || [];
            const msgParts = typeof msg.content === "string"
              ? [{ type: "text" as const, text: msg.content }]
              : msg.content || [];
            last.content = [...lastParts, ...msgParts];
          }
        }
      } else if (last.role === "system" || last.role === "developer") {
        if (msg.content) {
          if (last.content) {
            last.content = `${last.content}\n${msg.content}`;
          } else {
            last.content = msg.content;
          }
        }
      } else {
        merged.push({ ...msg });
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

export interface ResponsesToChatResult {
  messages: OpenAIMessage[];
}

export function responsesToChatMessages(
  req: ResponsesApiRequest,
  resolvedModel: string,
  previousMessages?: OpenAIMessage[],
): ResponsesToChatResult {
  const messages: OpenAIMessage[] = [];

  if (previousMessages && previousMessages.length > 0) {
    for (const m of previousMessages) {
      messages.push(JSON.parse(JSON.stringify(m)) as OpenAIMessage);
    }
  }

  const inputHasSystemMessage =
    Array.isArray(req.input) &&
    req.input.some(
      (item) =>
        item.role === "developer" ||
        item.role === "system" ||
        (item.type === "message" &&
          (item.role === "developer" || item.role === "system")),
    );

  if (
    req.instructions &&
    (!previousMessages || previousMessages.length === 0) &&
    !inputHasSystemMessage
  ) {
    messages.push({ role: "system", content: req.instructions });
  }

  const modelMeta = getModelMetadata(resolvedModel);
  const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
  const needsDsmlFallback =
    hasTools && !modelMeta.supports_structured_tool_calls;

  if (needsDsmlFallback && req.tools) {
    messages.push({
      role: "system",
      content: buildDsmlPrompt(req.tools),
    });
  }

  if (Array.isArray(req.input)) {
    for (const inputItem of req.input) {
      for (const m of inputItemToMessages(inputItem)) {
        messages.push(m);
      }
    }
  }

  return { messages: mergeConsecutiveMessages(messages) };
}

export function buildChatRequest(
  req: ResponsesApiRequest,
  resolvedModel: string,
  messages: OpenAIMessage[],
): OpenAIRequest {
  const shouldStream = req.stream === true;
  const chatReq: OpenAIRequest = {
    model: resolvedModel,
    messages,
    stream: shouldStream,
  };

  if (shouldStream) {
    chatReq.stream_options = { include_usage: true };
  }

  if (Array.isArray(req.tools)) {
    const converted = convertTools(req.tools);
    if (converted.length > 0) chatReq.tools = converted;
  }

  if (req.max_tokens !== undefined) chatReq.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) chatReq.temperature = req.temperature;
  if (req.top_p !== undefined) chatReq.top_p = req.top_p;

  return chatReq;
}

export function chatResponseToOutput(message: Partial<OpenAIMessage>): {
  output: ResponsesOutputItem[];
} {
  const output: ResponsesOutputItem[] = [];
  const textContent =
    typeof message.content === "string" ? message.content : "";

  if (textContent || message.reasoning_content) {
    output.push({
      id: "out_" + Date.now(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: textContent }],
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const callId = tc.id || `call_${Date.now()}`;
      output.push({
        id: `item_${callId}`,
        type: "function_call",
        name: tc.function?.name || "",
        call_id: callId,
        arguments: tc.function?.arguments || "{}",
        status: "completed",
      });
    }
  }

  if (output.length === 0) {
    output.push({
      id: "out_" + Date.now(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
  }

  return { output };
}

export function extractUsage(chatRes: {
  usage?: Partial<OpenAIUsage>;
}): ResponsesApiUsage {
  const u = chatRes.usage;
  const promptTokens = u?.prompt_tokens || u?.input_tokens || 0;
  const completionTokens = u?.completion_tokens || u?.output_tokens || 0;
  const totalTokens = u?.total_tokens || promptTokens + completionTokens;
  const cachedRead =
    u?.cache_read_input_tokens ||
    u?.prompt_tokens_details?.cached_tokens ||
    u?.input_tokens_details?.cached_tokens ||
    0;

  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cache_read_input_tokens: cachedRead,
    cache_creation_input_tokens: 0,
  };
}
