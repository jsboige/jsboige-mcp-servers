/**
 * Tests unitaires pour UnifiedApiGateway
 *
 * Couvre les fonctionnalités principales du Gateway unifié
 * qui orchestre les 32 outils MCP roo-state-manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UnifiedApiGateway,
  createUnifiedApiGateway,
  DisplayPreset,
  INTELLIGENT_PRESETS
} from '../UnifiedApiGateway.js';
import { ToolCategory, ProcessingLevel } from '../../interfaces/UnifiedToolInterface.js';
import { GenericErrorCode } from '../../types/errors.js';

describe('UnifiedApiGateway', () => {
  let gateway: UnifiedApiGateway;

  beforeEach(() => {
    gateway = new UnifiedApiGateway({ debugMode: false });
  });

  describe('Constructor', () => {
    it('should create instance with default config', () => {
      expect(gateway).toBeDefined();
      expect(gateway.getMetrics().totalRequests).toBe(0);
    });

    it('should accept custom config', () => {
      const customGateway = new UnifiedApiGateway({
        debugMode: true,
        immediateProcessingTimeout: 10000
      });
      expect(customGateway).toBeDefined();
    });

    it('should initialize metrics correctly', async () => {
      // Add small delay to ensure uptime is measurable
      await new Promise(resolve => setTimeout(resolve, 1));
      const metrics = gateway.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.immediateProcessingCount).toBe(0);
      expect(metrics.backgroundProcessingCount).toBe(0);
      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('execute - QUICK_OVERVIEW preset', () => {
    it('should execute quick overview preset successfully', async () => {
      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.results).toBeInstanceOf(Array);
    });

    it('should merge options with preset defaults', async () => {
      const customOptions = {
        truncate: 100,
        maxResults: 50
      };

      const result = await gateway.execute(DisplayPreset.QUICK_OVERVIEW, customOptions);

      expect(result.success).toBe(true);
      expect(result.metadata?.processingLevel).toBeDefined();
    });

    it('should increment immediate processing count', async () => {
      const beforeMetrics = gateway.getMetrics();
      await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      const afterMetrics = gateway.getMetrics();

      expect(afterMetrics.totalRequests).toBe(beforeMetrics.totalRequests + 1);
      expect(afterMetrics.immediateProcessingCount).toBeGreaterThan(beforeMetrics.immediateProcessingCount);
    });
  });

  describe('execute - DETAILED_ANALYSIS preset', () => {
    it('should execute detailed analysis preset successfully', async () => {
      const result = await gateway.execute(DisplayPreset.DETAILED_ANALYSIS);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should use background processing level', async () => {
      const result = await gateway.execute(DisplayPreset.DETAILED_ANALYSIS);

      expect(result.success).toBe(true);
      // Background processing returns a job ID
      expect(result.data?.jobId).toBeDefined();
      expect(result.data?.status).toBe('processing');
    });
  });

  describe('execute - SEARCH_RESULTS preset', () => {
    it('should execute search results preset successfully', async () => {
      const result = await gateway.execute(DisplayPreset.SEARCH_RESULTS, {
        maxResults: 20
      });

      expect(result.success).toBe(true);
    });

    it('should validate search-specific options', async () => {
      const result = await gateway.execute(DisplayPreset.SEARCH_RESULTS, {
        maxResults: 10
      });

      expect(result.success).toBe(true);
    });
  });

  describe('execute - EXPORT_FORMAT preset', () => {
    it('should execute export format preset successfully', async () => {
      const result = await gateway.execute(DisplayPreset.EXPORT_FORMAT, {
        outputFormat: 'json'
      });

      expect(result.success).toBe(true);
    });

    it('should validate export formats', async () => {
      const result = await gateway.execute(DisplayPreset.EXPORT_FORMAT, {
        outputFormat: 'csv'
      });

      expect(result.success).toBe(true);
    });
  });

  describe('execute - TREE_NAVIGATION preset', () => {
    it('should execute tree navigation preset successfully', async () => {
      const result = await gateway.execute(DisplayPreset.TREE_NAVIGATION);

      expect(result.success).toBe(true);
    });

    it('should handle mixed processing level', async () => {
      const result = await gateway.execute(DisplayPreset.TREE_NAVIGATION, {
        forceRebuild: false
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should reject invalid preset', async () => {
      await expect(gateway.execute('invalid' as any)).rejects.toThrow();
    });

    it('should validate truncate option for display category', async () => {
      await expect(gateway.execute(DisplayPreset.QUICK_OVERVIEW, {
        truncate: -1
      })).rejects.toThrow('Validation failed');
    });

    it('should validate maxResults option for search category', async () => {
      await expect(gateway.execute(DisplayPreset.SEARCH_RESULTS, {
        maxResults: 0
      })).rejects.toThrow('Validation failed');
    });

    it('should validate outputFormat for export category', async () => {
      await expect(gateway.execute(DisplayPreset.EXPORT_FORMAT, {
        outputFormat: 'invalid' as any
      })).rejects.toThrow('Validation failed');
    });
  });

  describe('INTELLIGENT_PRESETS', () => {
    it('should have all required presets', () => {
      expect(INTELLIGENT_PRESETS).toBeDefined();
      expect(INTELLIGENT_PRESETS[DisplayPreset.QUICK_OVERVIEW]).toBeDefined();
      expect(INTELLIGENT_PRESETS[DisplayPreset.DETAILED_ANALYSIS]).toBeDefined();
      expect(INTELLIGENT_PRESETS[DisplayPreset.SEARCH_RESULTS]).toBeDefined();
      expect(INTELLIGENT_PRESETS[DisplayPreset.EXPORT_FORMAT]).toBeDefined();
      expect(INTELLIGENT_PRESETS[DisplayPreset.TREE_NAVIGATION]).toBeDefined();
    });

    it('should have correct category for each preset', () => {
      expect(INTELLIGENT_PRESETS[DisplayPreset.QUICK_OVERVIEW].category).toBe(ToolCategory.DISPLAY);
      expect(INTELLIGENT_PRESETS[DisplayPreset.SEARCH_RESULTS].category).toBe(ToolCategory.SEARCH);
      expect(INTELLIGENT_PRESETS[DisplayPreset.EXPORT_FORMAT].category).toBe(ToolCategory.EXPORT);
      expect(INTELLIGENT_PRESETS[DisplayPreset.TREE_NAVIGATION].category).toBe(ToolCategory.UTILITY);
    });

    it('should have processing level defined for each preset', () => {
      const quickOverview = INTELLIGENT_PRESETS[DisplayPreset.QUICK_OVERVIEW];
      expect(quickOverview.processingLevel).toBe(ProcessingLevel.IMMEDIATE);

      const detailedAnalysis = INTELLIGENT_PRESETS[DisplayPreset.DETAILED_ANALYSIS];
      expect(detailedAnalysis.processingLevel).toBe(ProcessingLevel.BACKGROUND);

      const treeNavigation = INTELLIGENT_PRESETS[DisplayPreset.TREE_NAVIGATION];
      expect(treeNavigation.processingLevel).toBe(ProcessingLevel.MIXED);
    });

    it('should have tools array for each preset', () => {
      Object.values(INTELLIGENT_PRESETS).forEach(preset => {
        expect(preset.tools).toBeInstanceOf(Array);
        expect(preset.tools.length).toBeGreaterThan(0);
      });
    });

    it('should have default options for each preset', () => {
      Object.values(INTELLIGENT_PRESETS).forEach(preset => {
        expect(preset.defaultOptions).toBeDefined();
        expect(typeof preset.defaultOptions).toBe('object');
      });
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      const health = await gateway.healthCheck();

      expect(health.status).toBeDefined();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);
      expect(health.checks).toBeDefined();
      expect(health.metrics).toBeDefined();
    });

    it('should include all required checks', async () => {
      const health = await gateway.healthCheck();

      expect(health.checks.cacheAntiLeak).toBeDefined();
      expect(health.checks.averageProcessingTime).toBeDefined();
      expect(health.checks.servicesAvailable).toBeDefined();
    });
  });

  describe('getMetrics', () => {
    it('should return metrics with uptime', async () => {
      // Add small delay to ensure uptime is measurable
      await new Promise(resolve => setTimeout(resolve, 1));
      const metrics = gateway.getMetrics();

      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
      expect(metrics.totalRequests).toBe(0);
    });

    it('should update metrics after execution', async () => {
      await gateway.execute(DisplayPreset.QUICK_OVERVIEW);

      const metrics = gateway.getMetrics();
      expect(metrics.totalRequests).toBe(1);
    });
  });

  describe('createUnifiedApiGateway factory', () => {
    it('should create gateway instance', () => {
      const instance = createUnifiedApiGateway();

      expect(instance).toBeInstanceOf(UnifiedApiGateway);
    });

    it('should pass config to constructor', () => {
      const instance = createUnifiedApiGateway({
        debugMode: true,
        immediateProcessingTimeout: 10000
      });

      expect(instance).toBeInstanceOf(UnifiedApiGateway);
    });
  });

  describe('Error handling', () => {
    it('should handle execution errors gracefully', async () => {
      // Test with invalid preset that will throw
      await expect(gateway.execute('invalid_preset' as any)).rejects.toThrow();
    });

    it('should update metrics even on error', async () => {
      const beforeMetrics = gateway.getMetrics();

      try {
        await gateway.execute('invalid' as any);
      } catch {
        // Expected to throw
      }

      const afterMetrics = gateway.getMetrics();
      expect(afterMetrics.totalRequests).toBeGreaterThan(beforeMetrics.totalRequests);
    });
  });

  describe('Cache Anti-Leak protection', () => {
    it('should have cache protection config', () => {
      const customGateway = new UnifiedApiGateway({
        cacheProtection: {
          maxTrafficGB: 220,
          consistencyCheckHours: 24,
          minReindexIntervalHours: 4,
          enabled: true,
          alerts: {
            memoryThresholdGB: 200,
            processingTimeoutMs: 30000
          }
        }
      });

      expect(customGateway).toBeDefined();
    });

    it('should check cache anti-leak during execution', async () => {
      const customGateway = new UnifiedApiGateway({
        cacheProtection: {
          maxTrafficGB: 220,
          consistencyCheckHours: 24,
          minReindexIntervalHours: 4,
          enabled: true,
          alerts: {
            memoryThresholdGB: 200,
            processingTimeoutMs: 30000
          }
        }
      });

      const result = await customGateway.execute(DisplayPreset.QUICK_OVERVIEW);
      expect(result.success).toBe(true);
    });
  });

  describe('Background processing', () => {
    it('should return job ID for background processing', async () => {
      const result = await gateway.execute(DisplayPreset.DETAILED_ANALYSIS);

      expect(result.data?.jobId).toBeDefined();
      expect(result.data?.jobId).toMatch(/^bg_\d+_[a-z0-9]+$/);
    });

    it('should include estimated completion time', async () => {
      const result = await gateway.execute(DisplayPreset.DETAILED_ANALYSIS);

      expect(result.metadata?.estimatedCompletionTime).toBeDefined();
      expect(result.metadata?.estimatedCompletionTime).toBeInstanceOf(Date);
    });
  });

  describe('Processing levels', () => {
    it('should use immediate processing for QUICK_OVERVIEW', async () => {
      const beforeMetrics = gateway.getMetrics();
      await gateway.execute(DisplayPreset.QUICK_OVERVIEW);
      const afterMetrics = gateway.getMetrics();

      expect(afterMetrics.immediateProcessingCount).toBeGreaterThan(beforeMetrics.immediateProcessingCount);
    });

    it('should use background processing for DETAILED_ANALYSIS', async () => {
      const beforeMetrics = gateway.getMetrics();
      await gateway.execute(DisplayPreset.DETAILED_ANALYSIS);
      const afterMetrics = gateway.getMetrics();

      expect(afterMetrics.backgroundProcessingCount).toBeGreaterThan(beforeMetrics.backgroundProcessingCount);
    });
  });
});
