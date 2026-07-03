/**
 * Coverage complement for ValidationEngine.ts (#833 Sprint C3).
 *
 * The base suite (ValidationEngine.test.ts, 39 tests) exercises the happy path and
 * a few invalid-input cases, leaving the preset-specific business-rule arms
 * (validateBusinessRules L320-361), the base-option error arms (validateBaseOptions
 * L281-299), the unknown-category throw (getSchemaForCategory L269), the tool-input
 * catch (validateToolInput L401), the per-tool specific rules (validateSpecificTool
 * L416-440), and the cache-anti-leak warnings (L454+) cold.
 *
 * All cold branches here are reachable through the PUBLIC static API
 * (validatePresetOptions / validateToolInput / validateCacheAntiLeakCompliance /
 * generateValidationReport) — no `any` access to private methods required.
 *
 * Add-only: 0 source touched (anti-churn #1936). Each test names its source-line anchor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ValidationEngine } from '../ValidationEngine.js';
import { ToolCategory, DisplayPreset } from '../../interfaces/UnifiedToolInterface.js';

describe('ValidationEngine — coverage complement', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // validateSpecificTool L438 calls console.warn for force_rebuild; isolate it so
    // it does not pollute vitest output and so we can assert on it.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ---- validateBaseOptions (L277-305) ----
  describe('validateBaseOptions — error arms (via validatePresetOptions)', () => {
    // L281-283: startIndex > endIndex → error
    it('L282-283 — startIndex > endIndex rejected', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { startIndex: 10, endIndex: 5 } as any,
        ToolCategory.DISPLAY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('startIndex must be <= endIndex'))).toBe(true);
    });

    // L281-283: startIndex <= endIndex → valid (b19[1] arm)
    it('L281-282 — startIndex <= endIndex accepted', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { startIndex: 5, endIndex: 10 } as any,
        ToolCategory.DISPLAY,
      );
      expect(result.isValid).toBe(true);
    });

    // L297-298: outputFormat not in the allowed set → error (b29[0])
    it('L297-298 — invalid outputFormat rejected', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { outputFormat: 'yaml' as any },
        ToolCategory.DISPLAY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('outputFormat must be one of'))).toBe(true);
    });

    // L288-289: truncate < 0 → error
    it('L288-289 — negative truncate rejected', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { truncate: -1 } as any,
        ToolCategory.DISPLAY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('truncate must be >= 0'))).toBe(true);
    });

    // L292-293: maxResults < 1 → error
    it('L292-293 — maxResults < 1 rejected', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 0 } as any,
        ToolCategory.DISPLAY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('maxResults must be >= 1'))).toBe(true);
    });
  });

  // ---- getSchemaForCategory (L257-271) ----
  describe('getSchemaForCategory — default throw (via validateToolInput)', () => {
    // L269-270: unknown category → GenericError thrown inside validateToolInput's
    // try block → caught at L401 → returned as isValid:false with the message.
    it('L269-270 + L401-405 — unknown category caught and reported', async () => {
      const result = await ValidationEngine.validateToolInput(
        'any_tool',
        { foo: 'bar' },
        'totally-unknown-category' as any,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unknown tool category'))).toBe(true);
    });
  });

  // ---- validateBusinessRules (L311-369) ----
  // NOTE: validateBusinessRules is private static. We access it via `as any` because
  // validatePresetOptions DISCARDS warnings when isValid stays true (L239 returns
  // {isValid:true, errors:[]} without warnings), so warning-only arms are not
  // observable through the public API. Direct access lets us assert the warning was
  // actually generated (anti-tautology). Pattern established in this C3 sprint
  // (ExportConfigManager.validateConfig, summary-generator private statics).
  describe('validateBusinessRules — preset-specific arms', () => {
    // L323-324: QUICK_OVERVIEW + maxResults > 100 → warning
    it('L323-324 — QUICK_OVERVIEW maxResults>100 warns', () => {
      const result = (ValidationEngine as any).validateBusinessRules(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 200 },
        ToolCategory.DISPLAY,
      );
      expect(result.isValid).toBe(true);
      expect(result.warnings?.some((w: string) => w.includes('maxResults > 100'))).toBe(true);
    });

    // L326-327: QUICK_OVERVIEW + detailLevel 'full' → warning
    it('L326-327 — QUICK_OVERVIEW detailLevel full warns', () => {
      const result = (ValidationEngine as any).validateBusinessRules(
        DisplayPreset.QUICK_OVERVIEW,
        { detailLevel: 'full' },
        ToolCategory.DISPLAY,
      );
      expect(result.warnings?.some((w: string) => w.includes('detailLevel "full"'))).toBe(true);
    });

    // L333-334: DETAILED_ANALYSIS + truncate in (0,100) → warning
    it('L333-334 — DETAILED_ANALYSIS low truncate warns', () => {
      const result = (ValidationEngine as any).validateBusinessRules(
        DisplayPreset.DETAILED_ANALYSIS,
        { truncate: 50 },
        ToolCategory.DISPLAY,
      );
      expect(result.warnings?.some((w: string) => w.includes('Low truncate value'))).toBe(true);
    });

    // L333 truthy-but->=100 arm (b38[1] / b39): truncate >= 100 → no low-truncate warning
    it('L333 — DETAILED_ANALYSIS truncate >= 100 → no low-truncate warning', () => {
      const result = (ValidationEngine as any).validateBusinessRules(
        DisplayPreset.DETAILED_ANALYSIS,
        { truncate: 200 },
        ToolCategory.DISPLAY,
      );
      expect(result.warnings?.some((w: string) => w.includes('Low truncate value'))).toBeFalsy();
    });

    // L340-343: SEARCH_RESULTS preset without query/searchQuery → error
    it('L341-343 — SEARCH_RESULTS without query rejected', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.SEARCH_RESULTS,
        {},
        ToolCategory.SEARCH,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('searchQuery or query'))).toBe(true);
    });

    // L340 arm satisfied (b39[1]) when query provided
    it('L341 — SEARCH_RESULTS with query accepted', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.SEARCH_RESULTS,
        { query: 'foo' },
        ToolCategory.SEARCH,
      );
      expect(result.isValid).toBe(true);
    });

    // L347-352: EXPORT_FORMAT preset without any ID → error
    it('L350-352 — EXPORT_FORMAT without ID rejected', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.EXPORT_FORMAT,
        {},
        ToolCategory.EXPORT,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('at least one ID parameter'))).toBe(true);
    });

    // L347 category mismatch arm (b42[1]) — EXPORT_FORMAT preset on a non-EXPORT
    // category skips the ID requirement (no error from this rule)
    it('L349 — EXPORT_FORMAT preset on SEARCH category skips ID rule', async () => {
      const result = await ValidationEngine.validatePresetOptions(
        DisplayPreset.EXPORT_FORMAT,
        { query: 'x' },
        ToolCategory.SEARCH,
      );
      // No "ID parameter" error because category !== EXPORT
      expect(result.errors.some((e) => e.includes('ID parameter'))).toBe(false);
    });

    // L356-360: TREE_NAVIGATION + maxDepth > 20 → warning (private access — see note above)
    it('L358-359 — TREE_NAVIGATION maxDepth>20 warns', () => {
      const result = (ValidationEngine as any).validateBusinessRules(
        DisplayPreset.TREE_NAVIGATION,
        { maxDepth: 30 },
        ToolCategory.DISPLAY,
      );
      expect(result.warnings?.some((w: string) => w.includes('maxDepth > 20'))).toBe(true);
    });
  });

  // ---- validateSpecificTool (L412-449) via validateToolInput ----
  describe('validateSpecificTool — per-tool rules (via validateToolInput)', () => {
    // Each tool name must pass the category schema first; we use UTILITY category whose
    // schema is permissive enough to let the specific-tool switch run.
    it('L416-419 — search_tasks_semantic without query rejected', async () => {
      const result = await ValidationEngine.validateToolInput(
        'search_tasks_semantic',
        {},
        ToolCategory.UTILITY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('searchQuery or query'))).toBe(true);
    });

    it('L422-425 — export_conversation_json without taskId rejected', async () => {
      const result = await ValidationEngine.validateToolInput(
        'export_conversation_json',
        {},
        ToolCategory.UTILITY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('requires taskId'))).toBe(true);
    });

    it('L428-431 — generate_trace_summary without taskId rejected', async () => {
      const result = await ValidationEngine.validateToolInput(
        'generate_trace_summary',
        {},
        ToolCategory.UTILITY,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('requires taskId'))).toBe(true);
    });

    // L434-439: build_skeleton_cache + force_rebuild → console.warn
    it('L436-438 — build_skeleton_cache force_rebuild warns', async () => {
      const result = await ValidationEngine.validateToolInput(
        'build_skeleton_cache',
        { force_rebuild: true },
        ToolCategory.UTILITY,
      );
      expect(result.isValid).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('force_rebuild=true detected'),
      );
    });
  });

  // ---- validateCacheAntiLeakCompliance (L454-475) ----
  describe('validateCacheAntiLeakCompliance — warning arms', () => {
    // L459-461: forceRebuild / force_rebuild → warning
    it('L459-461 — forceRebuild warns', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        forceRebuild: true,
      } as any);
      expect(result.warnings?.some((w) => w.includes('Force rebuild'))).toBe(true);
    });

    // L464-466: maxResults > 1000 → warning
    it('L464-466 — maxResults>1000 warns', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        maxResults: 2000,
      } as any);
      expect(result.warnings?.some((w) => w.includes('Large maxResults'))).toBe(true);
    });

    // L469-470: truncate === 0 + includeContent → warning
    it('L469-470 — full content export warns', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({
        truncate: 0,
        includeContent: true,
      } as any);
      expect(result.warnings?.some((w) => w.includes('Full content export'))).toBe(true);
    });

    // b44[1] return arm: no warnings → warnings undefined
    it('L367/L473 — clean options → no warnings', () => {
      const result = ValidationEngine.validateCacheAntiLeakCompliance({});
      expect(result.isValid).toBe(true);
      expect(result.warnings).toBeUndefined();
    });
  });

  // ---- generateValidationReport (L486-524) ----
  describe('generateValidationReport — recommendation arms', () => {
    it('L500-501 — QUICK_OVERVIEW recommendation', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        {},
        ToolCategory.DISPLAY,
      );
      expect(report.recommendations.some((r) => r.includes('detailLevel: "skeleton"'))).toBe(true);
    });

    it('L504-505 — EXPORT without prettyPrint recommendation', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.EXPORT_FORMAT,
        { taskId: 't1' },
        ToolCategory.EXPORT,
      );
      expect(report.recommendations.some((r) => r.includes('prettyPrint'))).toBe(true);
    });

    it('L508-509 — maxResults>100 pagination recommendation', async () => {
      const report = await ValidationEngine.generateValidationReport(
        DisplayPreset.QUICK_OVERVIEW,
        { maxResults: 150 } as any,
        ToolCategory.DISPLAY,
      );
      expect(report.recommendations.some((r) => r.includes('pagination'))).toBe(true);
    });
  });
});
