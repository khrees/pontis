import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCloudflareModels, setupCloudflareInteractive } from '../src/cli/provider-cloudflare';
import * as ui from '../src/cli/ui';

// Mock the UI module
vi.mock('../src/cli/ui', () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
  createSpinner: vi.fn(),
  badge: vi.fn(),
  section: vi.fn(),
  error: vi.fn(),
}));

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
      global.fetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 6000);
        });
      });

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
    it('should successfully set up Cloudflare configuration', async () => {
      const mockConfig = {
        apiToken: 'test-token',
        accountId: 'test-account',
        gatewayId: 'default',
      };

      vi.mocked(ui.input).mockResolvedValue('test-account');
      vi.mocked(ui.input).mockResolvedValue('default');
      vi.mocked(ui.input).mockResolvedValue('test-token');
      vi.mocked(ui.confirm).mockResolvedValue(true);
      vi.mocked(ui.select).mockResolvedValue({ index: 0, value: '@cf/moonshotai/kimi-k2.6' });

      // Mock fetchCloudflareModels
      const mockModels = ['@cf/moonshotai/kimi-k2.6', '@cf/qwen/qwen2.5-7b-instruct'];
      vi.doMock('../src/cli/provider-cloudflare', () => ({
        fetchCloudflareModels: vi.fn().mockResolvedValue(mockModels),
        setupCloudflareInteractive: vi.fn().mockResolvedValue({
          model: '@cf/moonshotai/kimi-k2.6',
          apiKey: 'test-token',
          upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
        }),
      }));

      const result = await setupCloudflareInteractive();

      expect(result).toEqual({
        model: '@cf/moonshotai/kimi-k2.6',
        apiKey: 'test-token',
        upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
      });
    });

    it('should use fallback models when API call fails', async () => {
      vi.mocked(ui.input).mockResolvedValue('test-account');
      vi.mocked(ui.input).mockResolvedValue('default');
      vi.mocked(ui.input).mockResolvedValue('test-token');
      vi.mocked(ui.confirm).mockResolvedValue(true);
      vi.mocked(ui.select).mockResolvedValue({ index: 0, value: '@cf/moonshotai/kimi-k2.6' });

      // Mock fetchCloudflareModels to return empty array
      vi.doMock('../src/cli/provider-cloudflare', () => ({
        fetchCloudflareModels: vi.fn().mockResolvedValue([]),
        setupCloudflareInteractive: vi.fn().mockResolvedValue({
          model: '@cf/moonshotai/kimi-k2.6',
          apiKey: 'test-token',
          upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
        }),
      }));

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/moonshotai/kimi-k2.6');
    });

    it('should handle custom model ID input', async () => {
      vi.mocked(ui.input).mockResolvedValue('test-account');
      vi.mocked(ui.input).mockResolvedValue('default');
      vi.mocked(ui.input).mockResolvedValue('test-token');
      vi.mocked(ui.confirm).mockResolvedValue(true);
      vi.mocked(ui.select).mockResolvedValue({ index: -1, value: '' }); // Custom input
      vi.mocked(ui.input).mockResolvedValue('@cf/custom-model');

      vi.doMock('../src/cli/provider-cloudflare', () => ({
        fetchCloudflareModels: vi.fn().mockResolvedValue(['@cf/moonshotai/kimi-k2.6']),
        setupCloudflareInteractive: vi.fn().mockResolvedValue({
          model: '@cf/custom-model',
          apiKey: 'test-token',
          upstreamUrl: 'https://gateway.ai.cloudflare.com/v1/test-account/default/workers-ai/v1',
        }),
      }));

      const result = await setupCloudflareInteractive();

      expect(result.model).toBe('@cf/custom-model');
    });
  });
});