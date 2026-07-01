import { describe, it, expect } from "vitest";
import { buildChatRequest } from "../../src/translate/request/responses-to-chat";

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
