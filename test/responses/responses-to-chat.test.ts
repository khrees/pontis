import { describe, it, expect } from "vitest";
import { responsesToChatMessages } from "../../src/translate/request/responses-to-chat";
import type { OpenAIMessage } from "../../src/types";

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
              content: '{\n  "name": "pontis",\n  "version": "1.0.0"\n}',
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
    const prevMessages: OpenAIMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
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
