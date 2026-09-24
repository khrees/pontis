import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../src/index';
import {
  parseCapturedBody,
  type CapturedRequestBody,
} from '../helpers';

interface TestProcess {
  env: Record<string, string | undefined>;
}
declare const process: TestProcess;

const key = 'a'.repeat(32);

describe('POST /v1/completions — legacy completions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('remaps GPT models to default free model under OpenCode upstream for legacy completions translation', async () => {
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

    const request = new Request('https://proxy.example/zen/v1/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        prompt: 'say hi'
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('mimo-v2.5-free');
    vi.restoreAllMocks();
  });

  it('forces upstream streaming and free-tier marker for free models even when the client does not stream', async () => {
    let capturedBody: CapturedRequestBody | null = null;
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url, init?: RequestInit) => {
        capturedUrl = typeof url === 'string' ? url : (url as any).href ?? (url as any).url;
        capturedBody = parseCapturedBody(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'big-pickle',
        prompt: 'say hi',
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    expect(capturedUrl).toContain('/chat/completions');
    expect(capturedBody!.stream).toBe(true);
    expect(capturedBody!.apiKey).toBe('public');
    vi.restoreAllMocks();
  });
});
