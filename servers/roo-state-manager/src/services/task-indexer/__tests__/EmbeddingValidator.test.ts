/**
 * Tests for EmbeddingValidator.ts
 * Coverage target: 90%+
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateVectorGlobal, sanitizePayload, redactSecrets, resetKnownValueMaskerCache } from '../EmbeddingValidator.js';
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

  // URI à credentials : `scheme://user:pass@host` passait en clair à travers les DEUX
  // masqueurs — la classe de valeur du motif NAME=VALUE exclut ':' et '@' (#3584 §5.1,
  // constat ai-01 13/09 : `UNIFIED_STORE_PG_URL` nu ET nommé, inchangés tous deux).
  // Comme ci-dessus : placeholders fictifs uniquement.
  describe('redactSecrets — URI credentials (#3584 §5.1)', () => {
    it('should mask the userinfo of a postgresql URI, preserving scheme and host', () => {
      const out = redactSecrets('postgres://svcuser:s3cr3tpw@localhost:5433/unified_store');
      expect(out).toBe('postgres://<redacted>@localhost:5433/unified_store');
    });

    it('should mask an empty-username URI (redis://:password@host)', () => {
      const out = redactSecrets('redis://:fallbackpw@192.168.0.50:6379/0');
      expect(out).toBe('redis://<redacted>@192.168.0.50:6379/0');
    });

    it('should mask a bare URI with no variable name around it', () => {
      const out = redactSecrets('connection string: mongodb://dbuser:dbpass@mongo.internal:27017/prod');
      expect(out).toContain('mongodb://<redacted>@mongo.internal:27017/prod');
      expect(out).not.toContain('dbpass');
    });

    it('should mask NAME=VALUE when the name is a connection URL (#3584 §5.2)', () => {
      const out = redactSecrets('UNIFIED_STORE_PG_URL=postgresql://svc:s3cr3tpw@db:5433/store');
      expect(out).toContain('UNIFIED_STORE_PG_URL=');
      expect(out).not.toContain('s3cr3tpw');
      expect(out).not.toContain('svc:');
    });

    it('should mask a non-URI DSN value under a *_URL name (#3584 §5.2)', () => {
      const out = redactSecrets('DATABASE_URL=plaintextlongvalue99');
      expect(out).toBe('DATABASE_URL=<redacted>');
    });

    it('should NOT touch credential-free URLs (no userinfo)', () => {
      const plain = 'docs at https://github.com/jsboige/roo-extensions and http://localhost:8080/search';
      expect(redactSecrets(plain)).toBe(plain);
    });

    it('should not treat a git SHA or a port as credentials', () => {
      const plain = 'commit 8e5ff8d4 merged, hub at http://192.168.0.50:3000 reachable';
      expect(redactSecrets(plain)).toBe(plain);
    });
  });

  // Couche valeur connue à l'INDEXATION (#3584 §5.3) : une valeur nue détenue par
  // process.env — le cas fondateur (clé 64 hex sans nom) — est masquée avant l'upsert.
  describe('sanitizePayload — known-value layer (#3584 §5.3)', () => {
    const BARE_KEY = 'cafe' + 'babe'.repeat(15); // 64 hex fictifs, nue, sans nom

    beforeEach(() => {
      resetKnownValueMaskerCache();
      process.env.__TEST_EMBEDDINGS_API_KEY = BARE_KEY;
    });

    afterEach(() => {
      delete process.env.__TEST_EMBEDDINGS_API_KEY;
      resetKnownValueMaskerCache();
    });

    it('should mask a bare known value embedded in an indexed content', () => {
      const result = sanitizePayload({ content: `consumer not migrated, active key: ${BARE_KEY}` });
      expect(result.content).toContain('<redacted:__TEST_EMBEDDINGS_API_KEY>');
      expect(result.content).not.toContain(BARE_KEY);
    });

    it('should keep an unknown hex string (a git SHA) untouched', () => {
      const sha = 'f'.repeat(40);
      const result = sanitizePayload({ content: `rebased onto ${sha}` });
      expect(result.content).toContain(sha);
    });
  });
});
