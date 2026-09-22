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
  fetchLocalModels,
  fetchOllamaRegistryModels,
  sortLocalModels,
  categorizeLocalModels,
  setupLocalInteractive,
  KNOWN_OLLAMA_MODELS,
} from '../src/cli/provider-local';
import * as ui from '../src/cli/ui';
import * as preferences from '../src/cli/preferences';

describe('Local / Ollama Provider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(preferences, 'getPreferences').mockReturnValue({
      localEndpoint: 'http://localhost:11434/v1',
    });
    vi.spyOn(preferences, 'savePreferences').mockImplementation((p: any) => p as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('categorizeLocalModels', () => {
    it('accurately groups models into Free, Frontier, Chinese, and Others', () => {
      const sampleModels = [
        'qwen3:8b',
        'qwen3.5:latest',
        'qwen3.5:cloud',
        'qwen3-coder-next:cloud',
        'kimi-k2.5:cloud',
        'gemma4:31b-cloud',
        'minimax-m3:cloud',
        'llama3.3:70b',
        'deepseek-r1:32b',
        'mistral:7b',
        'phi4:14b',
      ];

      const groups = categorizeLocalModels(sampleModels);

      // 1. Free: contains non-cloud local models
      expect(groups.free).toContain('qwen3:8b');
      expect(groups.free).toContain('qwen3.5:latest');
      expect(groups.free).toContain('llama3.3:70b');
      expect(groups.free).toContain('deepseek-r1:32b');
      expect(groups.free).not.toContain('gemma4:31b-cloud');
      expect(groups.free).not.toContain('minimax-m3:cloud');

      // 2. Frontier: contains flagship reasoning, large parameter, and advanced architectures
      expect(groups.frontier).toContain('deepseek-r1:32b');
      expect(groups.frontier).toContain('llama3.3:70b');
      expect(groups.frontier).toContain('qwen3.5:latest');
      expect(groups.frontier).toContain('qwen3.5:cloud');
      expect(groups.frontier).toContain('qwen3-coder-next:cloud');
      expect(groups.frontier).toContain('gemma4:31b-cloud');
      expect(groups.frontier).toContain('kimi-k2.5:cloud');
      expect(groups.frontier).toContain('minimax-m3:cloud');
      expect(groups.frontier).not.toContain('qwen3:8b');

      // 3. Chinese: contains Qwen, DeepSeek, Kimi, MiniMax
      expect(groups.chinese).toContain('qwen3.5:latest');
      expect(groups.chinese).toContain('qwen3:8b');
      expect(groups.chinese).toContain('deepseek-r1:32b');
      expect(groups.chinese).toContain('kimi-k2.5:cloud');
      expect(groups.chinese).toContain('minimax-m3:cloud');
      expect(groups.chinese).not.toContain('llama3.3:70b');
      expect(groups.chinese).not.toContain('gemma4:31b-cloud');

      // 4. Others: contains Meta, Google, Mistral, Microsoft
      expect(groups.others).toContain('llama3.3:70b');
      expect(groups.others).toContain('gemma4:31b-cloud');
      expect(groups.others).toContain('mistral:7b');
      expect(groups.others).toContain('phi4:14b');
      expect(groups.others).not.toContain('qwen3:8b');
    });

    it('falls back to all models if all were remote cloud models', () => {
      const cloudOnly = ['minimax-m3:cloud', 'gemma4:31b-cloud'];
      const groups = categorizeLocalModels(cloudOnly);
      expect(groups.free.length).toBe(2);
    });
  });

  describe('sortLocalModels', () => {
    it('sorts models descending by version within family', () => {
      const sorted = sortLocalModels(['qwen3:8b', 'qwen3.5:latest', 'qwen2.5-coder:32b']);
      expect(sorted[0]).toBe('qwen3.5:latest');
      expect(sorted[1]).toBe('qwen3:8b');
      expect(sorted[2]).toBe('qwen2.5-coder:32b');
    });

    it('sorts models descending by parameter size when versions equal', () => {
      const sorted = sortLocalModels(['llama3.1:8b', 'llama3.1:70b']);
      expect(sorted[0]).toBe('llama3.1:70b');
      expect(sorted[1]).toBe('llama3.1:8b');
    });
  });

  describe('fetchLocalModels', () => {
    it('fetches models via /models endpoint when available', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'qwen3.5:latest' }, { id: 'llama3.3:70b' }],
        }),
      } as Response);

      const models = await fetchLocalModels('http://localhost:11434/v1', 'dummy-key');
      expect(models).toEqual(['qwen3.5:latest', 'llama3.3:70b']);
    });

    it('falls back to /api/tags if /models is empty or unavailable', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen3:8b' }, { name: 'gemma4:31b' }],
          }),
        } as Response);

      const models = await fetchLocalModels('http://localhost:11434/v1', 'dummy-key');
      expect(models).toEqual(['qwen3:8b', 'gemma4:31b']);
    });
  });

  describe('fetchOllamaRegistryModels', () => {
    it('fetches models from ollama.com public registry', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'deepseek-v4.1-flash' }, { name: 'kimi-k3' }],
        }),
      } as Response);

      const models = await fetchOllamaRegistryModels();
      expect(models).toEqual(['deepseek-v4.1-flash', 'kimi-k3']);
    });

    it('returns empty array when registry fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
      const models = await fetchOllamaRegistryModels();
      expect(models).toEqual([]);
    });
  });

  describe('setupLocalInteractive', () => {
    it('presents the 4 categories and picks selected model', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'qwen3.5:latest' }, { id: 'gemma4:31b-cloud' }],
        }),
      } as Response);

      vi.spyOn(ui, 'select').mockImplementation(async (prompt, choices) => {
        if (prompt.includes('category')) {
          // Pick Chinese category
          const chineseIdx = choices.findIndex((c) => c.includes('Chinese'));
          return { index: chineseIdx >= 0 ? chineseIdx : 0, value: choices[chineseIdx] };
        }
        return { index: 0, value: 'qwen3.5:latest [Local/Free]' };
      });

      const result = await setupLocalInteractive();
      expect(result.model).toBe('qwen3.5:latest');
      expect(result.upstreamUrl).toBe('http://localhost:11434/v1');
    });

    it('supports custom model entry within category', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'qwen3.5:latest' }],
        }),
      } as Response);

      vi.spyOn(ui, 'select').mockImplementation(async (prompt, choices) => {
        if (prompt.includes('engine')) {
          return { index: 0, value: choices[0] };
        }
        if (prompt.includes('category')) {
          return { index: 0, value: choices[0] };
        }
        return { index: -1, value: '' }; // Custom model selection
      });

      vi.mocked(ui.input).mockResolvedValueOnce('my-custom-quant-model');

      const result = await setupLocalInteractive();
      expect(result.model).toBe('my-custom-quant-model');
    });
  });

  describe('KNOWN_OLLAMA_MODELS', () => {
    it('contains top open weight models', () => {
      expect(KNOWN_OLLAMA_MODELS).toContain('deepseek-r1:32b');
      expect(KNOWN_OLLAMA_MODELS).toContain('llama3.3:70b');
      expect(KNOWN_OLLAMA_MODELS).toContain('qwen3.5:latest');
      expect(KNOWN_OLLAMA_MODELS).toContain('gemma4:31b');
      expect(KNOWN_OLLAMA_MODELS).toContain('kimi-k3');
      expect(KNOWN_OLLAMA_MODELS).toContain('glm-5.3');
    });
  });
});
