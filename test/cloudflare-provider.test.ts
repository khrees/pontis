import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCloudflareModels, setupCloudflareInteractive } from '../src/cli/provider-cloudflare';
import * as ui from '../src/cli/ui';

// Mock the UI module
vi.mock('../src/cli/ui', () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
  createSpinner: vi.fn(() => ({ stop: vi.fn() })),
  badge: vi.fn(),
  section: vi.fn(),
  error: vi.fn(),
}));

// Prevent saved config from short-circuiting interactive prompts
vi.mock('../src/cli/config', async () => {
  const actual = await vi.importActual('../src/cli/config');
  return {
    ...actual,
    getCloudflareConfigSaved: () => ({} as Record<string, string>),
  };
});

describe('Cloudflare Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

      global.fetch = vi.fn().mockResolvedValue({
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
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
      } as Response);

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([]);
    });

    it('should handle timeout errors', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Timeout'));

      const models = await fetchCloudflareModels('test-account', 'test-token');

      expect(models).toEqual([]);
    });

    it('should handle malformed API responses', async () => {
      global.fetch = vi.fn().mockResolvedValue({
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
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

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
      // Setup mock UI responses in call order:
      // getCloudflareConfigInteractive: input(accountId), input(gatewayId), input(apiToken), confirm(save)
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')  // Account ID
        .mockResolvedValueOnce('default')         // Gateway ID
        .mockResolvedValueOnce('test-token');     // API Token
      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      // fetchCloudflareModels will use global.fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: [
            { id: '@cf/moonshotai/kimi-k2.6' },
            { id: '@cf/qwen/qwen2.5-7b-instruct' },
          ],
        }),
      });

      // setupCloudflareInteractive: select(category), select(model)
      vi.mocked(ui.select)
        .mockResolvedValueOnce({ index: 0, value: '🚀 Flagship / Coding' })  // category
        .mockResolvedValueOnce({ index: 0, value: '@cf/moonshotai/kimi-k2.6' });  // model

      const result = await setupCloudflareInteractive();

      expect(result).toEqual({
        model: '@cf/moonshotai/kimi-k2.6',
        apiKey: 'test-token',
        upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
      });
    });

    it('should use fallback models when API call fails', async () => {
      // Setup mock UI responses in call order
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')  // Account ID
        .mockResolvedValueOnce('default')         // Gateway ID
        .mockResolvedValueOnce('test-token');     // API Token
      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      // fetchCloudflareModels returns empty (API call fails)
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
      });

      // Fallback models are used — select(category), then select(model from fallbacks)
      vi.mocked(ui.select)
        .mockResolvedValueOnce({ index: 0, value: '🚀 Flagship / Coding' })  // category
        .mockResolvedValueOnce({ index: 0, value: '@cf/moonshotai/kimi-k2.6' });  // model (from fallback)

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/moonshotai/kimi-k2.6');
      expect(result.apiKey).toBe('test-token');
    });

    it('should handle custom model ID input', async () => {
      // Setup mock UI responses in call order
      vi.mocked(ui.input)
        .mockResolvedValueOnce('test-account')  // Account ID
        .mockResolvedValueOnce('default')         // Gateway ID
        .mockResolvedValueOnce('test-token');     // API Token
      vi.mocked(ui.confirm).mockResolvedValueOnce(true);

      // fetchCloudflareModels returns models (but we go straight to custom input)
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          result: [{ id: '@cf/moonshotai/kimi-k2.6' }],
        }),
      });

      // First select returns index 4 = "✏️ Enter Custom Model ID" (custom input)
      vi.mocked(ui.select)
        .mockResolvedValueOnce({ index: 4, value: '✏️ Enter Custom Model ID' });
      // Then input is called for custom model ID
      vi.mocked(ui.input).mockResolvedValueOnce('@cf/custom-model');

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/custom-model');
      expect(result.apiKey).toBe('test-token');
    });
  });
});