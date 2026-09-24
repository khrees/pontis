import { describe, it, expect } from "vitest";
import { chatResponseToOutput } from "../../src/translate/request/responses-to-chat";
import { isMessageOutput, isFunctionCallOutput } from "../helpers";

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
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("function_call");
    const fnCall = output[0];
    expect(isFunctionCallOutput(fnCall)).toBe(true);
    if (isFunctionCallOutput(fnCall)) {
      expect(fnCall.status).toBe("completed");
    }
  });
});
