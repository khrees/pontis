import type {
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicThinkingBlock,
  OpenAIContentPartText,
} from './types';

export function isAnthropicTextBlock(block: unknown): block is AnthropicTextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as AnthropicTextBlock).type === 'text' &&
    typeof (block as AnthropicTextBlock).text === 'string'
  );
}

export function isAnthropicImageBlock(block: unknown): block is AnthropicImageBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as AnthropicImageBlock).type === 'image' &&
    typeof (block as AnthropicImageBlock).source === 'object' &&
    (block as AnthropicImageBlock).source !== null
  );
}

export function isAnthropicToolUseBlock(block: unknown): block is AnthropicToolUseBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as AnthropicToolUseBlock).type === 'tool_use' &&
    typeof (block as AnthropicToolUseBlock).id === 'string' &&
    typeof (block as AnthropicToolUseBlock).name === 'string' &&
    typeof (block as AnthropicToolUseBlock).input === 'object'
  );
}

export function isAnthropicThinkingBlock(block: unknown): block is AnthropicThinkingBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as AnthropicThinkingBlock).type === 'thinking' &&
    typeof (block as AnthropicThinkingBlock).thinking === 'string'
  );
}

export function isOpenAITextPart(part: unknown): part is OpenAIContentPartText {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as OpenAIContentPartText).type === 'text' &&
    typeof (part as OpenAIContentPartText).text === 'string'
  );
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeParseJson<T>(json: string, validator?: (value: unknown) => value is T, fallback?: T): T | null {
  try {
    const parsed = JSON.parse(json);
    if (validator && !validator(parsed)) return fallback ?? null;
    return parsed as T;
  } catch {
    return fallback ?? null;
  }
}

export function safeToNumber(value: unknown, defaultValue = 0): number {
  if (typeof value === "number") {
    return isFinite(value) ? value : defaultValue;
  }
  if (isString(value)) {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return defaultValue;
}

export function safeToString(value: unknown, defaultValue = ''): string {
  if (isString(value)) return value;
  if (value === null || value === undefined) return defaultValue;
  return String(value);
}