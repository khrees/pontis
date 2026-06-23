/**
 * Translates OpenAI Responses API (used by Codex CLI) requests
 * to standard OpenAI Chat Completions format.
 *
 * The Responses API is substantially different from Chat Completions:
 * - It uses `input` (array of items) instead of `messages`
 * - It has `instructions` instead of a system message
 * - Tool calls use `function_call` output items instead of `tool_calls`
 * - Streaming uses different event types (response.* instead of data: chunks)
 */

import { getModelMetadata } from "../../model-metadata";

// ---------------------------------------------------------------------------
// Responses API → Chat Completions message conversion
// ---------------------------------------------------------------------------

/**
 * Normalize a Responses API function_call_output value to a string for Chat
 * Completions tool messages.
 */
function normalizeFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "input_text" || part?.type === "text") {
          return part.text || "";
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // Codex CLI wraps tool output as { content, success? }
    if (typeof obj.content === "string") {
      return obj.content;
    }
    if (Array.isArray(obj.content_items)) {
      return normalizeFunctionCallOutput(obj.content_items);
    }
    return JSON.stringify(output);
  }
  return String(output ?? "");
}

/** Item types Codex sends in history that have no Chat Completions equivalent. */
const SKIPPED_INPUT_TYPES = new Set([
  "reasoning",
  "compaction",
  "compaction_summary",
  "context_compaction",
  "web_search_call",
  "ghost_snapshot",
  "local_shell_call",
]);

/**
 * Convert a single Responses API input item into one or more Chat Completions
 * messages.
 */
function inputItemToMessages(inputItem: any): any[] {
  const messages: any[] = [];

  if (inputItem.type && SKIPPED_INPUT_TYPES.has(inputItem.type)) {
    return [];
  }

  // Top-level Responses API items (no role) used by Codex CLI
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
          {
            id: inputItem.call_id || inputItem.id || "",
            type: "function",
            function: {
              name: inputItem.name || "",
              arguments: args,
            },
          },
        ],
      },
    ];
  }

  if (inputItem.type === "custom_tool_call") {
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: inputItem.call_id || inputItem.id || "",
            type: "function",
            function: {
              name: inputItem.name || "",
              arguments:
                typeof inputItem.input === "string"
                  ? inputItem.input
                  : JSON.stringify(inputItem.input || {}),
            },
          },
        ],
      },
    ];
  }

  if (inputItem.type === "custom_tool_call_output") {
    return [
      {
        role: "tool",
        content: inputItem.output || "",
        tool_call_id: inputItem.call_id || "",
      },
    ];
  }

  if (inputItem.type === "mcp_tool_call_output") {
    const result = inputItem.result ?? inputItem.output;
    let content = "";
    if (typeof result === "string") {
      content = result;
    } else if (result && typeof result === "object") {
      if (Array.isArray((result as any).content)) {
        content = (result as any).content
          .map((block: any) => block.text || JSON.stringify(block))
          .join("\n");
      } else {
        content = JSON.stringify(result);
      }
    }
    return [
      {
        role: "tool",
        content,
        tool_call_id: inputItem.call_id || "",
      },
    ];
  }

  if (inputItem.type === "message") {
    return inputItemToMessages({
      role: inputItem.role || "user",
      content: inputItem.content,
    });
  }

  const role = inputItem.role || "user";
  const normalizedRole = role === "developer" ? "system" : role;

  const contentParts = Array.isArray(inputItem.content) ? inputItem.content : [];
  const textParts: string[] = [];
  const toolResults: { tool_use_id: string; content: string }[] = [];
  const toolUses: { id: string; name: string; arguments: string }[] = [];

  if (typeof inputItem.content === "string") {
    textParts.push(inputItem.content);
  } else if (contentParts.length > 0) {
    for (const part of contentParts) {
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
              ? part.content.map((c: any) => c.text || "").join("\n")
              : JSON.stringify(part.content || "");
        toolResults.push({
          tool_use_id: part.tool_use_id || "",
          content: resultContent,
        });
      }
    }
  }

  if (normalizedRole === "assistant") {
    const msg: any = { role: "assistant" };
    msg.content =
      textParts.length > 0 ? textParts.join("\n").trim() || null : null;
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: "function",
        function: { name: tu.name, arguments: tu.arguments },
      }));
    }
    if (
      msg.content !== null ||
      (msg.tool_calls && msg.tool_calls.length > 0)
    ) {
      messages.push(msg);
    }
  } else if (normalizedRole === "user") {
    const text = textParts.join("\n").trim();
    if (text) {
      messages.push({ role: "user", content: text });
    }
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        content: tr.content,
        tool_call_id: tr.tool_use_id,
      });
    }
  } else {
    // tool, system, or other role — preserve as-is
    const text = textParts.join("\n").trim();
    messages.push({ role: normalizedRole, content: text || "" });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// DSML fallback prompt
// ---------------------------------------------------------------------------

function buildDsmlPrompt(tools: any[]): string {
  const toolList = tools
    .filter((t: any) => t && t.type === "function")
    .map((t: any) => {
      const name = t.name || t.function?.name || "";
      const desc = t.description || t.function?.description || "";
      return `- ${name}: ${desc}`;
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

// ---------------------------------------------------------------------------
// Tools conversion
// ---------------------------------------------------------------------------

function convertTools(reqTools: any[]): any[] {
  if (!Array.isArray(reqTools)) return [];
  return reqTools
    .filter((t: any) => t && t.type === "function")
    .map((t: any) => ({
      type: "function",
      function: {
        name: t.name || t.function?.name || "",
        description: t.description || t.function?.description,
        parameters: t.parameters || t.function?.parameters,
      },
    }));
}

// ---------------------------------------------------------------------------
// Main translation function
// ---------------------------------------------------------------------------

export interface ResponsesToChatResult {
  /** The full Chat Completions messages array. */
  messages: any[];
  /** Whether DSML fallback was injected. */
  dsmlFallbackActive: boolean;
}

/**
 * Translate a Responses API request body into a Chat Completions messages
 * array and related options.
 *
 * @param req - The raw Responses API request body.
 * @param resolvedModel - The model name (after any remapping).
 * @param previousMessages - Cached messages from a previous turn (if any).
 * @returns The translated messages and metadata.
 */
export function responsesToChatMessages(
  req: any,
  resolvedModel: string,
  previousMessages?: any[],
): ResponsesToChatResult {
  const messages: any[] = [];

  // 1. Prepend cached conversation history (from previous_response_id)
  if (previousMessages && previousMessages.length > 0) {
    for (const m of previousMessages) {
      messages.push(JSON.parse(JSON.stringify(m)));
    }
  }

  // 2. Add instructions as system message when Codex sends them separately
  // from input (skip if input already carries developer/system messages).
  const inputHasSystemMessage =
    Array.isArray(req.input) &&
    req.input.some(
      (item: any) =>
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

  // 3. Check model capability and inject DSML fallback if needed
  const modelMeta = getModelMetadata(resolvedModel);
  const hasTools =
    Array.isArray(req.tools) && req.tools.length > 0;
  const needsDsmlFallback =
    hasTools && !modelMeta.supports_structured_tool_calls;

  if (needsDsmlFallback) {
    messages.push({
      role: "system",
      content: buildDsmlPrompt(req.tools),
    });
  }

  // 4. Convert input items to messages
  if (Array.isArray(req.input)) {
    for (const inputItem of req.input) {
      const itemMessages = inputItemToMessages(inputItem);
      for (const m of itemMessages) {
        messages.push(m);
      }
    }
  }

  return {
    messages,
    dsmlFallbackActive: needsDsmlFallback,
  };
}

/**
 * Build the Chat Completions request body (partial) from a Responses API
 * request.
 */
export function buildChatRequest(
  req: any,
  resolvedModel: string,
  messages: any[],
): any {
  // Streaming mode is determined by the caller based on Accept header
  // Default to non-streaming; caller overrides as needed
  const shouldStream = req.stream === true;

  const chatReq: any = {
    model: resolvedModel,
    messages,
    stream: shouldStream,
  };

  if (shouldStream) {
    chatReq.stream_options = { include_usage: true };
  }

  // Convert tools
  if (Array.isArray(req.tools)) {
    const converted = convertTools(req.tools);
    if (converted.length > 0) {
      chatReq.tools = converted;
    }
  }

  // Forward supported parameters
  if (req.max_tokens !== undefined) chatReq.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) chatReq.temperature = req.temperature;
  if (req.top_p !== undefined) chatReq.top_p = req.top_p;

  return chatReq;
}

/**
 * Convert a Chat Completions response message into Responses API output items.
 */
export function chatResponseToOutput(
  message: any,
): { output: any[]; hasToolCalls: boolean } {
  const output: any[] = [];

  // Text content → message output
  const textContent = message.content || "";
  if (textContent) {
    output.push({
      id: "out_" + Date.now(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: textContent }],
    });
  }

  // Tool calls → function_call output items
  const toolCalls = message.tool_calls;
  let hasToolCalls = false;
  if (Array.isArray(toolCalls)) {
    hasToolCalls = toolCalls.length > 0;
    for (const tc of toolCalls) {
      const callId = tc.id || `call_${Date.now()}`;
      const argsStr =
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : "{}";
      output.push({
        id: `item_${callId}`,
        type: "function_call",
        name: tc.function?.name || "",
        call_id: callId,
        arguments: argsStr,
        status: "completed",
      });
    }
  }

  // Fallback: empty output
  if (output.length === 0) {
    output.push({
      id: "out_" + Date.now(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
    });
  }

  return { output, hasToolCalls };
}

/**
 * Extract usage from a Chat Completions response into Responses API format.
 */
export function extractUsage(chatRes: any): Record<string, number> {
  const u = chatRes.usage || {};
  const promptTokens = u.prompt_tokens || u.input_tokens || 0;
  const completionTokens = u.completion_tokens || u.output_tokens || 0;
  const totalTokens = u.total_tokens || promptTokens + completionTokens;
  const cachedRead =
    u.cache_read_input_tokens ||
    u.prompt_tokens_details?.cached_tokens ||
    u.input_tokens_details?.cached_tokens ||
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
