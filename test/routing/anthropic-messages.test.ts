import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../src/index';
import type { OpenAIResponse } from '../../src/types';
import {
  parseCapturedBody,
  parseResponsesJson,
  type CapturedRequestBody,
} from '../helpers';

interface TestProcess {
  env: Record<string, string | undefined>;
}
declare const process: TestProcess;

const key = 'a'.repeat(32);

describe('POST /v1/messages — Anthropic endpoint', () => {
  beforeEach(() => {
    delete process.env.PONTIS_PROVIDER;
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PONTIS_PROVIDER;
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('routes /go-prefixed Anthropic requests to OpenCode Go', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/go/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }));
  });

  it('routes /zen-prefixed Anthropic requests to OpenCode Zen', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'qwen3.5-plus', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }));
  });

  it('preserves upstream rate limit headers on translated errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"FreeUsageLimitError"}', {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'RateLimit-Reset': '1710000000',
        },
      }),
    );

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'minimax-m2.5-free', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const response = await worker.fetch(request);

    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('RateLimit-Reset')).toBe('1710000000');
    expect(await response.text()).toBe('{"error":"FreeUsageLimitError"}');
  });

  it('overrides model from URL path segment with /go prefix', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/go/minimax-m2.5-free/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('minimax-m2.5-free');
    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/chat/completions', expect.anything());
  });

  it('overrides model from URL path segment with /zen prefix', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/zen/minimax-m2.5-free/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('minimax-m2.5-free');
    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/chat/completions', expect.anything());
  });

  it('returns original model name in response body when model override is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/go/minimax-m2.5-free/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const response = await worker.fetch(request);
    const body = (await response.json()) as OpenAIResponse;
    expect(body.model).toBe('claude-sonnet-4-5-20250514');
  });

  it('does not override model when no model segment in path', async () => {
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

    const request = new Request('https://proxy.example/go/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'mistral-custom-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('mistral-custom-model');
  });

  it('overrides model to qwen3.6-plus when image attachments are present on the go path', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
        max_tokens: 1024,
      }),
    });

    await worker.fetch(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody!.model).toBe('qwen3.6-plus');
    expect(Array.isArray(capturedBody!.messages[0].content)).toBe(true);
    expect(capturedBody!.messages[0].content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('overrides model to qwen3.6-plus when image attachments are present on the zen path', async () => {
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

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'mimo-v2.5-free',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
        max_tokens: 1024,
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('qwen3.6-plus');
  });

  it('respects PONTIS_UPSTREAM_URL and PONTIS_UPSTREAM_FORMAT env vars and bypasses model remapping/key validation', async () => {
    process.env.PONTIS_UPSTREAM_URL = 'http://localhost:11434/v1';
    process.env.PONTIS_UPSTREAM_FORMAT = 'openai';

    let capturedUrl = '';
    let capturedBody: CapturedRequestBody | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedBody = parseCapturedBody(init?.body);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'short-local-key',
      },
      body: JSON.stringify({
        model: 'my-custom-local-llama',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    expect(capturedUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect(capturedBody!.model).toBe('my-custom-local-llama');
    expect(capturedHeaders!['Authorization']).toBe('Bearer short-local-key');

    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('remaps GPT models to default free model under OpenCode upstream but preserves them under local upstream', async () => {
    // 1. OpenCode upstream (remaps gpt to mimo-v2.5-free)
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

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }]
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('mimo-v2.5-free');

    // Restore mock for second run
    vi.restoreAllMocks();

    // 2. Local upstream (preserves gpt-5.4-mini)
    process.env.PONTIS_UPSTREAM_URL = 'http://localhost:11434/v1';
    process.env.PONTIS_UPSTREAM_FORMAT = 'openai';

    let capturedLocalBody: CapturedRequestBody | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init?: RequestInit) => {
        capturedLocalBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const localRequest = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'local-key',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }]
      }),
    });

    await worker.fetch(localRequest);
    expect(capturedLocalBody!.model).toBe('gpt-5.4-mini');

    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('remaps GPT models to dynamic PONTIS_MODEL environment variable if set', async () => {
    process.env.PONTIS_MODEL = 'big-pickle';
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

    const request = new Request('https://proxy.example/zen/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }]
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('big-pickle');

    vi.restoreAllMocks();
    delete process.env.PONTIS_MODEL;
  });

  it('remaps Claude models to default Cloudflare model when provider is cloudflare', async () => {
    process.env.PONTIS_PROVIDER = 'cloudflare';
    process.env.PONTIS_UPSTREAM_URL = 'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"model":"@cf/moonshotai/kimi-k2.6"'),
      }),
    );
    delete process.env.PONTIS_PROVIDER;
  });

  it('remaps vision requests to Cloudflare vision model when provider is cloudflare', async () => {
    process.env.PONTIS_PROVIDER = 'cloudflare';
    process.env.PONTIS_UPSTREAM_URL = 'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }
          ]
        }]
      }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"model":"@cf/meta/llama-3.2-11b-vision-instruct"'),
      }),
    );
    delete process.env.PONTIS_PROVIDER;
  });

  it('preserves native Cloudflare models when provider is cloudflare', async () => {
    process.env.PONTIS_PROVIDER = 'cloudflare';
    process.env.PONTIS_UPSTREAM_URL = 'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: '@cf/qwen/qwen1.5-14b-chat-awq', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"model":"@cf/qwen/qwen1.5-14b-chat-awq"'),
      }),
    );
    delete process.env.PONTIS_PROVIDER;
  });
});
