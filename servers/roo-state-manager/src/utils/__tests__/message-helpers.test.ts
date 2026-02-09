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

    afterEach(() => {
      if (origEnv !== undefined) {
        process.env.ROOSYNC_WORKSPACE_ID = origEnv;
      } else {
        delete process.env.ROOSYNC_WORKSPACE_ID;
      }
    });

    test('should return workspace ID when set', () => {
      process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
      expect(getLocalWorkspaceId()).toBe('roo-extensions');
    });

    test('should return undefined when not set', () => {
      delete process.env.ROOSYNC_WORKSPACE_ID;
      expect(getLocalWorkspaceId()).toBeUndefined();
    });

    test('should return undefined for empty string', () => {
      process.env.ROOSYNC_WORKSPACE_ID = '';
      expect(getLocalWorkspaceId()).toBeUndefined();
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

    test('should return machine:workspace when workspace set', () => {
      process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
      process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
      expect(getLocalFullId()).toBe('myia-ai-01:roo-extensions');
    });

    test('should return machine only when no workspace', () => {
      process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
      delete process.env.ROOSYNC_WORKSPACE_ID;
      expect(getLocalFullId()).toBe('myia-ai-01');
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
    test('broadcast "all" matches any machine', () => {
      expect(matchesRecipient('all', 'myia-ai-01')).toBe(true);
      expect(matchesRecipient('all', 'myia-po-2024', 'roo-extensions')).toBe(true);
    });

    test('broadcast "All" matches any machine', () => {
      expect(matchesRecipient('All', 'myia-ai-01')).toBe(true);
    });

    test('machine-only target matches same machine (no workspace)', () => {
      expect(matchesRecipient('myia-ai-01', 'myia-ai-01')).toBe(true);
    });

    test('machine-only target matches same machine (with workspace)', () => {
      expect(matchesRecipient('myia-ai-01', 'myia-ai-01', 'roo-extensions')).toBe(true);
    });

    test('machine-only target does NOT match different machine', () => {
      expect(matchesRecipient('myia-ai-01', 'myia-po-2024')).toBe(false);
    });

    test('workspace-specific target matches exact workspace', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-ai-01', 'roo-extensions')).toBe(true);
    });

    test('workspace-specific target does NOT match different workspace', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-ai-01', 'vllm-hosting')).toBe(false);
    });

    test('workspace-specific target does NOT match machine without workspace', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-ai-01')).toBe(false);
    });

    test('workspace-specific target does NOT match different machine', () => {
      expect(matchesRecipient('myia-ai-01:roo-extensions', 'myia-po-2024', 'roo-extensions')).toBe(false);
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
