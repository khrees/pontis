/**
 * Prompt cache key generation and cache token extraction utilities.
 * Bridges Anthropic's explicit cache_control markers with OpenAI's automatic prefix caching.
 */

/** djb2 hash of system prompt text, used as prompt_cache_key for OpenAI node affinity */
export function hashSystemPrompt(system: string | string[] | { text: string; [key: string]: any }[] | undefined): string | null {
  if (!system) return null;
  const text = typeof system === 'string'
    ? system
    : system.map((s) => typeof s === 'string' ? s : (s.text || '')).join('\n');
  if (!text.trim()) return null;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return 'cache-' + Math.abs(hash).toString(36);
}

interface MessageBlock {
  content?: string | { type: string; cache_control?: unknown; [key: string]: any }[];
  [key: string]: any;
}

interface CacheControlSystem {
  cache_control?: unknown;
  [key: string]: any;
}

/** Check if any message or system prompt has Anthropic cache_control markers */
export function hasCacheControl(
  messages: MessageBlock[],
  system?: string | CacheControlSystem[] | CacheControlSystem
): boolean {
  if (Array.isArray(system)) {
    if (system.some((s) => typeof s === 'object' && s !== null && 'cache_control' in s)) return true;
  }
  if (typeof system === 'object' && system !== null && 'cache_control' in system) return true;
  for (const msg of messages || []) {
    if (Array.isArray(msg.content)) {
      if (msg.content.some((block) => typeof block === 'object' && block !== null && 'cache_control' in block)) return true;
    }
  }
  return false;
}

interface UsageLike {
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
  };
  cache_read_input_tokens?: number;
  prompt_tokens?: number;
  input_tokens?: number;
  promptTokens?: number;
  inputTokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  completionTokens?: number;
  outputTokens?: number;
}

function tokenCount(...values: (number | undefined)[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Extract cached token count from common OpenAI-compatible usage shapes. */
export function extractCachedTokens(usage: UsageLike | undefined | null): number {
  return tokenCount(
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.input_tokens_details?.cached_tokens,
    usage?.cache_read_input_tokens,
  );
}

/** Extract input token count from OpenAI, Anthropic, and OpenAI-compatible providers. */
export function extractInputTokens(usage: UsageLike | undefined | null): number {
  return tokenCount(
    usage?.prompt_tokens,
    usage?.input_tokens,
    usage?.promptTokens,
    usage?.inputTokens,
  );
}

/**
 * Anthropic reports cache reads separately from normal input tokens.
 * OpenAI-compatible usage usually includes cached tokens inside prompt/input tokens,
 * so subtract them when mapping to Anthropic usage to avoid double counting.
 */
export function extractUncachedInputTokens(usage: UsageLike | undefined | null): number {
  return Math.max(0, extractInputTokens(usage) - extractCachedTokens(usage));
}

/** Extract output token count from OpenAI, Anthropic, and OpenAI-compatible providers. */
export function extractOutputTokens(usage: UsageLike | undefined | null): number {
  return tokenCount(
    usage?.completion_tokens,
    usage?.output_tokens,
    usage?.completionTokens,
    usage?.outputTokens,
  );
}
