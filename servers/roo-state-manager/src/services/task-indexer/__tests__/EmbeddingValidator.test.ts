/**
 * Tests for EmbeddingValidator.ts
 * Coverage target: 90%+
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateVectorGlobal, sanitizePayload } from '../EmbeddingValidator.js';
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
});
