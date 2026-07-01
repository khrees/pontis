import { describe, it, expect } from 'vitest';
import { extractApiKey, validateApiKey } from '../src/auth';
import { InvalidApiKeyError, ApiKeyLengthError } from '../src/errors';

describe('extractApiKey', () => {
  it('extracts from X-Api-Key header', () => {
    expect(extractApiKey({ 'x-api-key': 'sk-test-key-32-chars-minimum-here' })).toBe('sk-test-key-32-chars-minimum-here');
  });

  it('extracts from Authorization Bearer header', () => {
    expect(extractApiKey({ 'authorization': 'Bearer sk-test-key-32-chars-minimum-here' })).toBe('sk-test-key-32-chars-minimum-here');
  });

  it('prefers X-Api-Key over Authorization', () => {
    const result = extractApiKey({
      'x-api-key': 'sk-primary',
      'authorization': 'Bearer sk-secondary',
    });
    expect(result).toBe('sk-primary');
  });

  it('returns null when no key present', () => {
    expect(extractApiKey({})).toBeNull();
  });

  it('trims whitespace from Bearer token', () => {
    expect(extractApiKey({ 'authorization': 'Bearer   sk-key  ' })).toBe('sk-key');
  });
});

describe('validateApiKey', () => {
  it('returns null for valid key (32+ chars)', () => {
    expect(validateApiKey('a'.repeat(32))).toBeNull();
    expect(validateApiKey('a'.repeat(64))).toBeNull();
  });

  it('returns error for missing key', () => {
    expect(() => validateApiKey(null)).toThrow(InvalidApiKeyError);
  });

  it('returns error for short key (< 32 chars)', () => {
    expect(() => validateApiKey('short-key')).toThrow(ApiKeyLengthError);
  });
});
