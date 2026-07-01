import { describe, it, expect, vi } from "vitest";
import type { CodexModelsListResponse } from "../../src/types";
import {
  isMessageOutput,
  isFunctionCallOutput,
  parseCapturedBody,
  parseResponsesJson,
} from "../helpers";

describe("Responses API integration", () => {
  it("returns 200 for basic non-streaming response", async () => {
    const { default: worker } = await import("../../src/index");
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
    const { default: worker } = await import("../../src/index");
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
    const { default: worker } = await import("../../src/index");

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

    const capturedBody = parseCapturedBody(fetchMock.mock.calls[1][1]?.body);
    expect(capturedBody.messages).toHaveLength(3);
    expect(capturedBody.messages[0].content).toBe("Hi");
    expect(capturedBody.messages[1].content).toBe("Hello!");
    expect(capturedBody.messages[2].content).toBe("What's up?");

    fetchMock.mockRestore();
  });

  it("forwards tools to upstream", async () => {
    const { default: worker } = await import("../../src/index");
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

    const capturedBody = parseCapturedBody(fetchMock.mock.calls[0][1]?.body);
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tools![0].function.name).toBe("bash");

    fetchMock.mockRestore();
  });

  it("handles models list request for Codex with new metadata fields", async () => {
    const { default: worker } = await import("../../src/index");
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
    expect(model.experimental_supported_tools).toBeDefined();
    expect(Array.isArray(model.experimental_supported_tools)).toBe(true);
    expect(model.experimental_supported_tools.length).toBeGreaterThan(0);
  });

  it("preserves and passes reasoning_content back to upstream in subsequent turns", async () => {
    const { default: worker } = await import("../../src/index");
    let capturedBody: any = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init?: RequestInit) => {
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

    expect(capturedBody).toBeDefined();
    const assistantMsg = capturedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBe("First turn thinking process");
    expect(assistantMsg.content).toBe("Final answer text");

    vi.restoreAllMocks();
  });

  it("merges consecutive assistant and user messages in history, preserving reasoning content", async () => {
    const { responsesToChatMessages } = await import("../../src/translate/request/responses-to-chat");

    const req: any = {
      input: [
        {
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Assistant thoughts first" }],
          reasoning_content: "My thinking process"
        },
        {
          role: "assistant",
          type: "function_call",
          name: "read_file",
          arguments: '{"path": "package.json"}',
          call_id: "call_123"
        },
        {
          role: "tool",
          type: "function_call_output",
          call_id: "call_123",
          output: "file contents here"
        },
        {
          role: "user",
          content: "First user message text"
        },
        {
          role: "user",
          content: "Second user message text"
        }
      ]
    };

    const { messages } = responsesToChatMessages(req, "mimo-v2.5-free");

    expect(messages.length).toBe(3);

    const mergedAssistant = messages[0];
    expect(mergedAssistant.role).toBe("assistant");
    expect(mergedAssistant.content).toBe("Assistant thoughts first");
    expect(mergedAssistant.reasoning_content).toBe("My thinking process");
    expect((mergedAssistant as any).reasoning).toBe("My thinking process");
    expect(mergedAssistant.tool_calls).toBeDefined();
    expect(mergedAssistant.tool_calls!.length).toBe(1);
    expect(mergedAssistant.tool_calls![0].function.name).toBe("read_file");

    const toolMsg = messages[1];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toBe("file contents here");
    expect(toolMsg.tool_call_id).toBe("call_123");

    const mergedUser = messages[2];
    expect(mergedUser.role).toBe("user");
    expect(mergedUser.content).toBe("First user message text\nSecond user message text");
  });
});
