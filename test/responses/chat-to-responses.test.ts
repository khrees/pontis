import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildResponsesRequest,
  responsesJsonToChat,
  streamResponsesToChatCompletion,
} from '../../src/translate/request/chat-to-responses';
import { isResponsesApiModel } from '../../src/opencode-models';
import worker from '../../src/index';

declare const process: { env: Record<string, string | undefined> };
const key = 'a'.repeat(32);

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${e}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

async function readStream(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

describe('isResponsesApiModel', () => {
  it('matches muse-spark variants', () => {
    expect(isResponsesApiModel('muse-spark-1.3')).toBe(true);
    expect(isResponsesApiModel('muse-spark-1.3-contributor-free')).toBe(true);
    expect(isResponsesApiModel('muse-spark-1.2')).toBe(true);
  });
  it('matches gpt/grok families', () => {
    expect(isResponsesApiModel('gpt-5.4-mini')).toBe(true);
    expect(isResponsesApiModel('grok-4.6')).toBe(true);
  });
  it('does not match chat models', () => {
    expect(isResponsesApiModel('mimo-v2.5-free')).toBe(false);
    expect(isResponsesApiModel('qwen3.6-plus')).toBe(false);
    expect(isResponsesApiModel('kimi-k3')).toBe(false);
    expect(isResponsesApiModel('')).toBe(false);
  });
});

describe('buildResponsesRequest', () => {
  it('moves system messages to instructions and maps roles', () => {
    const body = buildResponsesRequest('muse-spark-1.3', [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ], { stream: false });
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.instructions).toBe('be nice');
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ]);
  });
  it('maps tool calls and tool results', () => {
    const body = buildResponsesRequest('muse-spark-1.3', [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"a":1}' } }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ], { stream: false });
    expect(body.input[0]).toMatchObject({ type: 'function_call', call_id: 'c1', name: 'echo' });
    expect(body.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
  });
});

describe('responsesJsonToChat', () => {
  it('extracts text and usage', () => {
    const chat = responsesJsonToChat({
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hey' }] },
      ],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    }, 'muse-spark-1.3');
    expect(chat.choices[0].message.content).toBe('hey');
    expect(chat.choices[0].finish_reason).toBe('stop');
    expect(chat.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 5 });
  });
  it('maps function_call items to tool_calls', () => {
    const chat = responsesJsonToChat({
      output: [{ type: 'function_call', id: 'x', call_id: 'c9', name: 'run', arguments: '{}', status: 'completed' }],
    }, 'muse-spark-1.3');
    expect(chat.choices[0].finish_reason).toBe('tool_calls');
    expect(chat.choices[0].message.tool_calls?.[0]).toMatchObject({ id: 'c9' });
  });
});

describe('streamResponsesToChatCompletion', () => {
  it('converts output_text deltas to chat chunks', async () => {
    const out = await readStream(streamResponsesToChatCompletion(
      sseStream([
        JSON.stringify({ type: 'response.output_text.delta', delta: 'hel' }),
        JSON.stringify({ type: 'response.output_text.delta', delta: 'lo' }),
        JSON.stringify({ type: 'response.completed' }),
      ]),
      'muse-spark-1.3',
    ));
    expect(out).toContain('"content":"hel"');
    expect(out).toContain('"content":"lo"');
    expect(out).toContain('data: [DONE]');
  });
});

describe('muse-spark upstream routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('posts muse-spark chat completions to /responses', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'resp_1', object: 'response', status: 'completed', model: 'muse-spark-1.3',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const request = new Request('https://proxy.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = await worker.fetch(request);
    expect(capturedUrl.endsWith('/responses')).toBe(true);
    expect(capturedUrl).toContain('opencode.ai');
    expect(capturedBody.input[0]).toMatchObject({ role: 'user' });
    const json: any = await res.json();
    expect(json.choices[0].message.content).toBe('hi there');
    vi.restoreAllMocks();
  });
});
