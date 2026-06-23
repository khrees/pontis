import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  responsesToChatMessages,
  buildChatRequest,
  chatResponseToOutput,
  extractUsage,
} from "../src/translate/request/responses-to-chat";
import { ResponsesCache } from "../src/responses-cache";
import type { CodexModelsListResponse, OpenAIMessage } from "../src/types";
import {
  emptyResponsesUsage,
  isFunctionCallOutput,
  isMessageOutput,
  parseCapturedBody,
  parseResponsesJson,
  asResponseCompletedEvent,
} from "./helpers";

// =============================================================================
// ResponsesCache
// =============================================================================

describe("ResponsesCache", () => {
  beforeEach(() => {
    // Create a fresh cache for each test (small TTL so stale eviction can be tested)
  });

  it("stores and retrieves entries", () => {
    const cache = new ResponsesCache(10);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "mimo-v2.5-free",
      originalModel: "gpt-4",
      fullMessages: [{ role: "user", content: "hi" }],
      usage: emptyResponsesUsage({ input_tokens: 10, output_tokens: 5 }),
    });
    const entry = cache.get("resp_1");
    expect(entry).toBeDefined();
    expect(entry!.responseId).toBe("resp_1");
    expect(entry!.fullMessages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("returns undefined for unknown keys", () => {
    const cache = new ResponsesCache(10);
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("evicts stale entries past TTL", async () => {
    const cache = new ResponsesCache(10, 10); // 10ms TTL
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("resp_1")).toBeUndefined();
  });

  it("evicts oldest entries when at capacity (LRU)", () => {
    const cache = new ResponsesCache(2, 60000);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_2", {
      responseId: "resp_2",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_3", {
      responseId: "resp_3",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    // resp_1 should be evicted
    expect(cache.get("resp_1")).toBeUndefined();
    expect(cache.get("resp_2")).toBeDefined();
    expect(cache.get("resp_3")).toBeDefined();
  });

  it("promotes entries to front on access (LRU)", () => {
    const cache = new ResponsesCache(2, 60000);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_2", {
      responseId: "resp_2",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    // Access resp_1, making it recently used
    cache.get("resp_1");
    // Now inserting resp_3 should evict resp_2 (not resp_1)
    cache.set("resp_3", {
      responseId: "resp_3",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    expect(cache.get("resp_1")).toBeDefined();
    expect(cache.get("resp_2")).toBeUndefined();
    expect(cache.get("resp_3")).toBeDefined();
  });

  it("lists keys from newest to oldest", () => {
    const cache = new ResponsesCache(10, 60000);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    cache.set("resp_2", {
      responseId: "resp_2",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    const keys = cache.keys();
    expect(keys[0]).toBe("resp_2");
    expect(keys[1]).toBe("resp_1");
  });

  it("reports correct size", () => {
    const cache = new ResponsesCache(10);
    expect(cache.size).toBe(0);
    cache.set("resp_1", {
      responseId: "resp_1",
      model: "test",
      originalModel: "test",
      fullMessages: [],
      usage: emptyResponsesUsage(),
    });
    expect(cache.size).toBe(1);
  });
});

// =============================================================================
// responsesToChatMessages
// =============================================================================

describe("responsesToChatMessages", () => {
  it("converts input_text items to user messages", () => {
    const result = responsesToChatMessages(
      {
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("handles string content", () => {
    const result = responsesToChatMessages(
      {
        input: [{ role: "user", content: "Hello" }],
      },
      "big-pickle",
    );
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts instructions to system message", () => {
    const result = responsesToChatMessages(
      {
        instructions: "Be helpful.",
        input: [{ role: "user", content: "Hi" }],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages[0]).toEqual({ role: "system", content: "Be helpful." });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts assistant messages with tool_use content", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check that file." },
              {
                type: "tool_use",
                id: "call_123",
                name: "read_file",
                input: { path: "/test.txt" },
              },
            ],
          },
        ],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBe("Let me check that file.");
    expect(result.messages[0].tool_calls).toHaveLength(1);
    const toolCall = result.messages[0].tool_calls![0];
    expect(toolCall.id).toBe("call_123");
    expect(toolCall.function.name).toBe("read_file");
  });

  it("converts tool_result items to tool role messages", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_123",
                content: "File contents here",
              },
            ],
          },
        ],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].content).toBe("File contents here");
    expect(result.messages[0].tool_call_id).toBe("call_123");
  });

  it("extracts content from Codex function_call_output payload objects", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_exec_1",
            output: {
              content: "{\n  \"name\": \"pontis\",\n  \"version\": \"1.0.0\"\n}",
              success: true,
            },
          },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages[0].content).toContain('"name": "pontis"');
    expect(result.messages[0].tool_call_id).toBe("call_exec_1");
  });

  it("skips compaction and reasoning items", () => {
    const result = responsesToChatMessages(
      {
        input: [
          { type: "reasoning", id: "r1", summary: [] },
          { type: "context_compaction", encrypted_content: "abc" },
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("does not duplicate instructions when input has developer message", () => {
    const result = responsesToChatMessages(
      {
        instructions: "You are Codex.",
        input: [
          {
            role: "developer",
            content: [{ type: "input_text", text: "You are Codex." }],
          },
          { role: "user", content: [{ type: "input_text", text: "Hi" }] },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(result.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts a realistic Codex tool loop input sequence", () => {
    const result = responsesToChatMessages(
      {
        input: [
          { role: "user", content: [{ type: "input_text", text: "summarize repo" }] },
          {
            type: "function_call",
            call_id: "call_1",
            name: "exec_command",
            arguments: '{"cmd":"ls -la"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: { content: "total 128\nsrc test", success: true },
          },
          {
            type: "function_call",
            call_id: "call_2",
            name: "exec_command",
            arguments: '{"cmd":"cat README.md"}',
          },
          {
            type: "function_call_output",
            call_id: "call_2",
            output: { content: "# Pontis", success: true },
          },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0].content).toBe("summarize repo");
    expect(result.messages[1].tool_calls![0].function.name).toBe("exec_command");
    expect(result.messages[2].content).toContain("total 128");
    expect(result.messages[4].content).toBe("# Pontis");
  });

  it("converts function_call_output items to tool role messages", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_abc",
            output: "total 128\ndrwxr-xr-x src",
          },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages).toEqual([
      {
        role: "tool",
        content: "total 128\ndrwxr-xr-x src",
        tool_call_id: "call_abc",
      },
    ]);
  });

  it("converts function_call_output with array output to tool messages", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_xyz",
            output: [{ type: "input_text", text: "README contents" }],
          },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: "README contents",
      tool_call_id: "call_xyz",
    });
  });

  it("converts function_call items to assistant tool_calls messages", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "Read",
            arguments: '{"path":"package.json"}',
          },
        ],
      },
      "deepseek-v4-flash-free",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].tool_calls![0].id).toBe("call_1");
    expect(result.messages[0].tool_calls![0].function.name).toBe("Read");
  });

  it("preserves tool results on follow-up turns via cache", () => {
    const prevMessages: OpenAIMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Summarize this repo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: '{"path":"README.md"}' },
          },
        ],
      },
    ];
    const result = responsesToChatMessages(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "# Pontis\nA proxy bridge...",
          },
        ],
      },
      "deepseek-v4-flash-free",
      prevMessages,
    );
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toEqual({
      role: "tool",
      content: "# Pontis\nA proxy bridge...",
      tool_call_id: "call_1",
    });
  });

  it("does not re-add instructions when continuing a cached conversation", () => {
    const prevMessages: OpenAIMessage[] = [
      { role: "system", content: "Original instructions" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const result = responsesToChatMessages(
      {
        instructions: "Original instructions",
        input: [{ role: "user", content: "What's up?" }],
      },
      "mimo-v2.5-free",
      prevMessages,
    );
    expect(result.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(result.messages[0].content).toBe("Original instructions");
  });

  it("preserves conversation from cache", () => {
    const prevMessages: OpenAIMessage[] = [
      { role: "user", content: "What files exist?" },
      { role: "assistant", content: "Let me check.", tool_calls: [] },
    ];
    const result = responsesToChatMessages(
      {
        input: [{ role: "user", content: "Show me the second one." }],
      },
      "mimo-v2.5-free",
      prevMessages,
    );
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe("What files exist?");
    expect(result.messages[1].content).toBe("Let me check.");
    expect(result.messages[2].content).toBe("Show me the second one.");
  });

  it("deduplicates cached messages from the previous turn", () => {
    // When the cache and the current input both start with the same user message,
    // we should not duplicate it.
    const prevMessages: OpenAIMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    // Current input starts with a new user message, not the previous one
    const result = responsesToChatMessages(
      {
        input: [{ role: "user", content: "How are you?" }],
      },
      "mimo-v2.5-free",
      prevMessages,
    );
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe("Hi");
    expect(result.messages[2].content).toBe("How are you?");
  });

  it("does not inject DSML fallback for models with structured tool calls", () => {
    const result = responsesToChatMessages(
      {
        tools: [
          { type: "function", name: "read_file", description: "Read a file" },
        ],
        input: [{ role: "user", content: "Read file" }],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Read file" });
  });

  it("handles developer role as system", () => {
    const result = responsesToChatMessages(
      {
        input: [{ role: "developer", content: "You are a helpful assistant." }],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("handles empty input array", () => {
    const result = responsesToChatMessages(
      {
        input: [],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toEqual([]);
  });

  it("handles missing input field", () => {
    const result = responsesToChatMessages({}, "mimo-v2.5-free");
    expect(result.messages).toEqual([]);
  });

  it("handles tool_use with string input", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "bash",
                input: '{"command": "ls"}',
              },
            ],
          },
        ],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages[0].tool_calls![0].function.arguments).toBe(
      '{"command": "ls"}',
    );
  });

  it("handles tool_result with array content", () => {
    const result = responsesToChatMessages(
      {
        input: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [
                  { type: "text", text: "line1" },
                  { type: "text", text: "line2" },
                ],
              },
            ],
          },
        ],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages[0].content).toBe("line1\nline2");
  });

  it("handles tool, system, and other roles passthrough", () => {
    const result = responsesToChatMessages(
      {
        input: [
          { role: "tool", content: "tool content" },
          { role: "system", content: "system instruction" },
        ],
      },
      "mimo-v2.5-free",
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[1].role).toBe("system");
  });
});

// =============================================================================
// buildChatRequest
// =============================================================================

describe("buildChatRequest", () => {
  it("builds a basic chat request", () => {
    const req = buildChatRequest(
      { stream: false },
      "mimo-v2.5-free",
      [{ role: "user", content: "Hi" }],
    );
    expect(req.model).toBe("mimo-v2.5-free");
    expect(req.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(req.stream).toBe(false);
  });

  it("converts tools from Responses API format", () => {
    const req = buildChatRequest(
      {
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
      "mimo-v2.5-free",
      [],
    );
    expect(req.tools).toHaveLength(1);
    expect(req.tools![0].type).toBe("function");
    expect(req.tools![0].function.name).toBe("read_file");
  });

  it("handles legacy tools format (with function wrapper)", () => {
    const req = buildChatRequest(
      {
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a command",
            },
          },
        ],
      },
      "mimo-v2.5-free",
      [],
    );
    expect(req.tools).toHaveLength(1);
    expect(req.tools![0].function.name).toBe("bash");
  });

  it("forwards max_tokens and temperature", () => {
    const req = buildChatRequest(
      { max_tokens: 4096, temperature: 0.7 },
      "mimo-v2.5-free",
      [],
    );
    expect(req.max_tokens).toBe(4096);
    expect(req.temperature).toBe(0.7);
  });

  it("adds stream_options when streaming", () => {
    const req = buildChatRequest(
      { stream: true },
      "mimo-v2.5-free",
      [],
    );
    expect(req.stream).toBe(true);
    expect(req.stream_options).toEqual({ include_usage: true });
  });
});

// =============================================================================
// chatResponseToOutput
// =============================================================================

describe("chatResponseToOutput", () => {
  it("converts text content to message output", () => {
    const { output } = chatResponseToOutput({ content: "Hello!" });
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("message");
    const message = output[0];
    expect(isMessageOutput(message)).toBe(true);
    if (isMessageOutput(message)) {
      expect(message.content[0].text).toBe("Hello!");
    }
  });

  it("converts tool_calls to function_call outputs", () => {
    const { output } = chatResponseToOutput({
      content: "Let me check.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/test.txt"}' },
        },
      ],
    });
    expect(output).toHaveLength(2);
    expect(output[0].type).toBe("message");
    expect(output[1].type).toBe("function_call");
    const fnCall = output[1];
    expect(isFunctionCallOutput(fnCall)).toBe(true);
    if (isFunctionCallOutput(fnCall)) {
      expect(fnCall.name).toBe("read_file");
      expect(fnCall.call_id).toBe("call_1");
      expect(fnCall.arguments).toBe('{"path":"/test.txt"}');
    }
  });

  it("returns fallback empty output for empty message", () => {
    const { output } = chatResponseToOutput({});
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("message");
    const message = output[0];
    expect(isMessageOutput(message)).toBe(true);
    if (isMessageOutput(message)) {
      expect(message.content[0].text).toBe("");
    }
  });

  it("handles tool_calls without explicit content", () => {
    const { output } = chatResponseToOutput({
      tool_calls: [
        {
          id: "call_2",
          type: "function",
          function: { name: "bash", arguments: '{"cmd":"ls"}' },
        },
      ],
    });
    // No text content = no message output, only the tool call
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("function_call");
    const fnCall = output[0];
    expect(isFunctionCallOutput(fnCall)).toBe(true);
    if (isFunctionCallOutput(fnCall)) {
      expect(fnCall.status).toBe("completed");
    }
  });
});

// =============================================================================
// extractUsage
// =============================================================================

describe("extractUsage", () => {
  it("extracts usage from a standard chat response", () => {
    const usage = extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(20);
    expect(usage.total_tokens).toBe(30);
  });

  it("handles usage with different key names", () => {
    const usage = extractUsage({
      usage: { input_tokens: 15, output_tokens: 25 },
    });
    expect(usage.input_tokens).toBe(15);
    expect(usage.output_tokens).toBe(25);
    // total_tokens falls back to sum
    expect(usage.total_tokens).toBe(40);
  });

  it("extracts cached tokens from prompt_tokens_details", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });
    expect(usage.cache_read_input_tokens).toBe(30);
  });

  it("extracts cached tokens from input_tokens_details", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 20 },
      },
    });
    expect(usage.cache_read_input_tokens).toBe(20);
  });

  it("returns zeros for missing usage", () => {
    const usage = extractUsage({});
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
  });
});

// =============================================================================
// Streaming Responses API — event ordering
// =============================================================================

describe("Responses API streaming events", () => {
  it("emits response.created first, then text deltas, then response.completed", async () => {
    // Create a Chat Completions stream that emits chunks
    const encoder = new TextEncoder();
    const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    const chatStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse({ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }));
        controller.enqueue(sse({
          choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const { streamChatToResponses } = await import(
      "../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "mimo-v2.5-free");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      // Extract event type from each SSE frame
      for (const line of text.split("\n")) {
        if (line.startsWith("event: ")) {
          events.push(line.slice(7).trim());
        }
      }
    }

    expect(events[0]).toBe("response.created");
    expect(events).toContain("response.output_item.added");
    expect(events).toContain("response.content_part.added");
    expect(events).toContain("response.output_text.delta");
    expect(events).toContain("response.output_text.done");
    expect(events).toContain("response.content_part.done");
    expect(events).toContain("response.output_item.done");
    expect(events[events.length - 1]).toBe("response.completed");
  });

  it("emits tool call events in the correct order", async () => {
    const encoder = new TextEncoder();
    // Helper to build valid SSE data lines
    const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

    // Simulate a stream with tool calls and content
    const chatStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // First chunk: text content
        controller.enqueue(sse({
          choices: [{ index: 0, delta: { content: "Let me check." }, finish_reason: null }]
        }));
        // Second chunk: tool call start (with id and name, empty arguments)
        controller.enqueue(sse({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_42",
                type: "function",
                function: { name: "read_file", arguments: "" }
              }]
            },
            finish_reason: null
          }]
        }));
        // Third chunk: tool call argument delta
        controller.enqueue(sse({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "/test.txt" }) } }]
            },
            finish_reason: null
          }]
        }));
        // Final chunk: finish_reason = tool_calls
        controller.enqueue(sse({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
        }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const { streamChatToResponses } = await import(
      "../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "big-pickle");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullOutput = "";
    const eventTypes: string[] = [];
    const eventData: unknown[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      fullOutput += text;
      // Parse SSE frames
      const frames = text.split("\n\n");
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const lines = frame.split("\n");
        let eventType = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          if (line.startsWith("data: ")) data = line.slice(6).trim();
        }
        if (eventType) {
          eventTypes.push(eventType);
          try {
            eventData.push(JSON.parse(data));
          } catch {
            eventData.push(data);
          }
        }
      }
    }

    // Check event types
    expect(eventTypes[0]).toBe("response.created");
    expect(eventTypes).toContain("response.output_item.added");
    expect(eventTypes).toContain("response.content_part.added");
    expect(eventTypes).toContain("response.output_text.delta");
    // Tool call events should appear
    const toolCallAddedEvents = eventTypes.filter(
      (t) => t === "response.output_item.added",
    );
    expect(toolCallAddedEvents.length).toBeGreaterThanOrEqual(1);
    expect(eventTypes).toContain("response.function_call_arguments.delta");
    expect(eventTypes).toContain("response.function_call_arguments.done");
    expect(eventTypes).toContain("response.output_item.done");
    // Final event
    expect(eventTypes[eventTypes.length - 1]).toBe("response.completed");

    // Verify response.completed has output items
    const completedEvent = asResponseCompletedEvent(eventData[eventData.length - 1]);
    expect(completedEvent.response.output).toBeDefined();
    expect(completedEvent.response.output.length).toBeGreaterThanOrEqual(1);
  });

  it("emits response.completed with usage", async () => {
    const encoder = new TextEncoder();
    const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    const chatStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse({
          choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const { streamChatToResponses } = await import(
      "../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "mimo-v2.5-free");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullOutput = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value);
    }

    expect(fullOutput).toContain("response.completed");
    expect(fullOutput).toContain("input_tokens");
    expect(fullOutput).toContain("output_tokens");
    expect(fullOutput).toContain("prompt_tokens");
    expect(fullOutput).toContain("completion_tokens");
  });

  it("includes previous_response_id in response.created and response.completed", async () => {
    const encoder = new TextEncoder();
    const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    const chatStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const { streamChatToResponses } = await import(
      "../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(
      chatStream,
      "big-pickle",
      "resp_prev_999",
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const allData: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          allData.push(line.slice(6).trim());
        }
      }
    }

    const createdEvent = JSON.parse(allData[0]);
    expect(createdEvent.response.previous_response_id).toBe("resp_prev_999");
  });

  it("handles reasoning content in streaming", async () => {
    const encoder = new TextEncoder();
    const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    const chatStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse({ choices: [{ index: 0, delta: { reasoning_content: "Let me think..." }, finish_reason: null }] }));
        controller.enqueue(sse({ choices: [{ index: 0, delta: { content: "Answer is 42" }, finish_reason: "stop" }] }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const { streamChatToResponses } = await import(
      "../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "mimo-v2.5-free");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const eventTypes: string[] = [];
    // Track event types for reasoning_content
    const reasoningEvents: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.startsWith("event: ")) {
          const evt = line.slice(7).trim();
          eventTypes.push(evt);
          if (evt.includes("reasoning")) reasoningEvents.push(evt);
        }
      }
    }

    expect(reasoningEvents.length).toBeGreaterThan(0);
    expect(eventTypes).toContain("response.reasoning_text.delta");
    // After reasoning there should be content_part.added for the text
    expect(eventTypes).toContain("response.content_part.added");
    expect(eventTypes).toContain("response.output_text.delta");
  });
});

// =============================================================================
// Integration: Responses API handler edge cases
// =============================================================================

describe("Responses API integration", () => {
  it("returns 200 for basic non-streaming response", async () => {
    const { default: worker } = await import("../src/index");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + "a".repeat(32),
      },
      body: JSON.stringify({
        model: "big-pickle",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = await parseResponsesJson(response);
    expect(json.object).toBe("response");
    const first = json.output[0];
    expect(isMessageOutput(first)).toBe(true);
    if (isMessageOutput(first)) {
      expect(first.content[0].text).toBe("Hello!");
    }
  });

  it("handles responses with tool calls in non-streaming mode", async () => {
    const { default: worker } = await import("../src/index");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "I'll check that file.",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"/test.txt"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + "a".repeat(32),
      },
      body: JSON.stringify({
        model: "big-pickle",
        input: [{ role: "user", content: [{ type: "input_text", text: "Read /test.txt" }] }],
        tools: [{ type: "function", name: "read_file", description: "Read a file" }],
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = await parseResponsesJson(response);
    expect(json.object).toBe("response");
    expect(json.output).toHaveLength(2);
    expect(json.output[0].type).toBe("message");
    expect(json.output[1].type).toBe("function_call");
    const fnCall = json.output[1];
    expect(isFunctionCallOutput(fnCall)).toBe(true);
    if (isFunctionCallOutput(fnCall)) {
      expect(fnCall.name).toBe("read_file");
      expect(fnCall.status).toBe("completed");
    }
  });

  it("handles multi-turn conversation via cache", async () => {
    const { default: worker } = await import("../src/index");

    // First turn
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "chatcmpl-first",
          choices: [
            { message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request1 = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + "a".repeat(32),
      },
      body: JSON.stringify({
        model: "big-pickle",
        input: [{ role: "user", content: "Hi" }],
      }),
    });

    const response1 = await worker.fetch(request1);
    expect(response1.status).toBe(200);
    const json1 = await parseResponsesJson(response1);
    const firstResponseId = json1.id;
    expect(firstResponseId).toBeDefined();

    // Second turn with previous_response_id
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "chatcmpl-second",
          choices: [
            { message: { role: "assistant", content: "How can I help?" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request2 = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + "a".repeat(32),
      },
      body: JSON.stringify({
        model: "big-pickle",
        previous_response_id: firstResponseId,
        input: [{ role: "user", content: "What's up?" }],
      }),
    });

    const response2 = await worker.fetch(request2);
    expect(response2.status).toBe(200);
    const json2 = await parseResponsesJson(response2);
    expect(json2.object).toBe("response");
    const secondOutput = json2.output[0];
    expect(isMessageOutput(secondOutput)).toBe(true);
    if (isMessageOutput(secondOutput)) {
      expect(secondOutput.content[0].text).toBe("How can I help?");
    }

    // Verify the second request included both the first and second turn messages
    const capturedBody = parseCapturedBody(fetchMock.mock.calls[1][1]?.body);
    // Should have: first user ("Hi") + first assistant ("Hello!") + second user ("What's up?")
    expect(capturedBody.messages).toHaveLength(3);
    expect(capturedBody.messages[0].content).toBe("Hi");
    expect(capturedBody.messages[1].content).toBe("Hello!");
    expect(capturedBody.messages[2].content).toBe("What's up?");

    fetchMock.mockRestore();
  });

  it("handles tool_choice if provided", async () => {
    // This tests that tools are forwarded properly
    // (tool_choice forwarding is a future enhancement)
    const { default: worker } = await import("../src/index");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + "a".repeat(32),
      },
      body: JSON.stringify({
        model: "big-pickle",
        input: [{ role: "user", content: "do something" }],
        tools: [{ type: "function", name: "bash", description: "Run bash" }],
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);

    // Verify tools were forwarded to the upstream
    const capturedBody = parseCapturedBody(fetchMock.mock.calls[0][1]?.body);
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tools![0].function.name).toBe("bash");

    fetchMock.mockRestore();
  });

  it("handles models list request for Codex with new metadata fields", async () => {
    const { default: worker } = await import("../src/index");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "mimo-v2.5-free", object: "model", created: 1234, owned_by: "opencode" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request = new Request("https://proxy.example/v1/models?client_version=0.139.0", {
      headers: {
        "x-api-key": "a".repeat(32),
        "user-agent": "codex_exec/0.139.0",
      },
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = (await response.json()) as CodexModelsListResponse;
    const model = json.models[0];
    expect(model.slug).toBe("mimo-v2.5-free");
    // Check new metadata fields
    expect(model.experimental_supported_tools).toBeDefined();
    expect(Array.isArray(model.experimental_supported_tools)).toBe(true);
    expect(model.experimental_supported_tools.length).toBeGreaterThan(0);
  });

  it("preserves and passes reasoning_content back to upstream in subsequent turns", async () => {
    const { default: worker } = await import("../src/index");
    let capturedBody: any = null;

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url, init?: RequestInit) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Final answer text",
                  reasoning_content: "First turn thinking process"
                },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 15 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );

    // Turn 1
    const request1 = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${"a".repeat(32)}`
      },
      body: JSON.stringify({
        model: "mimo-v2.5-free",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]
      })
    });

    const response1 = await worker.fetch(request1);
    expect(response1.status).toBe(200);
    const data1 = await response1.json() as any;
    const responseId = data1.id;
    expect(responseId).toBeDefined();

    // Turn 2
    const request2 = new Request("https://proxy.example/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${"a".repeat(32)}`
      },
      body: JSON.stringify({
        model: "mimo-v2.5-free",
        previous_response_id: responseId,
        input: [{ role: "user", content: [{ type: "input_text", text: "Next question" }] }]
      })
    });

    const response2 = await worker.fetch(request2);
    expect(response2.status).toBe(200);

    // Verify upstream request in Turn 2 included reasoning_content in the history
    expect(capturedBody).toBeDefined();
    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBe("First turn thinking process");
    expect(assistantMsg.content).toBe("Final answer text");

    vi.restoreAllMocks();
  });
});
