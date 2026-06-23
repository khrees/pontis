import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index';

declare const process: any;

const key = 'a'.repeat(32);

describe('worker routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes /v1/models to Anthropic models endpoint with Anthropic headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models', {
      headers: {
        'x-api-key': key,
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04',
      },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
      },
    });
  });

  it('forwards Anthropic beta header when translating OpenAI requests to Anthropic', async () => {
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
        'x-upstream-url': 'https://api.anthropic.com',
        'x-upstream-format': 'anthropic',
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

  it('routes /go-prefixed model discovery to OpenCode Go models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/go/v1/models', {
      headers: { 'x-api-key': key },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
  });

  it('routes /zen-prefixed model discovery to OpenCode Zen models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/zen/v1/models', {
      headers: { 'x-api-key': key },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
  });

  it('translates models list format for Codex clients', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'mimo-v2.5-free', object: 'model', created: 1234, owned_by: 'opencode' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models?client_version=0.139.0', {
      headers: { 
        'x-api-key': key,
        'user-agent': 'codex_exec/0.139.0'
      },
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.models).toBeDefined();
    expect(json.models[0].slug).toBe('mimo-v2.5-free');
    expect(json.models[0].shell_type).toBe('shell_command');
    expect(json.models[0].apply_patch_tool_type).toBe('freeform');
    expect(json.models[0].truncation_policy.mode).toBe('tokens');
  });

  it('translates single model metadata request for Codex clients', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'big-pickle', object: 'model', created: 1234, owned_by: 'opencode' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models/big-pickle?client_version=0.139.0', {
      headers: { 
        'x-api-key': key,
        'user-agent': 'codex_exec/0.139.0'
      },
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.slug).toBe('big-pickle');
    expect(json.shell_type).toBe('shell_command');
    expect(json.apply_patch_tool_type).toBe('freeform');
    expect(json.truncation_policy.mode).toBe('tokens');
  });

  it('overrides model from URL path segment with /go prefix', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('minimax-m2.5-free');
    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/chat/completions', expect.anything());
  });

  it('overrides model from URL path segment with /zen prefix', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('minimax-m2.5-free');
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
    const body = await response.json() as any;
    expect(body.model).toBe('claude-sonnet-4-5-20250514');
  });

  it('does not override model when no model segment in path', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('mistral-custom-model');
  });

  it('overrides model to qwen3.6-plus when image attachments are present on the go path', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('qwen3.6-plus');
    expect(Array.isArray(capturedBody.messages[0].content)).toBe(true);
    expect(capturedBody.messages[0].content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('overrides model to qwen3.6-plus when image attachments are present on the zen path', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('qwen3.6-plus');
  });

  it('respects PONTIS_UPSTREAM_URL and PONTIS_UPSTREAM_FORMAT env vars and bypasses model remapping/key validation', async () => {
    process.env.PONTIS_UPSTREAM_URL = 'http://localhost:11434/v1';
    process.env.PONTIS_UPSTREAM_FORMAT = 'openai';

    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url, init: any) => {
        capturedUrl = url.toString();
        capturedBody = JSON.parse(init.body);
        capturedHeaders = init.headers;
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
        // short key (length < 32) which would normally trigger an auth error for OpenCode
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
    expect(capturedBody.model).toBe('my-custom-local-llama'); // verify no model remapping
    expect(capturedHeaders['Authorization']).toBe('Bearer short-local-key');

    // Clean up env vars
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('bypasses model remapping for legacy completions under non-OpenCode upstreams', async () => {
    process.env.PONTIS_UPSTREAM_URL = 'http://localhost:1234/v1';
    process.env.PONTIS_UPSTREAM_FORMAT = 'openai-completions';

    let capturedUrl = '';
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url, init: any) => {
        capturedUrl = url.toString();
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: '123', choices: [{ text: 'ok', finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );

    const request = new Request('https://proxy.example/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'local-key',
      },
      body: JSON.stringify({
        model: 'local-codellama',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    expect(capturedUrl).toBe('http://localhost:1234/v1/completions');
    expect(capturedBody.model).toBe('local-codellama'); // verify no model remapping in completions flow

    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('redirects /install to the raw GitHub install script', async () => {
    const request = new Request('https://proxy.example/install');
    const response = await worker.fetch(request);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://raw.githubusercontent.com/khrees/pontis/main/install.sh');
  });

  it('remaps GPT models to default free model under OpenCode upstream but preserves them under local upstream', async () => {
    // 1. OpenCode upstream (remaps gpt to mimo-v2.5-free)
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('mimo-v2.5-free');

    // Restore mock for second run
    vi.restoreAllMocks();

    // 2. Local upstream (preserves gpt-5.4-mini)
    process.env.PONTIS_UPSTREAM_URL = 'http://localhost:11434/v1';
    process.env.PONTIS_UPSTREAM_FORMAT = 'openai';

    let capturedLocalBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedLocalBody = JSON.parse(init.body);
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
    expect(capturedLocalBody.model).toBe('gpt-5.4-mini');

    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('remaps GPT models to dynamic PONTIS_MODEL environment variable if set', async () => {
    process.env.PONTIS_MODEL = 'big-pickle';
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('big-pickle');

    vi.restoreAllMocks();
    delete process.env.PONTIS_MODEL;
  });

  it('remaps GPT models to default free model under OpenCode upstream for chat completions pass-through', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('mimo-v2.5-free');
    vi.restoreAllMocks();
  });

  it('remaps GPT models to default free model under OpenCode upstream for legacy completions translation', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('mimo-v2.5-free');
    vi.restoreAllMocks();
  });

  it('remaps GPT models to default free model under OpenCode upstream for responses API', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('mimo-v2.5-free');

    const resJson = await response.json() as any;
    expect(resJson.object).toBe('response');
    expect(resJson.model).toBe('gpt-5.4-mini');
    expect(resJson.output[0].content[0].text).toBe('ok');

    vi.restoreAllMocks();
  });

  it('remaps paid OpenCode models to free counterparts under OpenCode upstream', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
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
    expect(capturedBody.model).toBe('deepseek-v4-flash-free');

    const resJson1 = await response1.json() as any;
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
    expect(capturedBody.model).toBe('mimo-v2.5-free');

    const resJson2 = await response2.json() as any;
    expect(resJson2.model).toBe('mimo-v2.5');

    vi.restoreAllMocks();
  });

  it('returns model-specific metadata for different Codex models', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'mimo-v2.5-free', object: 'model', created: 1234, owned_by: 'opencode' },
          { id: 'north-mini-code-free', object: 'model', created: 1234, owned_by: 'opencode' },
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models?client_version=0.139.0', {
      headers: {
        'x-api-key': key,
        'user-agent': 'codex_exec/0.139.0'
      },
    });

    const response = await worker.fetch(request);
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.models).toBeDefined();
    expect(json.models.length).toBe(2);

    const mimo = json.models.find((m: any) => m.slug === 'mimo-v2.5-free');
    const north = json.models.find((m: any) => m.slug === 'north-mini-code-free');
    expect(mimo).toBeDefined();
    expect(north).toBeDefined();

    // mimo has a larger context window than north
    expect(mimo.context_window).toBe(131072);
    expect(north.context_window).toBe(65536);

    // mimo supports reasoning, north does not
    expect(mimo.default_reasoning_level).toBe('medium');
    expect(north.default_reasoning_level).toBe('none');
    expect(mimo.supports_reasoning_summaries).toBe(true);
    expect(north.supports_reasoning_summaries).toBe(false);

    // north has smaller max_output_tokens
    expect(mimo.max_output_tokens).toBe(16384);
    expect(north.max_output_tokens).toBe(8192);

    // truncation policy should match context_window
    expect(mimo.truncation_policy.limit).toBe(131072);
    expect(north.truncation_policy.limit).toBe(65536);
  });

  it('includes stream_options with include_usage when streaming Responses API request', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
        capturedBody = JSON.parse(init.body);
        // Return a minimal SSE stream that terminates immediately
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
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.stream_options).toEqual({ include_usage: true });

    vi.restoreAllMocks();
  });

  it('passes through previous_response_id in non-streaming Responses API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
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
    const json = await response.json() as any;
    expect(json.object).toBe('response');
    expect(json.previous_response_id).toBe('resp_prev_12345');

    vi.restoreAllMocks();
  });

  it('omits previous_response_id from response when not provided in request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init: any) => {
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
    const json = await response.json() as any;
    expect(json.previous_response_id).toBeUndefined();

    vi.restoreAllMocks();
  });
});
