/**
 * Tests unitaires pour UnifiedToolInterface
 *
 * Valide les interfaces, types et constantes unifiées
 * pour les 32 outils MCP roo-state-manager
 */

import { describe, it, expect } from 'vitest';
import {
  ToolCategory,
  ProcessingLevel,
  DisplayPreset,
  type DisplayPresetType,
  type CacheStrategy,
  type DisplayOptions,
  type ValidationResult,
  type DisplayResult,
  type CacheAntiLeakConfig
} from '../UnifiedToolInterface.js';

describe('ToolCategory', () => {
  it('should have all 5 categories', () => {
    expect(ToolCategory.DISPLAY).toBe('display');
    expect(ToolCategory.SEARCH).toBe('search');
    expect(ToolCategory.SUMMARY).toBe('summary');
    expect(ToolCategory.EXPORT).toBe('export');
    expect(ToolCategory.UTILITY).toBe('utility');
  });

  it('should have distinct values', () => {
    const values = Object.values(ToolCategory);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe('ProcessingLevel', () => {
  it('should have 3 processing levels', () => {
    expect(ProcessingLevel.IMMEDIATE).toBe('immediate');
    expect(ProcessingLevel.BACKGROUND).toBe('background');
    expect(ProcessingLevel.MIXED).toBe('hybrid');
  });

  it('should have distinct values', () => {
    const values = Object.values(ProcessingLevel);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe('DisplayPreset', () => {
  it('should have 5 presets', () => {
    expect(DisplayPreset.QUICK_OVERVIEW).toBe('quick');
    expect(DisplayPreset.DETAILED_ANALYSIS).toBe('detailed');
    expect(DisplayPreset.SEARCH_RESULTS).toBe('search');
    expect(DisplayPreset.EXPORT_FORMAT).toBe('export');
    expect(DisplayPreset.TREE_NAVIGATION).toBe('tree');
  });

  it('should have string values', () => {
    expect(typeof DisplayPreset.QUICK_OVERVIEW).toBe('string');
    expect(typeof DisplayPreset.DETAILED_ANALYSIS).toBe('string');
    expect(typeof DisplayPreset.SEARCH_RESULTS).toBe('string');
    expect(typeof DisplayPreset.EXPORT_FORMAT).toBe('string');
    expect(typeof DisplayPreset.TREE_NAVIGATION).toBe('string');
  });
});

describe('DisplayPresetType', () => {
  it('should accept valid preset values', () => {
    const validPresets: DisplayPresetType[] = [
      DisplayPreset.QUICK_OVERVIEW,
      DisplayPreset.DETAILED_ANALYSIS,
      DisplayPreset.SEARCH_RESULTS,
      DisplayPreset.EXPORT_FORMAT,
      DisplayPreset.TREE_NAVIGATION
    ];

    validPresets.forEach(preset => {
      expect(typeof preset).toBe('string');
    });
  });

  it('should only allow preset const values', () => {
    const quick: DisplayPresetType = DisplayPreset.QUICK_OVERVIEW;
    const detailed: DisplayPresetType = DisplayPreset.DETAILED_ANALYSIS;
    const search: DisplayPresetType = DisplayPreset.SEARCH_RESULTS;
    const exportFormat: DisplayPresetType = DisplayPreset.EXPORT_FORMAT;
    const tree: DisplayPresetType = DisplayPreset.TREE_NAVIGATION;

    expect(quick).toBe('quick');
    expect(detailed).toBe('detailed');
    expect(search).toBe('search');
    expect(exportFormat).toBe('export');
    expect(tree).toBe('tree');
  });
});

describe('CacheStrategy type', () => {
  it('should define valid cache strategies', () => {
    const strategies: CacheStrategy[] = ['aggressive', 'moderate', 'conservative', 'bypass'];

    expect(strategies).toContain('aggressive');
    expect(strategies).toContain('moderate');
    expect(strategies).toContain('conservative');
    expect(strategies).toContain('bypass');
  });
});

describe('DisplayOptions', () => {
  it('should accept truncate option', () => {
    const options: DisplayOptions = { truncate: 50 };
    expect(options.truncate).toBe(50);
  });

  it('should accept maxResults option', () => {
    const options: DisplayOptions = { maxResults: 20 };
    expect(options.maxResults).toBe(20);
  });

  it('should accept detailLevel option', () => {
    const options1: DisplayOptions = { detailLevel: 'skeleton' };
    const options2: DisplayOptions = { detailLevel: 'summary' };
    const options3: DisplayOptions = { detailLevel: 'full' };

    expect(options1.detailLevel).toBe('skeleton');
    expect(options2.detailLevel).toBe('summary');
    expect(options3.detailLevel).toBe('full');
  });

  it('should accept outputFormat option', () => {
    const formats: Array<'json' | 'csv' | 'xml' | 'markdown' | 'html'> = ['json', 'csv', 'xml', 'markdown', 'html'];

    formats.forEach(format => {
      const options: DisplayOptions = { outputFormat: format };
      expect(options.outputFormat).toBe(format);
    });
  });

  it('should accept includeContent option', () => {
    const options1: DisplayOptions = { includeContent: true };
    const options2: DisplayOptions = { includeContent: false };

    expect(options1.includeContent).toBe(true);
    expect(options2.includeContent).toBe(false);
  });

  it('should accept export options', () => {
    const options: DisplayOptions = {
      prettyPrint: true,
      includeCss: true
    };

    expect(options.prettyPrint).toBe(true);
    expect(options.includeCss).toBe(true);
  });

  it('should accept search options', () => {
    const options: DisplayOptions = {
      searchQuery: 'test query',
      maxResults: 10
    };

    expect(options.searchQuery).toBe('test query');
    expect(options.maxResults).toBe(10);
  });

  it('should accept entity IDs', () => {
    const options: DisplayOptions = {
      taskId: 'task-123',
      conversationId: 'conv-456',
      rootTaskId: 'root-789'
    };

    expect(options.taskId).toBe('task-123');
    expect(options.conversationId).toBe('conv-456');
    expect(options.rootTaskId).toBe('root-789');
  });

  it('should accept navigation options', () => {
    const options: DisplayOptions = {
      maxDepth: 5,
      viewMode: 'chain',
      includeSiblings: true
    };

    expect(options.maxDepth).toBe(5);
    expect(options.viewMode).toBe('chain');
    expect(options.includeSiblings).toBe(true);
  });

  it('should accept filter and sort options', () => {
    const options: DisplayOptions = {
      sortBy: 'lastActivity',
      sortOrder: 'desc',
      hasApiHistory: true,
      hasUiMessages: false
    };

    expect(options.sortBy).toBe('lastActivity');
    expect(options.sortOrder).toBe('desc');
    expect(options.hasApiHistory).toBe(true);
    expect(options.hasUiMessages).toBe(false);
  });

  it('should accept dry run options', () => {
    const options1: DisplayOptions = { dryRun: true };
    const options2: DisplayOptions = { dry_run: true };

    expect(options1.dryRun).toBe(true);
    expect(options2.dry_run).toBe(true);
  });
});

describe('ValidationResult', () => {
  it('should create valid result with isValid true', () => {
    const result: ValidationResult = {
      isValid: true,
      errors: []
    };

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should create valid result with isValid false', () => {
    const result: ValidationResult = {
      isValid: false,
      errors: ['Error 1', 'Error 2']
    };

    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('should include optional warnings', () => {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: ['Warning 1', 'Warning 2']
    };

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain('Warning 1');
  });
});

describe('DisplayResult', () => {
  it('should create successful result', () => {
    const result: DisplayResult = {
      success: true,
      data: { message: 'Success' }
    };

    expect(result.success).toBe(true);
    expect(result.data?.message).toBe('Success');
  });

  it('should create failed result', () => {
    const result: DisplayResult = {
      success: false,
      errors: ['Error 1', 'Error 2']
    };

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('should include metadata', () => {
    const result: DisplayResult = {
      success: true,
      data: {},
      metadata: {
        processingLevel: ProcessingLevel.IMMEDIATE,
        executionTime: new Date(),
        toolsCount: 5
      }
    };

    expect(result.metadata?.processingLevel).toBe(ProcessingLevel.IMMEDIATE);
    expect(result.metadata?.toolsCount).toBe(5);
    expect(result.metadata?.executionTime).toBeInstanceOf(Date);
  });
});

describe('CacheAntiLeakConfig', () => {
  it('should create valid config with defaults', () => {
    const config: CacheAntiLeakConfig = {
      maxTrafficGB: 220,
      consistencyCheckHours: 24,
      minReindexIntervalHours: 4,
      enabled: true,
      alerts: {
        memoryThresholdGB: 200,
        processingTimeoutMs: 30000
      }
    };

    expect(config.maxTrafficGB).toBe(220);
    expect(config.consistencyCheckHours).toBe(24);
    expect(config.minReindexIntervalHours).toBe(4);
    expect(config.enabled).toBe(true);
    expect(config.alerts.memoryThresholdGB).toBe(200);
    expect(config.alerts.processingTimeoutMs).toBe(30000);
  });

  it('should allow custom values', () => {
    const config: CacheAntiLeakConfig = {
      maxTrafficGB: 100,
      consistencyCheckHours: 12,
      minReindexIntervalHours: 2,
      enabled: false,
      alerts: {
        memoryThresholdGB: 80,
        processingTimeoutMs: 15000
      }
    };

    expect(config.maxTrafficGB).toBe(100);
    expect(config.enabled).toBe(false);
  });
});

describe('Type compatibility', () => {
  it('should allow DisplayPresetType assignment from DisplayPreset', () => {
    const presetType: DisplayPresetType = DisplayPreset.QUICK_OVERVIEW;
    expect(presetType).toBe('quick');
  });

  it('should preserve type checking for invalid values', () => {
    // This test validates that the type system works correctly
    // Invalid values should not compile (TypeScript handles this at compile time)
    const validPreset: DisplayPresetType = DisplayPreset.SEARCH_RESULTS;
    expect(validPreset).toBe('search');
  });
});

describe('Edge cases', () => {
  it('should handle empty DisplayOptions', () => {
    const options: DisplayOptions = {};
    expect(Object.keys(options)).toHaveLength(0);
  });

  it('should handle null-like values in DisplayOptions', () => {
    const options: DisplayOptions = {
      truncate: 0,
      maxResults: 0,
      startIndex: 0,
      endIndex: 0
    };

    expect(options.truncate).toBe(0);
    expect(options.maxResults).toBe(0);
  });

  it('should handle ValidationResult with no errors', () => {
    const result: ValidationResult = {
      isValid: true,
      errors: []
    };

    expect(result.errors).toHaveLength(0);
    expect(result.isValid).toBe(true);
  });
});
