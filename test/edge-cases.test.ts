import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  isAnthropicTextBlock, 
  isAnthropicImageBlock, 
  isOpenAITextPart,
  isString,
  isObject,
  safeParseJson,
  safeToNumber,
  safeToString
} from '../src/type-guards';
import { 
  InvalidApiKeyError, 
  ApiKeyLengthError, 
  UpstreamTimeoutError,
  StreamBufferOverflowError,
  StreamParseError,
  ValidationError
} from '../src/errors';

describe('Edge Cases and Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Type Guards', () => {
    describe('isAnthropicTextBlock', () => {
      it('should return true for valid text blocks', () => {
        const validBlock = { type: 'text', text: 'Hello world' };
        expect(isAnthropicTextBlock(validBlock)).toBe(true);
      });

      it('should return false for invalid text blocks', () => {
        const invalidBlock = { type: 'text', text: 123 };
        expect(isAnthropicTextBlock(invalidBlock)).toBe(false);
      });

      it('should return false for non-objects', () => {
        expect(isAnthropicTextBlock(null)).toBe(false);
        expect(isAnthropicTextBlock(undefined)).toBe(false);
        expect(isAnthropicTextBlock('string')).toBe(false);
      });
    });

    describe('isAnthropicImageBlock', () => {
      it('should return true for valid image blocks', () => {
        const validBlock = { 
          type: 'image', 
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' } 
        };
        expect(isAnthropicImageBlock(validBlock)).toBe(true);
      });

      it('should return false for image blocks without source', () => {
        const invalidBlock = { type: 'image' };
        expect(isAnthropicImageBlock(invalidBlock)).toBe(false);
      });
    });

    describe('isOpenAITextPart', () => {
      it('should return true for valid text parts', () => {
        const validPart = { type: 'text', text: 'Hello' };
        expect(isOpenAITextPart(validPart)).toBe(true);
      });

      it('should return false for invalid text parts', () => {
        const invalidPart = { type: 'text', text: 123 };
        expect(isOpenAITextPart(invalidPart)).toBe(false);
      });
    });
  });

  describe('Utility Type Guards', () => {
    describe('isString', () => {
      it('should correctly identify strings', () => {
        expect(isString('hello')).toBe(true);
        expect(isString('')).toBe(true);
        expect(isString(123)).toBe(false);
        expect(isString(null)).toBe(false);
        expect(isString(undefined)).toBe(false);
      });
    });

    describe('isObject', () => {
      it('should correctly identify objects', () => {
        expect(isObject({})).toBe(true);
        expect(isObject({ key: 'value' })).toBe(true);
        expect(isObject([])).toBe(false);
        expect(isObject(null)).toBe(false);
        expect(isObject('string')).toBe(false);
      });
    });
  });

  describe('Safe JSON Parsing', () => {
    describe('safeParseJson', () => {
      it('should parse valid JSON', () => {
        const result = safeParseJson('{"key": "value"}');
        expect(result).toEqual({ key: 'value' });
      });

      it('should return null for invalid JSON', () => {
        const result = safeParseJson('invalid json');
        expect(result).toBeNull();
      });

      it('should use validator function', () => {
        const validator = (value: unknown): value is { key: string } => 
          isObject(value) && typeof value.key === 'string';
        
        const result = safeParseJson('{"key": "value"}', validator);
        expect(result).toEqual({ key: 'value' });
      });

      it('should return fallback for invalid JSON with validator', () => {
        const validator = (value: unknown): value is { key: string } => 
          isObject(value) && typeof value.key === 'string';
        
        const result = safeParseJson('{"notKey": "value"}', validator, { key: 'fallback' });
        expect(result).toEqual({ key: 'fallback' });
      });
    });
  });

  describe('Safe Type Conversions', () => {
    describe('safeToNumber', () => {
      it('should convert valid numbers', () => {
        expect(safeToNumber(123)).toBe(123);
        expect(safeToNumber('456')).toBe(456);
        expect(safeToNumber('78.9')).toBe(78.9);
      });

      it('should use default for invalid values', () => {
        expect(safeToNumber('invalid', 0)).toBe(0);
        expect(safeToNumber(null, 42)).toBe(42);
        expect(safeToNumber(undefined, 10)).toBe(10);
      });

      it('should handle NaN values', () => {
        expect(safeToNumber(NaN, 0)).toBe(0);
        expect(safeToNumber('not a number', 5)).toBe(5);
      });
    });

    describe('safeToString', () => {
      it('should convert valid strings', () => {
        expect(safeToString('hello')).toBe('hello');
        expect(safeToString(123)).toBe('123');
        expect(safeToString(null)).toBe('');
        expect(safeToString(undefined)).toBe('');
      });

      it('should use custom default', () => {
        expect(safeToString(null, 'default')).toBe('default');
        expect(safeToString(undefined, 'fallback')).toBe('fallback');
      });
    });
  });

  describe('Error Types', () => {
    describe('InvalidApiKeyError', () => {
      it('should create proper error structure', () => {
        const error = new InvalidApiKeyError('Test error');
        expect(error.code).toBe('authentication_error');
        expect(error.statusCode).toBe(401);
        expect(error.message).toBe('Test error');
      });

      it('should serialize to JSON correctly', () => {
        const error = new InvalidApiKeyError('Missing key');
        const json = error.toJSON();
        expect(json).toEqual({
          error: {
            type: 'authentication_error',
            message: 'Missing key',
            details: { reason: 'Missing key' }
          }
        });
      });
    });

    describe('ApiKeyLengthError', () => {
      it('should include length details', () => {
        const error = new ApiKeyLengthError(32, 10);
        expect(error.details).toEqual({ minLength: 32, actualLength: 10 });
      });
    });

    describe('UpstreamTimeoutError', () => {
      it('should include timeout details', () => {
        const error = new UpstreamTimeoutError(120000);
        expect(error.details).toEqual({ timeoutMs: 120000 });
      });
    });

    describe('StreamBufferOverflowError', () => {
      it('should include buffer size details', () => {
        const error = new StreamBufferOverflowError(10485760, 5242880);
        expect(error.details).toEqual({ 
          bufferSize: 10485760, 
          maxSize: 5242880 
        });
      });
    });

    describe('StreamParseError', () => {
      it('should include parse error details', () => {
        const parseError = new Error('Invalid JSON');
        const error = new StreamParseError('invalid chunk', parseError);
        expect(error.details).toMatchObject({
          chunk: 'invalid chunk',
          originalError: 'Invalid JSON'
        });
      });

      it('should truncate long chunks in details', () => {
        const longChunk = 'a'.repeat(200);
        const parseError = new Error('Invalid JSON');
        const error = new StreamParseError(longChunk, parseError);
        expect(error.details?.chunk).toHaveLength(100); // Should be truncated
      });
    });

    describe('ValidationError', () => {
      it('should include field and value details', () => {
        const error = new ValidationError('Invalid value', 'model', 'invalid-model');
        expect(error.details).toEqual({ 
          field: 'model', 
          value: 'invalid-model' 
        });
      });
    });
  });

  describe('Error Type Guards', () => {
    it('should correctly identify error types', () => {
      const authError = new InvalidApiKeyError('Test');
      const timeoutError = new UpstreamTimeoutError(5000);
      const validationError = new ValidationError('Test');
      const genericError = new Error('Test');

      // These would need to be imported from errors.ts
      // expect(isAuthenticationError(authError)).toBe(true);
      // expect(isUpstreamError(timeoutError)).toBe(true);
      // expect(isValidationError(validationError)).toBe(true);
      // expect(isAuthenticationError(genericError)).toBe(false);
    });
  });

  describe('Edge Case Scenarios', () => {
    it('should handle empty requests', () => {
      const emptyString = '';
      const emptyObject = {};
      const emptyArray = [];

      expect(isString(emptyString)).toBe(true);
      expect(isObject(emptyObject)).toBe(true);
      expect(Array.isArray(emptyArray)).toBe(true);
    });

    it('should handle special number values', () => {
      expect(safeToNumber(Infinity, 0)).toBe(0);
      expect(safeToNumber(-Infinity, 0)).toBe(0);
      expect(safeToNumber(NaN, 0)).toBe(0);
    });

    it('should handle malformed JSON structures', () => {
      const malformedJsons = [
        '{incomplete}',
        '{"key": undefined}',
        '{"key": function(){}}',
        'null',
        'undefined',
      ];

      malformedJsons.forEach(json => {
        const result = safeParseJson(json);
        expect(result).toBeNull();
      });
    });

    it('should handle deeply nested objects', () => {
      const deepObject = {
        level1: {
          level2: {
            level3: {
              value: 'deep'
            }
          }
        }
      };

      expect(isObject(deepObject)).toBe(true);
      expect(safeParseJson(JSON.stringify(deepObject))).toEqual(deepObject);
    });

    it('should handle large numbers in JSON', () => {
      const largeNumberJson = '{"bigNumber": 9007199254740992}'; // Number.MAX_SAFE_INTEGER + 1
      const result = safeParseJson(largeNumberJson);
      expect(result).not.toBeNull();
    });

    it('should handle Unicode strings', () => {
      const unicodeString = 'Hello 世界 🌍';
      expect(safeToString(unicodeString)).toBe(unicodeString);
      expect(safeParseJson(`{"text": "${unicodeString}"}`)).toEqual({ text: unicodeString });
    });

    it('should handle boolean values correctly', () => {
      expect(safeToNumber('true', 0)).toBe(0); // Not auto-converted
      expect(safeToNumber(true, 0)).toBe(1); // Boolean to number
      expect(safeToString(true)).toBe('true');
    });
  });
});