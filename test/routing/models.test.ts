import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../../src/index';
import type { CodexModelEntry, CodexModelsListResponse } from '../../src/types';
import { findCodexModel } from '../helpers';

interface TestProcess {
  env: Record<string, string | undefined>;
}
declare const process: TestProcess;

const key = 'a'.repeat(32);

describe('GET /v1/models — model discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PONTIS_UPSTREAM_URL;
    delete process.env.PONTIS_UPSTREAM_FORMAT;
  });

  it('routes /v1/models to Anthropic models endpoint with Anthropic headers', async () => {
    process.env.PONTIS_UPSTREAM_URL = 'https://api.anthropic.com';
    process.env.PONTIS_UPSTREAM_FORMAT = 'anthropic';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04',
      },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': key,
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'tools-2024-04-04',
      },
    }));
  });

  it('routes /go-prefixed model discovery to OpenCode Go models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/go/v1/models', {
      headers: { 'x-api-key': key },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    }));
  });

  it('routes /zen-prefixed model discovery to OpenCode Zen models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const request = new Request('https://proxy.example/zen/v1/models', {
      headers: { 'x-api-key': key },
    });

    await worker.fetch(request);

    expect(fetchMock).toHaveBeenCalledWith('https://opencode.ai/zen/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    }));
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
    const json = (await response.json()) as CodexModelsListResponse;
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
    const json = (await response.json()) as CodexModelEntry;
    expect(json.slug).toBe('big-pickle');
    expect(json.shell_type).toBe('shell_command');
    expect(json.apply_patch_tool_type).toBe('freeform');
    expect(json.truncation_policy.mode).toBe('tokens');
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
    const json = (await response.json()) as CodexModelsListResponse;
    expect(json.models).toBeDefined();
    expect(json.models.length).toBeGreaterThanOrEqual(2);

    const mimo = findCodexModel(json.models, 'mimo-v2.5-free');
    const north = findCodexModel(json.models, 'north-mini-code-free');
    expect(mimo).toBeDefined();
    expect(north).toBeDefined();
    expect(mimo!.supports_structured_tool_calls).toBe(true);
    expect(mimo!.context_window).toBe(131072);
    expect(north!.context_window).toBe(65536);
    expect(mimo!.default_reasoning_level).toBe('medium');
    expect(north!.default_reasoning_level).toBe('none');
    expect(mimo!.supports_reasoning_summaries).toBe(true);
    expect(north!.supports_reasoning_summaries).toBe(false);
    expect(mimo!.max_output_tokens).toBe(16384);
    expect(north!.max_output_tokens).toBe(8192);
    expect(mimo!.truncation_policy.limit).toBe(131072);
    expect(north!.truncation_policy.limit).toBe(65536);
  });

  it('includes custom PONTIS_MODEL in Codex models list if not returned by upstream', async () => {
    const originalEnv = process.env.PONTIS_MODEL;
    process.env.PONTIS_MODEL = 'big-pickle';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'mimo-v2.5-free', object: 'model', created: 1234, owned_by: 'opencode' },
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
    const json = (await response.json()) as CodexModelsListResponse;
    expect(json.models).toBeDefined();
    expect(json.models.length).toBeGreaterThanOrEqual(2);

    const mimo = findCodexModel(json.models, 'mimo-v2.5-free');
    const pickle = findCodexModel(json.models, 'big-pickle');
    expect(mimo).toBeDefined();
    expect(pickle).toBeDefined();

    if (originalEnv === undefined) {
      delete process.env.PONTIS_MODEL;
    } else {
      process.env.PONTIS_MODEL = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('includes deepseek-v4-flash-free in Codex models list when missing from upstream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'mimo-v2.5-free', object: 'model', created: 1234, owned_by: 'opencode' },
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
    const json = (await response.json()) as CodexModelsListResponse;
    const deepseek = findCodexModel(json.models, 'deepseek-v4-flash-free');
    expect(deepseek).toBeDefined();
    expect(deepseek!.context_window).toBe(131072);
    expect(deepseek!.truncation_policy.limit).toBe(131072);
    expect(deepseek!.supports_parallel_tool_calls).toBe(true);
  });
});
