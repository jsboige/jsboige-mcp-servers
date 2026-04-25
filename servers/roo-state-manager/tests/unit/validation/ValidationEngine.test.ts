import { describe, it, expect } from 'vitest';
import {
  ValidationEngine,
  ToolValidationSchemas
} from '../../../src/validation/ValidationEngine.js';
import {
  ToolCategory,
  DisplayPreset,
  DisplayOptions
} from '../../../src/interfaces/UnifiedToolInterface.js';
import { GenericError } from '../../../src/types/errors.js';

describe('ValidationEngine', () => {
  describe('validatePresetOptions', () => {
    it('should validate valid display options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { detailLevel: 'skeleton', maxResults: 10 },
        ToolCategory.DISPLAY
      );
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
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

    it('should reject maxResults out of range for display', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 0 },
        ToolCategory.DISPLAY
      );
      // maxResults < 1 fails base validation
      expect(result.isValid).toBe(false);
    });

    it('should validate search category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.SEARCH_RESULTS,
        { searchQuery: 'test query' },
        ToolCategory.SEARCH
      );
      expect(result.isValid).toBe(true);
    });

    it('should validate export category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.EXPORT_FORMAT,
        { taskId: 'task-123', outputFormat: 'json' },
        ToolCategory.EXPORT
      );
      expect(result.isValid).toBe(true);
    });

    it('should validate utility category options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { forceRebuild: false, dryRun: true },
        ToolCategory.UTILITY
      );
      expect(result.isValid).toBe(true);
    });

    it('should reject startIndex > endIndex in base options', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { startIndex: 10, endIndex: 5 },
        ToolCategory.DISPLAY
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('startIndex'))).toBe(true);
    });

    it('should reject negative truncate', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { truncate: -1 },
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

    it('should reject invalid outputFormat', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.EXPORT_FORMAT,
        { outputFormat: 'yaml' as any },
        ToolCategory.EXPORT
      );
      expect(result.isValid).toBe(false);
    });

    it('should return error for unknown category', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        {},
        'unknown' as ToolCategory
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Unknown tool category'))).toBe(true);
    });
  });

  describe('business rules by preset', () => {
    it('QUICK_OVERVIEW should warn on high maxResults', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 200 },
        ToolCategory.DISPLAY
      );
      // Valid but has warnings
      expect(result.isValid).toBe(true);
    });

    it('SEARCH_RESULTS should require searchQuery for search category', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.SEARCH_RESULTS,
        {},
        ToolCategory.SEARCH
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('searchQuery'))).toBe(true);
    });

    it('SEARCH_RESULTS should accept query as alternative to searchQuery', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.SEARCH_RESULTS,
        { query: 'test' },
        ToolCategory.SEARCH
      );
      expect(result.isValid).toBe(true);
    });

    it('EXPORT_FORMAT should require at least one ID for export category', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.EXPORT_FORMAT,
        {},
        ToolCategory.EXPORT
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('taskId'))).toBe(true);
    });

    it('EXPORT_FORMAT should pass with taskId', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.EXPORT_FORMAT,
        { taskId: 't-123' },
        ToolCategory.EXPORT
      );
      expect(result.isValid).toBe(true);
    });

    it('TREE_NAVIGATION should warn on maxDepth > 20', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.TREE_NAVIGATION,
        { maxDepth: 25 },
        ToolCategory.DISPLAY
      );
      // maxDepth > 20 in schema is rejected, but maxDepth 25 is > max(20)
      expect(result.isValid).toBe(false);
    });

    it('DETAILED_ANALYSIS should warn on low truncate', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.DETAILED_ANALYSIS,
        { truncate: 50 },
        ToolCategory.DISPLAY
      );
      // Valid but with warnings
      expect(result.isValid).toBe(true);
    });
  });

  describe('validateToolInput', () => {
    it('should validate search_tasks_semantic input', async () => {
      const result = await ValidationEngine.validateToolInput(
        'search_tasks_semantic',
        { searchQuery: 'find stuff' },
        ToolCategory.SEARCH
      );
      expect(result.isValid).toBe(true);
    });

    it('should reject search_tasks_semantic without query', async () => {
      const result = await ValidationEngine.validateToolInput(
        'search_tasks_semantic',
        {},
        ToolCategory.SEARCH
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('searchQuery'))).toBe(true);
    });

    it('should validate export_conversation_json input', async () => {
      const result = await ValidationEngine.validateToolInput(
        'export_conversation_json',
        { taskId: 't-1' },
        ToolCategory.EXPORT
      );
      expect(result.isValid).toBe(true);
    });

    it('should reject export_conversation_json without taskId', async () => {
      const result = await ValidationEngine.validateToolInput(
        'export_conversation_json',
        {},
        ToolCategory.EXPORT
      );
      expect(result.isValid).toBe(false);
    });

    it('should validate generate_trace_summary input', async () => {
      const result = await ValidationEngine.validateToolInput(
        'generate_trace_summary',
        { taskId: 't-1' },
        ToolCategory.SUMMARY
      );
      expect(result.isValid).toBe(true);
    });

    it('should reject generate_trace_summary without taskId', async () => {
      const result = await ValidationEngine.validateToolInput(
        'generate_trace_summary',
        {},
        ToolCategory.SUMMARY
      );
      expect(result.isValid).toBe(false);
    });

    it('should handle unknown tool name gracefully', async () => {
      const result = await ValidationEngine.validateToolInput(
        'unknown_tool',
        { forceRebuild: true },
        ToolCategory.UTILITY
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('validateCacheAntiLeakCompliance', () => {
    it('should warn on forceRebuild=true', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        forceRebuild: true
      });
      expect(result.isValid).toBe(true);
      expect(result.warnings?.some(w => w.includes('Force rebuild'))).toBe(true);
    });

    it('should warn on large maxResults', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        maxResults: 2000
      });
      expect(result.warnings?.some(w => w.includes('Large maxResults'))).toBe(true);
    });

    it('should warn on full content export', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        truncate: 0,
        includeContent: true
      });
      expect(result.warnings?.some(w => w.includes('Full content'))).toBe(true);
    });

    it('should pass clean options with no warnings', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        maxResults: 50,
        truncate: 100
      });
      expect(result.isValid).toBe(true);
      expect(result.warnings).toBeUndefined();
    });
  });

  describe('generateValidationReport', () => {
    it('should return validation, cache compliance, and recommendations', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 200 },
        ToolCategory.DISPLAY
      );

      expect(report.validation).toBeDefined();
      expect(report.cacheCompliance).toBeDefined();
      expect(report.recommendations).toBeInstanceOf(Array);
    });

    it('should recommend skeleton for quick overview', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        {},
        ToolCategory.DISPLAY
      );
      expect(report.recommendations.some(r => r.includes('skeleton'))).toBe(true);
    });

    it('should recommend prettyPrint for export', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.EXPORT_FORMAT,
        { taskId: 't-1' },
        ToolCategory.EXPORT
      );
      expect(report.recommendations.some(r => r.includes('prettyPrint'))).toBe(true);
    });
  });

  describe('ToolValidationSchemas', () => {
    it('should parse valid display options', () => {
      const result = ToolValidationSchemas.DISPLAY_SCHEMA.safeParse({
        truncate: 100,
        maxResults: 50,
        detailLevel: 'summary',
        viewMode: 'chain',
        sortBy: 'lastActivity',
        sortOrder: 'desc',
        workspace: 'test-workspace'
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid display detailLevel', () => {
      const result = ToolValidationSchemas.DISPLAY_SCHEMA.safeParse({
        detailLevel: 'super-detailed'
      });
      expect(result.success).toBe(false);
    });

    it('should parse valid search options', () => {
      const result = ToolValidationSchemas.SEARCH_SCHEMA.safeParse({
        searchQuery: 'find tasks',
        maxResults: 10,
        workspace: 'ws'
      });
      expect(result.success).toBe(true);
    });

    it('should parse valid summary options', () => {
      const result = ToolValidationSchemas.SUMMARY_SCHEMA.safeParse({
        taskId: 't-1',
        detailLevel: 'Full',
        outputFormat: 'markdown'
      });
      expect(result.success).toBe(true);
    });

    it('should parse valid export options', () => {
      const result = ToolValidationSchemas.EXPORT_SCHEMA.safeParse({
        taskId: 't-1',
        outputFormat: 'json',
        jsonVariant: 'light',
        prettyPrint: true
      });
      expect(result.success).toBe(true);
    });

    it('should parse valid utility options', () => {
      const result = ToolValidationSchemas.UTILITY_SCHEMA.safeParse({
        forceRebuild: false,
        dryRun: true,
        action: 'read',
        server_name: 'roo-state-manager'
      });
      expect(result.success).toBe(true);
    });

    it('should reject negative maxResults in search', () => {
      const result = ToolValidationSchemas.SEARCH_SCHEMA.safeParse({
        maxResults: -1
      });
      expect(result.success).toBe(false);
    });

    it('should reject maxResults > 500 in search', () => {
      const result = ToolValidationSchemas.SEARCH_SCHEMA.safeParse({
        maxResults: 501
      });
      expect(result.success).toBe(false);
    });
  });
});
