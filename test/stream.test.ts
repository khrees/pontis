import { describe, it, expect } from 'vitest';
import { streamOpenAIToAnthropic } from '../src/translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from '../src/translate/stream/anthropic-to-openai';
import { streamChatToResponses } from '../src/translate/stream/chat-to-responses';

/** Helper: collect all chunks from a ReadableStream into a string */
async function collectStream(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Helper: create a ReadableStream from SSE text chunks */
function sseStream(...chunks: string[]): ReadableStream {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('streamOpenAIToAnthropic (OpenAI SSE → Anthropic SSE)', () => {
  it('converts a simple text stream', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamOpenAIToAnthropic(openaiSSE, 'test-model'));

    // Should contain Anthropic SSE events
    expect(result).toContain('event: message_start');
    expect(result).toContain('event: content_block_start');
    expect(result).toContain('"index":0');
    expect(result).not.toContain('"index":-1');
    expect(result).toContain('"type":"text"');
    expect(result).toContain('event: content_block_delta');
    expect(result).toContain('"type":"text_delta"');
    expect(result).toContain('"text":"Hello"');
    expect(result).toContain('"text":" world"');
    expect(result).toContain('"text":"!"');
    expect(result).toContain('event: content_block_stop');
    expect(result).toContain('event: message_delta');
    expect(result).toContain('"stop_reason":"end_turn"');
    expect(result).toContain('event: message_stop');
    // Usage should be present (extracted from final chunk)
    expect(result).toContain('"output_tokens":3');
  });

  it('counts input_tokens/output_tokens usage from OpenAI-compatible streams', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":12,"output_tokens":4,"cache_read_input_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamOpenAIToAnthropic(openaiSSE, 'test-model'));

    expect(result).toContain('"input_tokens":6');
    expect(result).toContain('"output_tokens":4');
    expect(result).toContain('"cache_read_input_tokens":6');
  });

  it('handles tool call streams', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamOpenAIToAnthropic(openaiSSE, 'test-model'));

    expect(result).toContain('event: content_block_start');
    expect(result).toContain('"type":"tool_use"');
    expect(result).toContain('"name":"get_weather"');
    expect(result).toContain('event: content_block_delta');
    expect(result).toContain('"type":"input_json_delta"');
    expect(result).toContain('"stop_reason":"tool_use"');
  });

  it('converts reasoning_content deltas to thinking deltas', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamOpenAIToAnthropic(openaiSSE, 'test-model'));

    expect(result).toContain('"type":"thinking"');
    expect(result).toContain('"type":"thinking_delta"');
    expect(result).toContain('"thinking":"thinking"');
    expect(result).toContain('"type":"text_delta"');
    expect(result).toContain('"text":"answer"');
  });
});

describe('streamAnthropicToOpenAI (Anthropic SSE → OpenAI SSE)', () => {
  it('converts a simple text stream', async () => {
    const anthropicSSE = sseStream(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","role":"assistant","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    const result = await collectStream(streamAnthropicToOpenAI(anthropicSSE, 'claude-sonnet-4-20250514'));

    expect(result).toContain('data: {"id":"chatcmpl-');
    expect(result).toContain('"object":"chat.completion.chunk"');
    expect(result).toContain('"content":"Hello"');
    expect(result).toContain('"content":" world"');
    expect(result).toContain('"finish_reason":"stop"');
    expect(result).toContain('data: "[DONE]"');
  });

  it('handles tool_use streams', async () => {
    const anthropicSSE = sseStream(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","role":"assistant","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_001","name":"search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"cats\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    const result = await collectStream(streamAnthropicToOpenAI(anthropicSSE, 'claude-sonnet-4-20250514'));

    expect(result).toContain('"tool_calls"');
    expect(result).toContain('"name":"search"');
    expect(result).toContain('"finish_reason":"tool_calls"');
  });

  it('converts thinking deltas to reasoning_content deltas', async () => {
    const anthropicSSE = sseStream(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"deepseek-reasoner","role":"assistant","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thinking"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    const result = await collectStream(streamAnthropicToOpenAI(anthropicSSE, 'deepseek-reasoner'));

    expect(result).toContain('"reasoning_content":"thinking"');
    expect(result).toContain('"content":"answer"');
  });
});

describe('streamChatToResponses (OpenAI SSE → Responses API SSE)', () => {
  it('converts chat completions chunks to Responses events', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamChatToResponses(openaiSSE, 'test-model'));

    expect(result).toContain('event: response.created');
    expect(result).toContain('event: response.output_item.added');
    expect(result).toContain('event: response.content_part.added');
    expect(result).toContain('event: response.reasoning_text.delta');
    expect(result).toContain('"delta":"thinking"');
    expect(result).toContain('"response_id":');
    expect(result).toContain('"item_id":');
    expect(result).toContain('event: response.reasoning_text.done');
    expect(result).toContain('event: response.output_text.delta');
    expect(result).toContain('"delta":"Hello"');
    expect(result).toContain('event: response.output_text.done');
    expect(result).toContain('event: response.content_part.done');
    expect(result).toContain('event: response.output_item.done');
    expect(result).toContain('event: response.completed');
  });

  it('converts chat completions chunks containing tool calls to Responses events', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_999","type":"function","function":{"name":"run_command","arguments":""}}]}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamChatToResponses(openaiSSE, 'test-model'));

    expect(result).toContain('event: response.output_item.added');
    expect(result).toContain('"type":"function_call"');
    expect(result).toContain('"name":"run_command"');
    expect(result).toContain('event: response.function_call_arguments.delta');
    expect(result).toContain('"delta":"{\\"command\\":\\"ls\\"}"');
    expect(result).toContain('event: response.function_call_arguments.done');
    expect(result).toContain('event: response.output_item.done');
  });

  it('converts chat completions chunks containing DSML XML tool calls to Responses events', async () => {
    const openaiSSE = sseStream(
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Thinking... "}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<｜｜DSML｜｜tool_calls>"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<｜｜DSML｜｜invoke name=\\"run_command\\">"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<｜｜DSML｜｜parameter name=\\"command\\" string=\\"true\\">ls -la</｜｜DSML｜｜parameter>"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"</｜｜DSML｜｜invoke>"}}]}\n\n',
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"</｜｜DSML｜｜tool_calls>Bye."}}]}\n\n',
      'data: [DONE]\n\n',
    );

    const result = await collectStream(streamChatToResponses(openaiSSE, 'test-model'));

    // Should NOT contain the DSML tags as text deltas
    expect(result).not.toContain('"delta":"<｜｜DSML｜｜tool_calls>"');
    expect(result).not.toContain('"delta":"</｜｜DSML｜｜tool_calls>"');

    // Should contain the translated tool call events
    expect(result).toContain('event: response.output_item.added');
    expect(result).toContain('"type":"function_call"');
    expect(result).toContain('"name":"run_command"');
    expect(result).toContain('event: response.function_call_arguments.delta');
    expect(result).toContain('"delta":"{\\"command\\":\\"ls -la\\"}"');
    expect(result).toContain('event: response.function_call_arguments.done');
    expect(result).toContain('event: response.output_item.done');

    // Should contain standard text delta before and after DSML
    expect(result).toContain('"delta":"Thinking... "');
    expect(result).toContain('"delta":"Bye."');
  });
});
