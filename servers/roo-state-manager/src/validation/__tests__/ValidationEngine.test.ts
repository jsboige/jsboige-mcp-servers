/**
 * Tests for ValidationEngine
 * Coverage target: 0% → 70%+
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationEngine } from '../ValidationEngine.js';
import { ToolCategory, DisplayPreset, DisplayPresetType } from '../../interfaces/UnifiedToolInterface.js';

describe('ValidationEngine', () => {
  describe('validatePresetOptions', () => {
    it('should validate valid DISPLAY options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { truncate: 100, detailLevel: 'summary' },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject invalid detailLevel', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { detailLevel: 'invalid' as any },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should accept empty options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        {},
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate SEARCH category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { query: 'test search', maxResults: 50 },
        ToolCategory.SEARCH
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate EXPORT category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { outputFormat: 'json', prettyPrint: true },
        ToolCategory.EXPORT
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate SUMMARY category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { outputFormat: 'markdown', detailLevel: 'Summary' as any },
        ToolCategory.SUMMARY
      );

      expect(result.isValid).toBe(true);
    });

    it('should validate UTILITY category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 10 },
        ToolCategory.UTILITY
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle SEARCH_RESULTS preset', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.SEARCH_RESULTS,
        { truncate: 50 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle DETAILED_ANALYSIS preset', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.DETAILED_ANALYSIS,
        { includeContent: true, detailLevel: 'full' },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should reject negative truncate value', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { truncate: -1 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
    });

    it('should reject maxResults > 1000', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 1001 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
    });

    it('should reject maxResults < 1', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 0 },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
    });

    it('should validate viewMode options', async () => {
      const validModes = ['single', 'chain', 'cluster'] as const;

      for (const mode of validModes) {
        const result = await ValidationEngine.validatePresetOptions(
          DisplayPreset.QUICK_OVERVIEW,
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
          DisplayPreset.QUICK_OVERVIEW,
          { sortBy },
          ToolCategory.DISPLAY
        );
        expect(result.isValid).toBe(true);
      }
    });

    it('should validate sortOrder options', async () => {
      const result1 = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { sortOrder: 'asc' },
        ToolCategory.DISPLAY
      );
      expect(result1.isValid).toBe(true);

      const result2 = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { sortOrder: 'desc' },
        ToolCategory.DISPLAY
      );
      expect(result2.isValid).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle null options gracefully', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        null as any,
        ToolCategory.DISPLAY
      );

      // Should either be valid (treating null as empty) or return error
      expect(typeof result.isValid).toBe('boolean');
    });

    it('should handle undefined options gracefully', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        undefined as any,
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle extremely large truncate values', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { truncate: Number.MAX_SAFE_INTEGER },
        ToolCategory.DISPLAY
      );

      // Should accept large values (no upper bound defined in schema)
      expect(result.isValid).toBe(true);
    });
  });

  // ============================================================
  // validateToolInput
  // ============================================================

  describe('validateToolInput', () => {
    it('returns isValid=true for valid SEARCH input', async () => {
      const result = await ValidationEngine.validateToolInput(
        'search_tasks',
        { maxResults: 10 },
        ToolCategory.SEARCH
      );

      expect(result.isValid).toBe(true);
    });

    it('returns isValid=false for invalid DISPLAY input', async () => {
      const result = await ValidationEngine.validateToolInput(
        'view_task',
        { detailLevel: 'invalid_level' },
        ToolCategory.DISPLAY
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('includes toolName in error messages', async () => {
      const result = await ValidationEngine.validateToolInput(
        'my_tool',
        { detailLevel: 'bad_value' },
        ToolCategory.DISPLAY
      );

      expect(result.errors[0]).toContain('my_tool');
    });

    it('validates search_tasks_semantic: returns error if no searchQuery or query', async () => {
      const result = await ValidationEngine.validateToolInput(
        'search_tasks_semantic',
        {},
        ToolCategory.SEARCH
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('searchQuery'))).toBe(true);
    });

    it('validates export_conversation_json: returns error if no taskId', async () => {
      const result = await ValidationEngine.validateToolInput(
        'export_conversation_json',
        {},
        ToolCategory.EXPORT
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('taskId'))).toBe(true);
    });

    it('validates generate_trace_summary: returns error if no taskId', async () => {
      const result = await ValidationEngine.validateToolInput(
        'generate_trace_summary',
        {},
        ToolCategory.SUMMARY
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('taskId'))).toBe(true);
    });

    it('validates export_conversation_json with taskId: returns isValid=true', async () => {
      const result = await ValidationEngine.validateToolInput(
        'export_conversation_json',
        { taskId: 'task-123' },
        ToolCategory.EXPORT
      );

      expect(result.isValid).toBe(true);
    });

    it('validates search_tasks_semantic with searchQuery: returns isValid=true', async () => {
      const result = await ValidationEngine.validateToolInput(
        'search_tasks_semantic',
        { searchQuery: 'my query' },
        ToolCategory.SEARCH
      );

      expect(result.isValid).toBe(true);
    });
  });

  // ============================================================
  // validateCacheAntiLeakCompliance
  // ============================================================

  describe('validateCacheAntiLeakCompliance', () => {
    it('returns isValid=true for safe options', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({ truncate: 100 });

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('adds warning for forceRebuild=true', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({ forceRebuild: true });

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some(w => w.includes('Cache Anti-Leak'))).toBe(true);
    });

    it('adds warning for force_rebuild=true', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({ force_rebuild: true } as any);

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some(w => w.includes('rebuild'))).toBe(true);
    });

    it('adds warning for maxResults > 1000', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({ maxResults: 1500 });

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some(w => w.includes('maxResults'))).toBe(true);
    });

    it('adds warning for truncate=0 with includeContent=true', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        truncate: 0,
        includeContent: true
      });

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some(w => w.includes('Full content'))).toBe(true);
    });

    it('no warnings when options are within safe limits', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        maxResults: 50,
        truncate: 500,
      });

      expect(result.warnings).toBeUndefined();
    });
  });

  // ============================================================
  // generateValidationReport
  // ============================================================

  describe('generateValidationReport', () => {
    it('returns object with validation, cacheCompliance, recommendations', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        { detailLevel: 'summary' },
        ToolCategory.DISPLAY
      );

      expect(report).toHaveProperty('validation');
      expect(report).toHaveProperty('cacheCompliance');
      expect(report).toHaveProperty('recommendations');
    });

    it('adds recommendation for QUICK_OVERVIEW preset', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        {},
        ToolCategory.DISPLAY
      );

      expect(report.recommendations.some(r => r.includes('skeleton'))).toBe(true);
    });

    it('adds recommendation for EXPORT category without prettyPrint', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.SEARCH_RESULTS,
        { prettyPrint: false },
        ToolCategory.EXPORT
      );

      expect(report.recommendations.some(r => r.includes('prettyPrint'))).toBe(true);
    });

    it('adds recommendation for maxResults > 100', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.SEARCH_RESULTS,
        { maxResults: 200 },
        ToolCategory.SEARCH
      );

      expect(report.recommendations.some(r => r.includes('pagination'))).toBe(true);
    });

    it('no recommendation for safe maxResults', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.SEARCH_RESULTS,
        { maxResults: 50 },
        ToolCategory.SEARCH
      );

      expect(report.recommendations.some(r => r.includes('pagination'))).toBe(false);
    });

    it('cacheCompliance reflects options correctly', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        { forceRebuild: true },
        ToolCategory.DISPLAY
      );

      expect(report.cacheCompliance.isValid).toBe(true);
      expect(report.cacheCompliance.warnings).toBeDefined();
    });
  });

  // ============================================================
  // createValidationEngine factory
  // ============================================================

  describe('createValidationEngine', () => {
    it('returns a ValidationEngine instance', async () => {
      const { createValidationEngine } = await import('../ValidationEngine.js');
      const engine = createValidationEngine();

      expect(engine).toBeInstanceOf(ValidationEngine);
    });
  });
});
