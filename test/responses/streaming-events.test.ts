import { describe, it, expect } from "vitest";
import { asResponseCompletedEvent } from "../helpers";

describe("Responses API streaming events", () => {
  it("emits response.created first, then text deltas, then response.completed", async () => {
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
      "../../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "mimo-v2.5-free");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
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
    const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

    const chatStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sse({
          choices: [{ index: 0, delta: { content: "Let me check." }, finish_reason: null }]
        }));
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
        controller.enqueue(sse({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "/test.txt" }) } }]
            },
            finish_reason: null
          }]
        }));
        controller.enqueue(sse({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
        }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const { streamChatToResponses } = await import(
      "../../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "big-pickle");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const eventTypes: string[] = [];
    const eventData: unknown[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
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

    expect(eventTypes[0]).toBe("response.created");
    expect(eventTypes).toContain("response.output_item.added");
    expect(eventTypes).toContain("response.content_part.added");
    expect(eventTypes).toContain("response.output_text.delta");
    const toolCallAddedEvents = eventTypes.filter(
      (t) => t === "response.output_item.added",
    );
    expect(toolCallAddedEvents.length).toBeGreaterThanOrEqual(1);
    expect(eventTypes).toContain("response.function_call_arguments.delta");
    expect(eventTypes).toContain("response.function_call_arguments.done");
    expect(eventTypes).toContain("response.output_item.done");
    expect(eventTypes[eventTypes.length - 1]).toBe("response.completed");

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
      "../../src/translate/stream/chat-to-responses"
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
      "../../src/translate/stream/chat-to-responses"
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
      "../../src/translate/stream/chat-to-responses"
    );
    const stream = streamChatToResponses(chatStream, "mimo-v2.5-free");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const eventTypes: string[] = [];
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
    expect(eventTypes).toContain("response.content_part.added");
    expect(eventTypes).toContain("response.output_text.delta");
  });
});
