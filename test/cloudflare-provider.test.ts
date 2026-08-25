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

import { fetchCloudflareModels, setupCloudflareInteractive } from '../src/cli/provider-cloudflare';
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

    it('should successfully set up Cloudflare configuration', async () => {
      // Mock input for account, gateway, token
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
            { id: '@cf/moonshotai/kimi-k2.6' },
            { id: '@cf/qwen/qwen2.5-7b-instruct' },
          ],
        }),
      } as Response);

      vi.mocked(ui.select).mockResolvedValueOnce({ index: 0, value: '@cf/moonshotai/kimi-k2.6' });

      const result = await setupCloudflareInteractive();

      expect(result).toEqual({
        model: '@cf/moonshotai/kimi-k2.6',
        apiKey: 'test-token',
        upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
      });
    });

    it('should prompt for manual model ID when API call fails', async () => {
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')  // Account ID
        .mockResolvedValueOnce('default')         // Gateway ID
        .mockResolvedValueOnce('test-token');    // API Token

      vi.mocked(ui.inputRequired).mockResolvedValueOnce('@cf/moonshotai/kimi-k2.6');
      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
      } as Response);

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/moonshotai/kimi-k2.6');
      expect(result.apiKey).toBe('test-token');
    });

    it('should handle custom model ID input', async () => {
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
          result: [{ id: '@cf/moonshotai/kimi-k2.6' }],
        }),
      } as Response);

      vi.mocked(ui.select).mockResolvedValueOnce({ index: -1, value: '' });

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/custom-model');
      expect(result.apiKey).toBe('test-token');
    });
  });
});