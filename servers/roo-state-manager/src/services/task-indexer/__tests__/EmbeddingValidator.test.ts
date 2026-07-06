/**
 * Tests for EmbeddingValidator.ts
 * Coverage target: 90%+
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateVectorGlobal, sanitizePayload, redactSecrets } from '../EmbeddingValidator.js';
import { StateManagerError } from '../../../types/errors.js';

// Mock the openai module
vi.mock('../../../services/openai.js', () => ({
  getEmbeddingDimensions: vi.fn(() => 1536)
}));

describe('EmbeddingValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateVectorGlobal', () => {
    it('should accept valid vector with correct dimensions', () => {
      const vector = new Array(1536).fill(0.5);
      expect(() => validateVectorGlobal(vector)).not.toThrow();
    });

    it('should accept valid vector with custom dimensions', () => {
      const vector = new Array(512).fill(0.5);
      expect(() => validateVectorGlobal(vector, 512)).not.toThrow();
    });

    it('should throw for non-array input', () => {
      expect(() => validateVectorGlobal('not-an-array' as any)).toThrow(StateManagerError);
      expect(() => validateVectorGlobal('not-an-array' as any)).toThrow('Vector doit être un tableau');
    });

    it('should throw for object input', () => {
      expect(() => validateVectorGlobal({} as any)).toThrow(StateManagerError);
    });

    it('should throw for null input', () => {
      expect(() => validateVectorGlobal(null as any)).toThrow(StateManagerError);
    });

    it('should throw for undefined input', () => {
      expect(() => validateVectorGlobal(undefined as any)).toThrow(StateManagerError);
    });

    it('should throw for wrong dimensions', () => {
      const vector = new Array(100).fill(0.5);
      expect(() => validateVectorGlobal(vector)).toThrow('Dimension invalide');
    });

    it('should throw for vector with NaN', () => {
      const vector = new Array(1536).fill(0.5);
      vector[100] = NaN;
      expect(() => validateVectorGlobal(vector)).toThrow('Vector contient NaN ou Infinity');
    });

    it('should throw for vector with Infinity', () => {
      const vector = new Array(1536).fill(0.5);
      vector[100] = Infinity;
      expect(() => validateVectorGlobal(vector)).toThrow('Vector contient NaN ou Infinity');
    });

    it('should throw for vector with -Infinity', () => {
      const vector = new Array(1536).fill(0.5);
      vector[100] = -Infinity;
      expect(() => validateVectorGlobal(vector)).toThrow('Vector contient NaN ou Infinity');
    });

    it('should include correct error details for type error', () => {
      try {
        validateVectorGlobal('string' as any);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StateManagerError);
        const err = error as StateManagerError;
        expect(err.code).toBe('INVALID_VECTOR_TYPE');
        expect(err.service).toBe('EmbeddingValidator');
        expect(err.details).toEqual({
          receivedType: 'string',
          expectedType: 'array'
        });
      }
    });

    it('should include correct error details for dimension error', () => {
      try {
        validateVectorGlobal([1, 2, 3]);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StateManagerError);
        const err = error as StateManagerError;
        expect(err.code).toBe('INVALID_VECTOR_DIMENSION');
        expect(err.details).toEqual({
          actualDimension: 3,
          expectedDimension: 1536
        });
      }
    });

    it('should include correct error details for NaN values', () => {
      const vector = new Array(1536).fill(0.5);
      vector[0] = NaN;
      try {
        validateVectorGlobal(vector);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StateManagerError);
        const err = error as StateManagerError;
        expect(err.code).toBe('INVALID_VECTOR_VALUES');
        expect(err.details?.hasNaN).toBe(true);
      }
    });

    it('should use custom dimension when provided', () => {
      const vector = new Array(768).fill(0.5);
      expect(() => validateVectorGlobal(vector, 768)).not.toThrow();
    });

    it('should reject custom dimension mismatch', () => {
      const vector = new Array(512).fill(0.5);
      expect(() => validateVectorGlobal(vector, 768)).toThrow('Dimension invalide');
    });
  });

  describe('sanitizePayload', () => {
    it('should return a copy of the payload', () => {
      const payload = { key: 'value' };
      const result = sanitizePayload(payload);
      expect(result).not.toBe(payload);
      expect(result).toEqual(payload);
    });

    it('should remove undefined values', () => {
      const payload = { key: 'value', undefinedKey: undefined };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ key: 'value' });
      expect(result).not.toHaveProperty('undefinedKey');
    });

    it('should remove null values except for parent_task_id', () => {
      const payload = { key: 'value', nullKey: null, parent_task_id: null };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ key: 'value', parent_task_id: null });
    });

    it('should remove null values except for root_task_id', () => {
      const payload = { key: 'value', nullKey: null, root_task_id: null };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ key: 'value', root_task_id: null });
    });

    it('should remove empty strings', () => {
      const payload = { key: 'value', emptyKey: '', whitespaceKey: '   ' };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ key: 'value' });
    });

    it('should keep valid strings with spaces', () => {
      const payload = { key: 'value with spaces' };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ key: 'value with spaces' });
    });

    it('should keep zero values', () => {
      const payload = { zero: 0, zeroStr: '0' };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ zero: 0, zeroStr: '0' });
    });

    it('should keep false values', () => {
      const payload = { bool: false };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ bool: false });
    });

    it('should handle nested objects', () => {
      const payload = {
        nested: { inner: 'value', undefinedInner: undefined }
      };
      const result = sanitizePayload(payload);
      // Note: sanitizePayload only does shallow cleaning
      expect(result).toHaveProperty('nested');
    });

    it('should handle arrays', () => {
      const payload = { arr: [1, 2, 3] };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ arr: [1, 2, 3] });
    });

    it('should handle empty object', () => {
      const result = sanitizePayload({});
      expect(result).toEqual({});
    });

    it('should handle complex payload', () => {
      const payload = {
        taskId: 'test-123',
        parent_task_id: null,  // Keep
        root_task_id: null,    // Keep
        emptyString: '',       // Remove
        undefinedValue: undefined, // Remove
        nullValue: null,       // Remove (not special key)
        validValue: 'test',
        number: 42,
        boolean: true
      };
      const result = sanitizePayload(payload);

      expect(result).toEqual({
        taskId: 'test-123',
        parent_task_id: null,
        root_task_id: null,
        validValue: 'test',
        number: 42,
        boolean: true
      });
    });
  });

  // Secret scrubbing before Qdrant upsert (security #2783).
  // NOTE: every "secret" below is an obviously-fake placeholder whose SHAPE matches a
  // pattern — never a real credential (avoids re-leaking a live value into the index).
  describe('redactSecrets — secret scrubbing (#2783)', () => {
    it('should mask a NAME=VALUE env-dump form, preserving the key name', () => {
      const out = redactSecrets('QDRANT__SERVICE__API_KEY=abcdef0123456789deadbeef');
      expect(out).toContain('QDRANT__SERVICE__API_KEY=');
      expect(out).toContain('<redacted>');
      expect(out).not.toContain('abcdef0123456789deadbeef');
    });

    it('should mask an HTTP header form (api-key: value)', () => {
      const out = redactSecrets('curl -H "api-key: abcdef0123456789deadbeef" http://localhost:6333');
      expect(out).toContain('api-key:');
      expect(out).toContain('<redacted>');
      expect(out).not.toContain('abcdef0123456789deadbeef');
    });

    it('should mask an sk-proj- OpenAI key anywhere in text', () => {
      const out = redactSecrets('leaked OPENAI: sk-proj-AAAA1111bbbb2222cccc3333dddd4444 in the log');
      expect(out).toContain('<redacted');
      expect(out).not.toContain('sk-proj-AAAA1111bbbb2222cccc3333dddd4444');
    });

    it('should mask a GitHub PAT (ghp_)', () => {
      const out = redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here');
      expect(out).toContain('<redacted-gh>');
      expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    });

    it('should mask a Bearer token', () => {
      const out = redactSecrets('Authorization: Bearer abc123.def456.ghi789');
      expect(out).toContain('Bearer <redacted>');
      expect(out).not.toContain('abc123.def456.ghi789');
    });

    it('should leave non-secret prose untouched', () => {
      const prose = 'the function validates the API and returns a token count of 42';
      expect(redactSecrets(prose)).toBe(prose);
    });

    it('should not mask short values under the length threshold', () => {
      const short = 'TOKEN: abc';
      expect(redactSecrets(short)).toBe(short);
    });
  });

  describe('sanitizePayload — secret scrubbing integration (#2783)', () => {
    it('should scrub a secret embedded in a content field', () => {
      const payload = {
        task_id: 'test-123',
        content: 'output of cat .env:\nQDRANT__SERVICE__API_KEY=abcdef0123456789deadbeef\ndone'
      };
      const result = sanitizePayload(payload);
      expect(result.task_id).toBe('test-123');
      expect(result.content).toContain('<redacted>');
      expect(result.content).not.toContain('abcdef0123456789deadbeef');
    });

    it('should preserve existing undefined/null/empty behavior alongside scrubbing', () => {
      const payload = {
        content: 'sk-proj-AAAA1111bbbb2222cccc3333dddd4444',
        parent_task_id: null,   // kept
        emptyString: '',        // removed
        undefinedValue: undefined, // removed
        validValue: 'test'
      };
      const result = sanitizePayload(payload);
      expect(result).toHaveProperty('parent_task_id', null);
      expect(result).not.toHaveProperty('emptyString');
      expect(result).not.toHaveProperty('undefinedValue');
      expect(result.validValue).toBe('test');
      expect(result.content).not.toContain('sk-proj-AAAA1111bbbb2222cccc3333dddd4444');
    });

    it('should not alter non-secret string payloads', () => {
      const payload = { content: 'a normal message with spaces', key: 'value' };
      const result = sanitizePayload(payload);
      expect(result).toEqual({ content: 'a normal message with spaces', key: 'value' });
    });
  });
});
