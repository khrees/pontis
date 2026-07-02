import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../src/index';
import { isMessageOutput, parseCapturedBody, parseResponsesJson, type CapturedRequestBody } from '../helpers';

interface TestProcess {
  env: Record<string, string | undefined>;
}
declare const process: TestProcess;

const key = 'a'.repeat(32);

describe('POST /v1/responses — Responses API (Codex CLI)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('remaps GPT models to default free model under OpenCode upstream for responses API', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/zen/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    expect(capturedBody!.model).toBe('mimo-v2.5-free');

    const resJson = await parseResponsesJson(response);
    expect(resJson.object).toBe('response');
    expect(resJson.model).toBe('gpt-5.4-mini');
    const firstOutput = resJson.output[0];
    expect(isMessageOutput(firstOutput)).toBe(true);
    if (isMessageOutput(firstOutput)) {
      expect(firstOutput.content[0].text).toBe('ok');
    }

    vi.restoreAllMocks();
  });

  it('remaps paid OpenCode models to free counterparts under OpenCode upstream', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    // Test deepseek paid to free
    const request1 = new Request('https://proxy.example/zen/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      }),
    });

    const response1 = await worker.fetch(request1);
    expect(response1.status).toBe(200);
    expect(capturedBody!.model).toBe('deepseek-v4-flash-free');

    const resJson1 = await parseResponsesJson(response1);
    expect(resJson1.model).toBe('deepseek-v4-flash');

    // Test mimo paid to free
    const request2 = new Request('https://proxy.example/zen/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'mimo-v2.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      }),
    });

    const response2 = await worker.fetch(request2);
    expect(response2.status).toBe(200);
    expect(capturedBody!.model).toBe('mimo-v2.5-free');

    const resJson2 = await parseResponsesJson(response2);
    expect(resJson2.model).toBe('mimo-v2.5');

    vi.restoreAllMocks();
  });

  it('includes stream_options with include_usage when streaming Responses API request', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedBody = parseCapturedBody(init?.body);
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'big-pickle',
        stream: true,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    expect(capturedBody!.stream).toBe(true);
    expect(capturedBody!.stream_options).toEqual({ include_usage: true });

    vi.restoreAllMocks();
  });

  it('passes through previous_response_id in non-streaming Responses API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, _init?: RequestInit) => {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }]
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'big-pickle',
        previous_response_id: 'resp_prev_12345',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = await parseResponsesJson(response);
    expect(json.object).toBe('response');
    expect(json.previous_response_id).toBe('resp_prev_12345');

    vi.restoreAllMocks();
  });

  it('omits previous_response_id from response when not provided in request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, _init?: RequestInit) => {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }]
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'big-pickle',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      }),
    });

    const response = await worker.fetch(request);
    const json = await parseResponsesJson(response);
    expect(json.previous_response_id).toBeUndefined();

    vi.restoreAllMocks();
  });

  it('passes through previous_response_id in streaming Responses API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, _init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'big-pickle',
        stream: true,
        previous_response_id: 'resp_prev_99999',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('event: response.created');
    expect(text).toContain('"previous_response_id":"resp_prev_99999"');
    expect(text).toContain('event: response.completed');

    vi.restoreAllMocks();
  });
});
