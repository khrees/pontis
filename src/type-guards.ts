/**
 * Type guard utilities for safer type checking and narrowing.
 * These functions help replace `any` types with proper type guards.
 */

import type {
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  OpenAIContentPart,
  OpenAIContentPartText,
  OpenAIContentPartImage,
  OpenAIMessage,
  OpenAIToolCall,
  ResponsesApiTool,
  ResponseContentPart,
  ResponseTextPart,
  ResponseToolUsePart,
  ResponseToolResultPart,
  ResponseInputItem,
} from './types';

// Anthropic content block type guards
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

export function isAnthropicToolResultBlock(block: unknown): block is AnthropicToolResultBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as AnthropicToolResultBlock).type === 'tool_result' &&
    typeof (block as AnthropicToolResultBlock).tool_use_id === 'string'
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

export function isAnthropicContentBlock(block: unknown): block is AnthropicContentBlock {
  return (
    isAnthropicTextBlock(block) ||
    isAnthropicImageBlock(block) ||
    isAnthropicToolUseBlock(block) ||
    isAnthropicToolResultBlock(block) ||
    isAnthropicThinkingBlock(block)
  );
}

// OpenAI content part type guards
export function isOpenAITextPart(part: unknown): part is OpenAIContentPartText {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as OpenAIContentPartText).type === 'text' &&
    typeof (part as OpenAIContentPartText).text === 'string'
  );
}

export function isOpenAIImagePart(part: unknown): part is OpenAIContentPartImage {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as OpenAIContentPartImage).type === 'image_url' &&
    typeof (part as OpenAIContentPartImage).image_url === 'object' &&
    (part as OpenAIContentPartImage).image_url !== null &&
    typeof (part as OpenAIContentPartImage).image_url.url === 'string'
  );
}

export function isOpenAIContentPart(part: unknown): part is OpenAIContentPart {
  return isOpenAITextPart(part) || isOpenAIImagePart(part);
}

// OpenAI message type guards
export function isOpenAIMessage(message: unknown): message is OpenAIMessage {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as OpenAIMessage;
  return (
    typeof msg.role === 'string' &&
    ['system', 'user', 'assistant', 'tool', 'developer'].includes(msg.role)
  );
}

export function isOpenAIToolCall(toolCall: unknown): toolCall is OpenAIToolCall {
  return (
    typeof toolCall === 'object' &&
    toolCall !== null &&
    (toolCall as OpenAIToolCall).type === 'function' &&
    typeof (toolCall as OpenAIToolCall).id === 'string' &&
    typeof (toolCall as OpenAIToolCall).function === 'object' &&
    (toolCall as OpenAIToolCall).function !== null
  );
}

// Responses API type guards
export function isResponsesApiTool(tool: unknown): tool is ResponsesApiTool {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    (tool as ResponsesApiTool).type === 'function'
  );
}

export function isResponseTextPart(part: unknown): part is ResponseTextPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    ['input_text', 'text', 'output_text'].includes((part as ResponseTextPart).type) &&
    typeof (part as ResponseTextPart).text === 'string'
  );
}

export function isResponseToolUsePart(part: unknown): part is ResponseToolUsePart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as ResponseToolUsePart).type === 'tool_use'
  );
}

export function isResponseToolResultPart(part: unknown): part is ResponseToolResultPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as ResponseToolResultPart).type === 'tool_result'
  );
}

export function isResponseContentPart(part: unknown): part is ResponseContentPart {
  return (
    isResponseTextPart(part) ||
    isResponseToolUsePart(part) ||
    isResponseToolResultPart(part)
  );
}

export function isResponseInputItem(item: unknown): item is ResponseInputItem {
  return typeof item === 'object' && item !== null;
}

// Generic utility type guards
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNull(value: unknown): value is null {
  return value === null;
}

export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

// Safe property access with type guards
export function getProperty<T extends object, K extends keyof T>(
  obj: T | null | undefined,
  key: K,
  defaultValue?: T[K]
): T[K] | undefined {
  if (obj === null || obj === undefined) return defaultValue;
  return obj[key] !== undefined ? obj[key] : defaultValue;
}

export function hasProperty<T extends object>(
  obj: unknown,
  key: keyof T | string
): obj is T {
  return isObject(obj) && key in obj;
}

// Safe array operations
export function getArrayItem<T>(
  array: T[] | null | undefined,
  index: number,
  defaultValue?: T
): T | undefined {
  if (!array || !Array.isArray(array)) return defaultValue;
  return array[index] !== undefined ? array[index] : defaultValue;
}

export function getFirstItem<T>(
  array: T[] | null | undefined,
  defaultValue?: T
): T | undefined {
  return getArrayItem(array, 0, defaultValue);
}

// Safe JSON parsing with type guards
export function safeParseJson<T>(json: string, validator?: (value: unknown) => value is T): T | null {
  try {
    const parsed = JSON.parse(json);
    if (validator && !validator(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

// Safe number conversion
export function safeToNumber(value: unknown, defaultValue: number = 0): number {
  if (isNumber(value)) return value;
  if (isString(value)) {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

// Safe string conversion
export function safeToString(value: unknown, defaultValue: string = ''): string {
  if (isString(value)) return value;
  if (value === null || value === undefined) return defaultValue;
  return String(value);
}