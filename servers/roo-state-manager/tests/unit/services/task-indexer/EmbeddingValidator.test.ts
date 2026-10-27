import { describe, it, expect } from 'vitest';
import { validateVectorGlobal, sanitizePayload } from '../../../../src/services/task-indexer/EmbeddingValidator.js';

describe('EmbeddingValidator', () => {
  describe('validateVectorGlobal', () => {
    const TEST_DIM = 1536; // Fixed dimension for tests, independent of EMBEDDING_DIMENSIONS env

    it('should not throw for valid vector', () => {
      const vector = new Array(TEST_DIM).fill(0.1);
      expect(() => validateVectorGlobal(vector, TEST_DIM)).not.toThrow();
    });

    it('should throw if vector is not an array', () => {
      expect(() => validateVectorGlobal('not-array' as any, TEST_DIM)).toThrow('Vector doit être un tableau');
    });

    it('should throw if vector has wrong dimension', () => {
      const vector = new Array(100).fill(0.1);
      expect(() => validateVectorGlobal(vector, TEST_DIM)).toThrow('Dimension invalide');
    });

    it('should throw if vector contains NaN', () => {
      const vector = new Array(TEST_DIM).fill(0.1);
      vector[0] = NaN;
      expect(() => validateVectorGlobal(vector, TEST_DIM)).toThrow('Vector contient NaN ou Infinity');
    });

    it('should throw if vector contains Infinity', () => {
      const vector = new Array(TEST_DIM).fill(0.1);
      vector[0] = Infinity;
      expect(() => validateVectorGlobal(vector, TEST_DIM)).toThrow('Vector contient NaN ou Infinity');
    });
  });

  describe('sanitizePayload', () => {
    it('should remove undefined values', () => {
      const payload = { a: 1, b: undefined };
      const cleaned = sanitizePayload(payload);
      expect(cleaned).toHaveProperty('a');
      expect(cleaned).not.toHaveProperty('b');
    });

    it('should remove null values except parent_task_id and root_task_id', () => {
      const payload = { a: 1, b: null, parent_task_id: null, root_task_id: null };
      const cleaned = sanitizePayload(payload);
      expect(cleaned).toHaveProperty('a');
      expect(cleaned).not.toHaveProperty('b');
      expect(cleaned).toHaveProperty('parent_task_id', null);
      expect(cleaned).toHaveProperty('root_task_id', null);
    });

    it('should remove empty strings', () => {
      const payload = { a: 'valid', b: '', c: '   ' };
      const cleaned = sanitizePayload(payload);
      expect(cleaned).toHaveProperty('a');
      expect(cleaned).not.toHaveProperty('b');
      expect(cleaned).not.toHaveProperty('c');
    });

    it('replaces a lone surrogate left by a split emoji, keeps whole pairs (#4352)', () => {
      // '📦' is 📦: a split at UTF-16 index leaves one half on each side.
      const emoji = '📦';
      const payload = { content: 'ok ' + emoji[0], content_summary: emoji[1] + ' tail', title: 'box ' + emoji };
      const cleaned = sanitizePayload(payload);
      expect(cleaned.content).toBe('ok �');
      expect(cleaned.content_summary).toBe('� tail');
      expect(cleaned.title).toBe('box ' + emoji);
      // What Qdrant's JSON parser receives must hold no lone \\ud8xx escape.
      expect(JSON.stringify(cleaned)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    });

    it('should keep valid values', () => {
      const payload = { a: 1, b: 'string', c: true, d: [1, 2], e: { f: 'g' } };
      const cleaned = sanitizePayload(payload);
      expect(cleaned).toEqual(payload);
    });
  });
});
