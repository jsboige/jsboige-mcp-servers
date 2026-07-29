/**
 * Regression test — #3006: targetExtension parameter wiring for
 * roosync_mcp_management.
 *
 * Before the fix, `targetExtension` was NOT in the tool schema and was NOT
 * threaded to `getMcpSettingsPath()`. On a dual-install machine (both Roo
 * and Zoo globalStorage directories exist — common during fleet migration),
 * the filesystem probe (#2766 S2) picks Roo (preference), so `read()` always
 * resolved to the roo-cline path. Passing `targetExtension: "zoo"` had no
 * effect because the parameter didn't reach the path resolver.
 *
 * This test creates BOTH directories and verifies that `targetExtension: "zoo"`
 * overrides the probe and forces the zoo-code path.
 *
 * @module roosync/__tests__/mcp-management.target-extension
 * @issue #3006
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId to control the identifier in tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Dual-install host: create BOTH roo-cline AND zoo-code globalStorage.
// This reproduces the migration scenario where the old roo-cline directory
// still exists (with leftover data) but the machine has migrated to Zoo.
const ROO = 'rooveterinaryinc.roo-cline';
const ZOO = 'zoocodeorganization.zoo-code';

const { testAppDataPath, testRooSettingsDir, testRooSettingsPath, testZooSettingsDir, testZooSettingsPath } = vi.hoisted(() => {
  const path = require('path');
  const testAppDataPath = path.join(__dirname, '../../../__test-data__/appdata-mcp-mgmt-dual-install');
  process.env.APPDATA = testAppDataPath;
  // Explicitly unset ROO_EXTENSION_ID to reproduce the no-override case.
  delete process.env.ROO_EXTENSION_ID;

  const globalStorage = path.join(testAppDataPath, 'Code', 'User', 'globalStorage');
  const testRooSettingsDir = path.join(globalStorage, 'rooveterinaryinc.roo-cline', 'settings');
  const testRooSettingsPath = path.join(testRooSettingsDir, 'mcp_settings.json');
  const testZooSettingsDir = path.join(globalStorage, 'zoocodeorganization.zoo-code', 'settings');
  const testZooSettingsPath = path.join(testZooSettingsDir, 'mcp_settings.json');

  return { testAppDataPath, testRooSettingsDir, testRooSettingsPath, testZooSettingsDir, testZooSettingsPath };
});

// Mock getSharedStatePath for RooSyncService isolation
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-mcp-mgmt-target-ext');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import after mocks and env override
import { roosyncMcpManagement, getMcpSettingsPath } from '../mcp-management.js';

describe('roosyncMcpManagement — #3006 targetExtension on dual-install host', () => {
  const rooMcpSettings = {
    mcpServers: {
      'roo-server': {
        command: 'node',
        args: ['path/to/roo-server.js'],
        disabled: false
      }
    }
  };

  const zooMcpSettings = {
    mcpServers: {
      'zoo-server': {
        command: 'node',
        args: ['path/to/zoo-server.js'],
        disabled: false
      }
    }
  };

  beforeEach(() => {
    // Create BOTH directories — this is the dual-install condition
    if (!existsSync(testRooSettingsDir)) {
      mkdirSync(testRooSettingsDir, { recursive: true });
    }
    if (!existsSync(testZooSettingsDir)) {
      mkdirSync(testZooSettingsDir, { recursive: true });
    }
    if (!existsSync(testSharedStatePath)) {
      mkdirSync(testSharedStatePath, { recursive: true });
    }
    writeFileSync(testRooSettingsPath, JSON.stringify(rooMcpSettings, null, 2));
    writeFileSync(testZooSettingsPath, JSON.stringify(zooMcpSettings, null, 2));
  });

  afterEach(() => {
    if (existsSync(testAppDataPath)) {
      rmSync(testAppDataPath, { recursive: true, force: true });
    }
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ================================================================
  // THE TEST THAT BITES — #3006 core proof of non-regression
  // ================================================================
  test('read with targetExtension:"zoo" resolves to zoo-code path on dual-install host', async () => {
    const result = await roosyncMcpManagement({
      action: 'manage',
      subAction: 'read',
      targetExtension: 'zoo'
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('manage');
    expect(result.subAction).toBe('read');
    // Must have read the Zoo config, not the Roo config
    expect(result.details.mcpServers['zoo-server']).toBeDefined();
    expect(result.details.mcpServers['roo-server']).toBeUndefined();
    // The message must show the zoo-code path
    expect(result.message).toContain('zoocodeorganization.zoo-code');
    expect(result.message).not.toContain('rooveterinaryinc.roo-cline');
  });

  test('read with targetExtension:"roo" explicitly resolves to roo-cline path', async () => {
    const result = await roosyncMcpManagement({
      action: 'manage',
      subAction: 'read',
      targetExtension: 'roo'
    });

    expect(result.success).toBe(true);
    expect(result.details.mcpServers['roo-server']).toBeDefined();
    expect(result.details.mcpServers['zoo-server']).toBeUndefined();
    expect(result.message).toContain('rooveterinaryinc.roo-cline');
  });

  test('read without targetExtension uses probe (picks roo-cline when both exist)', async () => {
    // On a dual-install host, the probe prefers Roo (#2766 S2 design)
    const result = await roosyncMcpManagement({
      action: 'manage',
      subAction: 'read'
    });

    expect(result.success).toBe(true);
    expect(result.details.mcpServers['roo-server']).toBeDefined();
    expect(result.message).toContain('rooveterinaryinc.roo-cline');
  });

  // ================================================================
  // Path resolver unit checks
  // ================================================================
  test('getMcpSettingsPath("zoo") returns zoo-code path', () => {
    const resolved = getMcpSettingsPath('zoo');
    expect(resolved).toContain('zoocodeorganization.zoo-code');
    expect(resolved).not.toContain('rooveterinaryinc.roo-cline');
  });

  test('getMcpSettingsPath("roo") returns roo-cline path', () => {
    const resolved = getMcpSettingsPath('roo');
    expect(resolved).toContain('rooveterinaryinc.roo-cline');
    expect(resolved).not.toContain('zoocodeorganization.zoo-code');
  });

  test('getMcpSettingsPath() without arg returns probe result (roo-cline on dual-install)', () => {
    const resolved = getMcpSettingsPath();
    expect(resolved).toContain('rooveterinaryinc.roo-cline');
  });

  // ================================================================
  // Write path verification — targetExtension must thread to writes too
  // ================================================================
  test('update_server_field with targetExtension:"zoo" writes to zoo-code config', async () => {
    // Read first to authorize writes
    await roosyncMcpManagement({
      action: 'manage',
      subAction: 'read',
      targetExtension: 'zoo'
    });

    const result = await roosyncMcpManagement({
      action: 'manage',
      subAction: 'update_server_field',
      server_name: 'zoo-server',
      server_config: { disabled: true },
      targetExtension: 'zoo',
      backup: false
    });

    expect(result.success).toBe(true);

    // Verify the zoo-code config on disk was modified
    const onDisk = JSON.parse(readFileSync(testZooSettingsPath, 'utf-8'));
    expect(onDisk.mcpServers['zoo-server'].disabled).toBe(true);

    // Verify the roo-cline config was NOT modified
    const rooOnDisk = JSON.parse(readFileSync(testRooSettingsPath, 'utf-8'));
    expect(rooOnDisk.mcpServers['roo-server'].disabled).toBe(false);
  });
});
