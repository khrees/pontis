import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the ui module BEFORE importing the provider functions
vi.mock('../src/cli/ui', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  inputRequired: vi.fn(),
  createSpinner: vi.fn(() => ({
    stop: vi.fn(),
    update: vi.fn(),
  })),
  badge: vi.fn(),
  t: {
    primary: (s: string) => s,
    secondary: (s: string) => s,
    success: (s: string) => s,
    warning: (s: string) => s,
    error: (s: string) => s,
    muted: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    accent: (s: string) => s,
  },
  SYM: {},
  section: vi.fn(),
  splash: vi.fn(),
  error: vi.fn(),
  kv: vi.fn(),
  jsonMode: false,
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
  warn: vi.fn(),
}));

import {
  fetchCloudflareModels,
  setupCloudflareInteractive,
  sortCloudflareModels,
  KNOWN_CLOUDFLARE_MODELS,
  DEFAULT_CLOUDFLARE_MODEL,
  categorizeCloudflareModels,
  CLOUDFLARE_PAID_MODELS,
} from '../src/cli/provider-cloudflare';
import * as ui from '../src/cli/ui';
import * as config from '../src/cli/config';

describe('Cloudflare Provider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(config, 'getCloudflareConfigSaved').mockReturnValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchCloudflareModels', () => {
    it('should fetch and filter Cloudflare models successfully', async () => {
      const mockModels = [
        { id: '@cf/meta/llama-3.2-11b-vision-instruct' },
        { id: '@cf/moonshotai/kimi-k2.6' },
        { id: '@cf/qwen/qwen2.5-7b-instruct' },
        { id: 'invalid-model-id' }, // Should be filtered out
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: mockModels,
        }),
      } as Response);

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([
        '@cf/meta/llama-3.2-11b-vision-instruct',
        '@cf/moonshotai/kimi-k2.6',
        '@cf/qwen/qwen2.5-7b-instruct',
      ]);
    });

    it('should handle API errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
      } as Response);

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([]);
    });

    it('should handle timeout errors', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Timeout'));

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([]);
    });

    it('should handle malformed API responses', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          result: null,
        }),
      } as Response);

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([]);
    });

    it('should handle network errors', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([]);
    });
  });

  describe('setupCloudflareInteractive', () => {
    afterEach(() => {
      delete process.env.PONTIS_UPSTREAM_URL;
      delete process.env.PONTIS_UPSTREAM_FORMAT;
    });

    it('should successfully present categories and set up Cloudflare configuration', async () => {
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')  // Account ID
        .mockResolvedValueOnce('default')         // Gateway ID
        .mockResolvedValueOnce('test-token');     // API Token

      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: [
            { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
            { id: '@cf/moonshotai/kimi-k2.6' },
            { id: '@cf/qwen/qwen2.5-coder-32b-instruct' },
          ],
        }),
      } as Response);

      let categoryPromptCalled = false;
      vi.spyOn(ui, 'select').mockImplementation(async (prompt, choices) => {
        if (prompt.includes('category')) {
          categoryPromptCalled = true;
          return { index: 0, value: choices[0] }; // Pick Free
        }
        return { index: 0, value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
      });

      const result = await setupCloudflareInteractive();

      expect(categoryPromptCalled).toBe(true);
      expect(result).toEqual({
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        apiKey: 'test-token',
        upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
      });
    });

    it('should prompt for manual model ID when API call fails and returns 0 models', async () => {
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')  // Account ID
        .mockResolvedValueOnce('default')         // Gateway ID
        .mockResolvedValueOnce('test-token');    // API Token

      vi.mocked(ui.inputRequired).mockResolvedValueOnce('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
      } as Response);

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
      expect(result.apiKey).toBe('test-token');
    });

    it('should handle custom model ID input within category selection', async () => {
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')     // Account ID
        .mockResolvedValueOnce('default')          // Gateway ID
        .mockResolvedValueOnce('test-token');      // API Token

      vi.mocked(ui.inputRequired).mockResolvedValueOnce('@cf/custom-model');
      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }],
        }),
      } as Response);

      vi.spyOn(ui, 'select').mockImplementation(async (prompt, choices) => {
        if (prompt.includes('category')) {
          return { index: 0, value: choices[0] };
        }
        return { index: -1, value: '' }; // Custom selection
      });

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/custom-model');
      expect(result.apiKey).toBe('test-token');
    });

    it('should support direct Workers AI endpoint when gateway ID is empty', async () => {
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')     // Account ID
        .mockResolvedValueOnce('')                 // Gateway ID (empty = direct)
        .mockResolvedValueOnce('test-token');      // API Token

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }],
        }),
      } as Response);

      vi.spyOn(ui, 'select').mockImplementation(async (prompt, choices) => {
        if (prompt.includes('category')) {
          return { index: 0, value: choices[0] };
        }
        return { index: 0, value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
      });

      const result = await setupCloudflareInteractive();

      expect(result.upstreamUrl).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1');
      expect(result.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    });
  });

  describe('getCloudflareUpstreamUrl', () => {
    it('generates AI Gateway endpoint when gatewayId is specified', () => {
      expect(config.getCloudflareUpstreamUrl('my-account', 'my-gateway')).toBe(
        'https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/workers-ai/v1',
      );
    });

    it('generates direct Workers AI endpoint when gatewayId is omitted or empty', () => {
      expect(config.getCloudflareUpstreamUrl('my-account')).toBe(
        'https://api.cloudflare.com/client/v4/accounts/my-account/ai/v1',
      );
      expect(config.getCloudflareUpstreamUrl('my-account', '')).toBe(
        'https://api.cloudflare.com/client/v4/accounts/my-account/ai/v1',
      );
      expect(config.getCloudflareUpstreamUrl('my-account', 'direct')).toBe(
        'https://api.cloudflare.com/client/v4/accounts/my-account/ai/v1',
      );
    });
  });

  describe('categorizeCloudflareModels', () => {
    it('accurately groups models into Free, Frontier, Chinese, and Others', () => {
      const groups = categorizeCloudflareModels([...KNOWN_CLOUDFLARE_MODELS]);

      // 1. Free contains free-tier models, and excludes paid models
      expect(groups.free).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
      expect(groups.free).toContain('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');
      expect(groups.free).toContain('@cf/qwen/qwen2.5-coder-32b-instruct');
      expect(groups.free).not.toContain('@cf/deepseek-ai/deepseek-v4-flash-0731');
      expect(groups.free).not.toContain('@cf/zai-org/glm-5.3');
      expect(groups.free).not.toContain('@cf/moonshotai/kimi-k2.7-code');

      // 2. Frontier contains flagship paid models and top open weights
      expect(groups.frontier).toContain('@cf/deepseek-ai/deepseek-v4-flash-0731');
      expect(groups.frontier).toContain('@cf/zai-org/glm-5.3');
      expect(groups.frontier).toContain('@cf/moonshotai/kimi-k2.7-code');
      expect(groups.frontier).toContain('@cf/meta/llama-4-scout-17b-16e-instruct');
      expect(groups.frontier).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

      // 3. Chinese contains DeepSeek, GLM, Kimi, Qwen
      expect(groups.chinese).toContain('@cf/deepseek-ai/deepseek-v4-flash-0731');
      expect(groups.chinese).toContain('@cf/zai-org/glm-5.3');
      expect(groups.chinese).toContain('@cf/moonshotai/kimi-k2.7-code');
      expect(groups.chinese).toContain('@cf/qwen/qwen2.5-coder-32b-instruct');
      expect(groups.chinese).not.toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

      // 4. Others contains Meta, Google, Mistral, NVIDIA, IBM
      expect(groups.others).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
      expect(groups.others).toContain('@cf/google/gemma-4-26b-a4b-it');
      expect(groups.others).toContain('@cf/mistralai/mistral-small-3.1-24b-instruct');
      expect(groups.others).toContain('@cf/nvidia/nemotron-3-120b-a12b');
      expect(groups.others).toContain('@cf/ibm-granite/granite-4.0-h-micro');
      expect(groups.others).not.toContain('@cf/deepseek-ai/deepseek-v4-flash-0731');
    });

    it('sorts GLM versions descending in Chinese category', () => {
      const groups = categorizeCloudflareModels([...KNOWN_CLOUDFLARE_MODELS]);
      const glm53Idx = groups.chinese.indexOf('@cf/zai-org/glm-5.3');
      const glm52Idx = groups.chinese.indexOf('@cf/zai-org/glm-5.2');
      const glm47Idx = groups.chinese.indexOf('@cf/zai-org/glm-4.7-flash');

      expect(glm53Idx).toBeLessThan(glm52Idx);
      expect(glm52Idx).toBeLessThan(glm47Idx);
    });

    it('sorts Llama versions descending in Others category', () => {
      const groups = categorizeCloudflareModels([...KNOWN_CLOUDFLARE_MODELS]);
      const l4Idx = groups.others.indexOf('@cf/meta/llama-4-scout-17b-16e-instruct');
      const l33Idx = groups.others.indexOf('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
      const l31Idx = groups.others.indexOf('@cf/meta/llama-3.1-8b-instruct-fp8');

      expect(l4Idx).toBeLessThan(l33Idx);
      expect(l33Idx).toBeLessThan(l31Idx);
    });
  });

  describe('KNOWN_CLOUDFLARE_MODELS & Paid Registry', () => {
    it('contains verified 2026 models and default', () => {
      expect(KNOWN_CLOUDFLARE_MODELS).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
      expect(KNOWN_CLOUDFLARE_MODELS).toContain('@cf/deepseek-ai/deepseek-v4-flash-0731');
      expect(KNOWN_CLOUDFLARE_MODELS).toContain('@cf/zai-org/glm-5.3');
      expect(KNOWN_CLOUDFLARE_MODELS).toContain('@cf/moonshotai/kimi-k2.7-code');
      expect(KNOWN_CLOUDFLARE_MODELS).toContain('@cf/meta/llama-4-scout-17b-16e-instruct');
      expect(DEFAULT_CLOUDFLARE_MODEL).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

      // Verify paid models registry
      expect(CLOUDFLARE_PAID_MODELS.has('@cf/deepseek-ai/deepseek-v4-flash-0731')).toBe(true);
      expect(CLOUDFLARE_PAID_MODELS.has('@cf/zai-org/glm-5.3')).toBe(true);
      expect(CLOUDFLARE_PAID_MODELS.has('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(false);
    });
  });

  describe('sortCloudflareModels', () => {
    it('sorts models descending by version within family', () => {
      const sorted = sortCloudflareModels(['@cf/zai-org/glm-5.2', '@cf/zai-org/glm-5.3']);
      expect(sorted[0]).toBe('@cf/zai-org/glm-5.3');
    });
  });
});