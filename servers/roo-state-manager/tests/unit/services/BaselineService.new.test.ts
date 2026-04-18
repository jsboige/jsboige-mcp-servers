import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BaselineService } from '../../../src/services/BaselineService';

describe('BaselineService Private Methods - Quick Test', () => {
  let service: BaselineService;

  beforeEach(() => {
    service = new BaselineService();
    vi.clearAllMocks();
  });

  describe('Private methods', () => {
    it('should format decision to markdown', () => {
      // @ts-ignore - Accéder à la méthode privée pour test
      const markdown = service['formatDecisionToMarkdown']({
        id: 'test-decision',
        action: 'sync_to_baseline',
        description: 'Test decision',
        status: 'pending',
        severity: 'MEDIUM',
        category: 'config',
        differenceId: 'roo.userSettings.theme',
        machineId: 'test-machine',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, '2025-01-01T00:00:00.000Z');

      expect(markdown).toContain('## Décision');
      expect(markdown).toContain('test-decision');
    });

    it('should extract field from markdown lines', () => {
      // @ts-ignore - Accéder à la méthode privée pour test
      const action = service['extractField']([
        '### test-decision',
        '```',
        'action: sync_to_baseline',
        'description: Test decision',
        '```'
      ], 'action');

      expect(action).toBe('sync_to_baseline');
    });

    it('should return correct emoji for status', () => {
      // @ts-ignore - Accéder à la méthode privée pour test
      expect(service['getStatusEmoji']('pending')).toBe('⏳');
      expect(service['getStatusEmoji']('approved')).toBe('✅');
      expect(service['getStatusEmoji']('rejected')).toBe('❌');
      expect(service['getStatusEmoji']('applied')).toBe('✅');
    });

    it('should return correct emoji for severity', () => {
      // @ts-ignore - Accéder à la méthode privée pour test
      expect(service['getSeverityEmoji']('LOW')).toBe('🟢');
      expect(service['getSeverityEmoji']('MEDIUM')).toBe('🟡');
      expect(service['getSeverityEmoji']('WARNING')).toBe('🟡');
      expect(service['getSeverityEmoji']('HIGH')).toBe('🟠');
      expect(service['getSeverityEmoji']('CRITICAL')).toBe('🔴');
    });

    it('should create a default baseline', () => {
      // @ts-ignore - Accéder à la méthode privée pour test
      const baseline = service['createDefaultBaseline']();

      expect(baseline).toHaveProperty('version');
      expect(baseline).toHaveProperty('baselineId');
      expect(baseline).toHaveProperty('machineId');
      expect(baseline).toHaveProperty('timestamp');
      expect(baseline).toHaveProperty('machines');
      expect(baseline.machines).toHaveLength(1);
    });
  });
});