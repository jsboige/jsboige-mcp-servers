/**
 * Tests for message-helpers utility functions
 * Covers workspace-related helpers added in #434
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock os module (globally mocked in vitest setup for other tests)
vi.unmock('os');

import {
  getLocalMachineId,
  getLocalWorkspaceId,
  getLocalFullId,
  parseMachineWorkspace,
  matchesRecipient,
  normalizeWorkspaceId,
  formatDate,
  getPriorityIcon,
  getStatusIcon
} from '../message-helpers.js';

describe('message-helpers', () => {
  describe('getLocalMachineId', () => {
    const origEnv = process.env.ROOSYNC_MACHINE_ID;

    afterEach(() => {
      if (origEnv !== undefined) {
        process.env.ROOSYNC_MACHINE_ID = origEnv;
      } else {
        delete process.env.ROOSYNC_MACHINE_ID;
      }
    });

    test('should return ROOSYNC_MACHINE_ID when set', () => {
      process.env.ROOSYNC_MACHINE_ID = 'test-machine';
      expect(getLocalMachineId()).toBe('test-machine');
    });

    test('should fallback to hostname when env not set', () => {
      delete process.env.ROOSYNC_MACHINE_ID;
      const id = getLocalMachineId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });
  });

  describe('getLocalWorkspaceId', () => {
    const origEnv = process.env.ROOSYNC_WORKSPACE_ID;
    const origWorkspacePath = process.env.WORKSPACE_PATH;

    afterEach(() => {
      if (origEnv !== undefined) {
        process.env.ROOSYNC_WORKSPACE_ID = origEnv;
      } else {
        delete process.env.ROOSYNC_WORKSPACE_ID;
      }
      if (origWorkspacePath !== undefined) {
        process.env.WORKSPACE_PATH = origWorkspacePath;
      } else {
        delete process.env.WORKSPACE_PATH;
      }
    });

    test('should return ROOSYNC_WORKSPACE_ID when set (override)', () => {
      process.env.ROOSYNC_WORKSPACE_ID = 'custom-workspace';
      expect(getLocalWorkspaceId()).toBe('custom-workspace');
    });

    test('should use WORKSPACE_PATH basename when ROOSYNC_WORKSPACE_ID not set', () => {
      delete process.env.ROOSYNC_WORKSPACE_ID;
      process.env.WORKSPACE_PATH = 'd:\\roo-extensions';
      expect(getLocalWorkspaceId()).toBe('roo-extensions');
    });

    test('should use WORKSPACE_PATH with forward slashes', () => {
      delete process.env.ROOSYNC_WORKSPACE_ID;
      process.env.WORKSPACE_PATH = 'D:/Open-WebUI/myia-open-webui';
      expect(getLocalWorkspaceId()).toBe('myia-open-webui');
    });

    test('should prefer ROOSYNC_WORKSPACE_ID over WORKSPACE_PATH', () => {
      process.env.ROOSYNC_WORKSPACE_ID = 'explicit-override';
      process.env.WORKSPACE_PATH = 'd:\\some-other-workspace';
      expect(getLocalWorkspaceId()).toBe('explicit-override');
    });

    test('should auto-detect from process.cwd() when no env vars set', () => {
      delete process.env.ROOSYNC_WORKSPACE_ID;
      delete process.env.WORKSPACE_PATH;
      const id = getLocalWorkspaceId();
      // Should return the current directory name (not undefined anymore)
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      expect(id).not.toBe('undefined');
    });

    test('should auto-detect even for empty string env var', () => {
      process.env.ROOSYNC_WORKSPACE_ID = '';
      delete process.env.WORKSPACE_PATH;
      const id = getLocalWorkspaceId();
      // Empty string should trigger auto-detection
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });
  });

  describe('getLocalFullId', () => {
    const origMachine = process.env.ROOSYNC_MACHINE_ID;
    const origWorkspace = process.env.ROOSYNC_WORKSPACE_ID;

    afterEach(() => {
      if (origMachine !== undefined) {
        process.env.ROOSYNC_MACHINE_ID = origMachine;
      } else {
        delete process.env.ROOSYNC_MACHINE_ID;
      }
      if (origWorkspace !== undefined) {
        process.env.ROOSYNC_WORKSPACE_ID = origWorkspace;
      } else {
        delete process.env.ROOSYNC_WORKSPACE_ID;
      }
    });

    test('should return machine:workspace when both env vars set', () => {
      process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
      process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
      expect(getLocalFullId()).toBe('myia-ai-01:roo-extensions');
    });

    test('should return machine:auto-detected-workspace when only machine env set', () => {
      process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
      delete process.env.ROOSYNC_WORKSPACE_ID;
      const result = getLocalFullId();
      // Should always include workspace now (auto-detected)
      expect(result).toMatch(/^myia-ai-01:.+$/);
    });
  });

  describe('parseMachineWorkspace', () => {
    test('should parse machine:workspace format', () => {
      const result = parseMachineWorkspace('myia-ai-01:roo-extensions');
      expect(result).toEqual({
        machineId: 'myia-ai-01',
        workspaceId: 'roo-extensions'
      });
    });

    test('should parse machine-only format', () => {
      const result = parseMachineWorkspace('myia-ai-01');
      expect(result).toEqual({
        machineId: 'myia-ai-01',
        workspaceId: undefined
      });
    });

    test('should handle workspace with colons (first colon is separator)', () => {
      const result = parseMachineWorkspace('myia-ai-01:workspace:with:colons');
      expect(result).toEqual({
        machineId: 'myia-ai-01',
        workspaceId: 'workspace:with:colons'
      });
    });

    test('should handle special broadcast values', () => {
      expect(parseMachineWorkspace('all')).toEqual({ machineId: 'all', workspaceId: undefined });
      expect(parseMachineWorkspace('All')).toEqual({ machineId: 'All', workspaceId: undefined });
    });
  });

  describe('matchesRecipient', () => {
    test('broadcast "all" matches any machine/workspace', () => {
      expect(matchesRecipient('all', 'myia-ai-01', 'roo-extensions')).toBe(true);
      expect(matchesRecipient('all', 'myia-po-2024', 'other-workspace')).toBe(true);
    });

    test('broadcast "All" matches any machine/workspace', () => {
      expect(matchesRecipient('All', 'myia-ai-01', 'roo-extensions')).toBe(true);
    });

    test('machine-only target matches same machine (any workspace)', () => {
      expect(matchesRecipient('myia-ai-01', 'myia-ai-01', 'roo-extensions')).toBe(true);
      expect(matchesRecipient('myia-ai-01', 'myia-ai-01', 'other-workspace')).toBe(true);
    });

    test('machine-only target does NOT match different machine', () => {
      expect(matchesRecipient('myia-ai-01', 'myia-po-2024', 'roo-extensions')).toBe(false);
    });

    test('workspace-specific target matches exact workspace', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-ai-01', 'roo-extensions')).toBe(true);
    });

    test('workspace-specific target does NOT match different workspace', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-ai-01', 'vllm-hosting')).toBe(false);
    });

    test('workspace-specific target does NOT match different machine (even with same workspace)', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-po-2024', 'roo-extensions')).toBe(false);
    });

    // Bug fix: full Windows path vs basename (#msg-20260223T133031-9r2dvm)
    test('workspace target with full Windows path matches basename', () => {
      expect(matchesRecipient('myia-ai-01:D:\\vllm', 'myia-ai-01', 'vllm')).toBe(true);
    });

    test('workspace target with full Windows path (forward slashes) matches basename', () => {
      expect(matchesRecipient('myia-ai-01:D:/vllm', 'myia-ai-01', 'vllm')).toBe(true);
    });

    test('workspace target with full Unix path matches basename', () => {
      expect(matchesRecipient('myia-ai-01:/home/user/roo-extensions', 'myia-ai-01', 'roo-extensions')).toBe(true);
    });

    test('workspace comparison is case-insensitive (Windows compat)', () => {
      expect(matchesRecipient('myia-ai-01:Vllm', 'myia-ai-01', 'vllm')).toBe(true);
      expect(matchesRecipient('myia-ai-01:vllm', 'myia-ai-01', 'VLLM')).toBe(true);
    });

    test('workspace target with full path does NOT match different workspace', () => {
      expect(matchesRecipient('myia-ai-01:D:\\vllm', 'myia-ai-01', 'roo-extensions')).toBe(false);
    });

    // Ghost workspace backward compatibility (cwd bug fix)
    test('ghost workspace "roo-state-manager" matches ANY workspace on same machine', () => {
      expect(matchesRecipient('myia-ai-01:roo-state-manager', 'myia-ai-01', 'roo-extensions')).toBe(true);
      expect(matchesRecipient('myia-ai-01:roo-state-manager', 'myia-ai-01', 'myia-open-webui')).toBe(true);
      expect(matchesRecipient('myia-ai-01:roo-state-manager', 'myia-ai-01', 'livresagites')).toBe(true);
    });

    test('ghost workspace does NOT match different machine', () => {
      expect(matchesRecipient('myia-ai-01:roo-state-manager', 'myia-po-2024', 'roo-extensions')).toBe(false);
    });
  });

  describe('normalizeWorkspaceId', () => {
    test('returns basename of full Windows path', () => {
      expect(normalizeWorkspaceId('D:\\vllm')).toBe('vllm');
    });

    test('returns basename of full Unix path', () => {
      expect(normalizeWorkspaceId('/home/user/roo-extensions')).toBe('roo-extensions');
    });

    test('returns lowercase basename', () => {
      expect(normalizeWorkspaceId('D:\\MyProject')).toBe('myproject');
    });

    test('returns simple name unchanged (lowercased)', () => {
      expect(normalizeWorkspaceId('roo-extensions')).toBe('roo-extensions');
    });
  });

  describe('formatDate', () => {
    test('should format ISO date to French format', () => {
      const result = formatDate('2026-01-29T15:30:00Z');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('getPriorityIcon', () => {
    test('should return correct icons', () => {
      expect(getPriorityIcon('URGENT')).toBeTruthy();
      expect(getPriorityIcon('HIGH')).toBeTruthy();
      expect(getPriorityIcon('MEDIUM')).toBeTruthy();
      expect(getPriorityIcon('LOW')).toBeTruthy();
    });
  });

  describe('getStatusIcon', () => {
    test('should return correct icons', () => {
      expect(getStatusIcon('unread')).toBeTruthy();
      expect(getStatusIcon('read')).toBeTruthy();
      expect(getStatusIcon('archived')).toBeTruthy();
    });
  });
});
