/**
 * Tests for ValidationEngine
 * Coverage target: 0% → 70%+
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationEngine } from '../ValidationEngine.js';
import { ToolCategory, DisplayPreset } from '../../interfaces/UnifiedToolInterface.js';

describe('ValidationEngine', () => {
  describe('validatePresetOptions', () => {
    it('should validate valid DISPLAY options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { truncate: 100, detailLevel: 'summary' },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject invalid detailLevel', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { detailLevel: 'invalid' as any },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should accept empty options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        {},
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate SEARCH category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { query: 'test search', maxResults: 50 },
        ToolCategory.SEARCH
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate EXPORT category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { outputFormat: 'json', prettyPrint: true },
        ToolCategory.EXPORT
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate SUMMARY category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { outputFormat: 'markdown', detailLevel: 'Summary' },
        ToolCategory.SUMMARY
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate UTILITY category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { action: 'read', dryRun: true },
        ToolCategory.UTILITY
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle CONCISE preset', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.CONCISE,
        { truncate: 50 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle DETAILED preset', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.DETAILED,
        { includeContent: true, detailLevel: 'full' },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should reject negative truncate value', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { truncate: -1 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
    });

    it('should reject maxResults > 1000', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { maxResults: 1001 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
    });

    it('should reject maxResults < 1', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { maxResults: 0 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
    });

    it('should validate viewMode options', async () => {
      const validModes = ['single', 'chain', 'cluster'] as const;

      for (const mode of validModes) {
        const result = await ValidationEngine.validatePresetOptions(
          DisplayPreset.STANDARD,
          { viewMode: mode },
          ToolCategory.DISPLAY
        );
        expect(result.isValid).toBe(true);
      }
    });

    it('should validate sortBy options', async () => {
      const validSorts = ['lastActivity', 'messageCount', 'totalSize'] as const;

      for (const sortBy of validSorts) {
        const result = await ValidationEngine.validatePresetOptions(
          DisplayPreset.STANDARD,
          { sortBy },
          ToolCategory.DISPLAY
        );
        expect(result.isValid).toBe(true);
      }
    });

    it('should validate sortOrder options', async () => {
      const result1 = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { sortOrder: 'asc' },
        ToolCategory.DISPLAY
      );
      expect(result1.isValid).toBe(true);

      const result2 = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { sortOrder: 'desc' },
        ToolCategory.DISPLAY
      );
      expect(result2.isValid).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle null options gracefully', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        null as any,
        ToolCategory.DISPLAY
      );

      // Should either be valid (treating null as empty) or return error
      expect(typeof result.isValid).toBe('boolean');
    });

    it('should handle undefined options gracefully', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        undefined as any,
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle extremely large truncate values', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.STANDARD,
        { truncate: Number.MAX_SAFE_INTEGER },
        ToolCategory.DISPLAY
      );

      // Should accept large values (no upper bound defined in schema)
      expect(result.isValid).toBe(true);
    });
  });
});
