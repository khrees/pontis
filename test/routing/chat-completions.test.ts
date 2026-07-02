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

describe('POST /v1/chat/completions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('forwards Anthropic beta header when translating OpenAI requests to Anthropic', async () => {
    process.env.PONTIS_UPSTREAM_URL = 'https://api.anthropic.com';
    process.env.PONTIS_UPSTREAM_FORMAT = 'anthropic';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new Request('https://proxy.example/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
        'anthropic-beta': 'tools-2024-04-04',
      },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
      }),
    }));
  });

  it('remaps GPT models to default free model under OpenCode upstream for chat completions pass-through', async () => {
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

    const request = new Request('https://proxy.example/zen/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }]
      }),
    });

    await worker.fetch(request);
    expect(capturedBody!.model).toBe('mimo-v2.5-free');
    vi.restoreAllMocks();
  });
});
