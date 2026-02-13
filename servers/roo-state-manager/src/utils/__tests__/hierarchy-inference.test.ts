/**
 * Tests unitaires pour hierarchy-inference
 *
 * Couvre :
 * - extractTaskIdFromText : extraction UUID v4, patterns contextuels
 * - Cas limites (vide, null, sans UUID)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractTaskIdFromText } from '../hierarchy-inference.js';

describe('extractTaskIdFromText', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // === UUID v4 extraction ===

  describe('UUID v4 extraction', () => {
    it('should extract a standard UUID v4', () => {
      const text = 'Task ID: 550e8400-e29b-41d4-a716-446655440000';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should extract UUID from longer text', () => {
      const text = 'Continuing work on task 123e4567-e89b-42d3-a456-556642440000 which was started earlier';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('123e4567-e89b-42d3-a456-556642440000');
    });

    it('should extract first UUID when multiple present', () => {
      const text = 'Tasks: 11111111-1111-4111-8111-111111111111 and 22222222-2222-4222-8222-222222222222';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('should handle uppercase UUIDs', () => {
      const text = 'ID: 550E8400-E29B-41D4-A716-446655440000';
      const result = extractTaskIdFromText(text);
      expect(result?.toLowerCase()).toBe('550e8400-e29b-41d4-a716-446655440000');
    });
  });

  // === Contextual patterns ===

  describe('contextual patterns', () => {
    it('should extract from CONTEXTE HÉRITÉ pattern', () => {
      const text = 'CONTEXTE HÉRITÉ de la tâche 550e8400-e29b-41d4-a716-446655440000 qui contenait les résultats';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should extract from ORCHESTRATEUR pattern', () => {
      const text = 'ORCHESTRATEUR principal 12345678-1234-4234-8234-123456789abc gère le workflow';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('12345678-1234-4234-8234-123456789abc');
    });

    it('should extract from tâche parent pattern', () => {
      const text = 'Référence à la tâche parent abcdef01-2345-4678-9abc-def012345678 pour le contexte';
      const result = extractTaskIdFromText(text);
      expect(result).toBe('abcdef01-2345-4678-9abc-def012345678');
    });
  });

  // === Edge cases ===

  describe('edge cases', () => {
    it('should return undefined for empty string', () => {
      expect(extractTaskIdFromText('')).toBeUndefined();
    });

    it('should return undefined for null', () => {
      expect(extractTaskIdFromText(null as any)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect(extractTaskIdFromText(undefined as any)).toBeUndefined();
    });

    it('should return undefined for text without UUID', () => {
      expect(extractTaskIdFromText('Just some regular text without any identifiers')).toBeUndefined();
    });

    it('should not match non-v4 UUIDs (wrong version digit)', () => {
      // UUID v4 has '4' as the 13th character
      const text = 'Not v4: 550e8400-e29b-31d4-a716-446655440000'; // version 3
      const result = extractTaskIdFromText(text);
      // Should not match because v4 requires '4' in position 15
      expect(result).toBeUndefined();
    });

    it('should not match UUIDs with wrong variant', () => {
      // UUID v4 has [89ab] as the 17th character
      const text = 'Wrong variant: 550e8400-e29b-41d4-0716-446655440000'; // variant 0
      const result = extractTaskIdFromText(text);
      expect(result).toBeUndefined();
    });
  });
});
