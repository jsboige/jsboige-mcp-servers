/**
 * Regression test — #2766 S2: roosync_mcp_management on a Zoo-only host.
 *
 * Before the fix, getMcpSettingsPath() delegated to the env-only
 * getExtensionId() (default 'rooveterinaryinc.roo-cline'). On a machine where
 * only `zoocodeorganization.zoo-code` is installed and no ROO_EXTENSION_ID
 * override is set (po-2026 native, post-decommission ai-01/web1, po-204 where
 * Roo is uninstalled), the path resolved to the absent roo-cline globalStorage
 * → fs.readFile threw ENOENT → the tool was unusable fleet-wide on migrated hosts.
 *
 * The fix (mcp-management now uses getActiveMcpSettingsPath, which probes the
 * filesystem) must make `read()` succeed when ONLY zoo-code is present.
 *
 * Separate file from mcp-management.integration.test.ts because that file's
 * vi.hoisted sets APPDATA once and creates the roo-cline globalStorage; here we
 * need a Zoo-only APPDATA (no roo-cline dir) to reproduce the regression.
 *
 * @module roosync/__tests__/mcp-management.zoo-only
 * @issue #2766 S2 (P1)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Zoo-only host: create ONLY the zoo-code globalStorage. NO ROO_EXTENSION_ID env.
// Reproduces the no-override Zoo-only case (the exact ENOENT condition).
const { testAppDataPath, testZooSettingsDir, testZooSettingsPath } = vi.hoisted(() => {
  const path = require('path');
  const ZOO = 'zoocodeorganization.zoo-code';
  const testAppDataPath = path.join(__dirname, '../../../__test-data__/appdata-mcp-mgmt-zoo-only');
  process.env.APPDATA = testAppDataPath;
  // Explicitly unset ROO_EXTENSION_ID to reproduce the no-override Zoo-only case.
  delete process.env.ROO_EXTENSION_ID;
  const testZooSettingsDir = path.join(testAppDataPath, 'Code', 'User', 'globalStorage', ZOO, 'settings');
  const testZooSettingsPath = path.join(testZooSettingsDir, 'mcp_settings.json');
  return { testAppDataPath, testZooSettingsDir, testZooSettingsPath };
});

// Mock getSharedStatePath pour isolation RooSyncService
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-mcp-mgmt-zoo');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks et env override
import { roosyncMcpManagement, getMcpSettingsPath } from '../mcp-management.js';

describe('roosyncMcpManagement — #2766 S2 Zoo-only host (no Roo installed)', () => {
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
    // Create the zoo-code globalStorage + settings BEFORE any path resolution,
    // so the filesystem probe finds zoo-code (not the absent roo-cline).
    if (!existsSync(testZooSettingsDir)) {
      mkdirSync(testZooSettingsDir, { recursive: true });
    }
    if (!existsSync(testSharedStatePath)) {
      mkdirSync(testSharedStatePath, { recursive: true });
    }
    writeFileSync(testZooSettingsPath, JSON.stringify(zooMcpSettings, null, 2));

    // Hard guarantee this is a Zoo-only host: NO roo-cline globalStorage.
    const rooDir = join(testAppDataPath, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline');
    if (existsSync(rooDir)) {
      rmSync(rooDir, { recursive: true, force: true });
    }

    // Safety + regression contract: the resolved path MUST be the zoo-code one.
    const resolved = getMcpSettingsPath();
    if (!resolved.includes('__test-data__')) {
      throw new Error(
        `SAFETY ABORT: getMcpSettingsPath() would resolve outside the test dir!\n` +
        `  Resolved: ${resolved}\n`
      );
    }
    if (!resolved.includes('zoocodeorganization.zoo-code')) {
      throw new Error(
        `REGRESSION NOT FIXED: getMcpSettingsPath() did not resolve to zoo-code on a Zoo-only host.\n` +
        `  Resolved: ${resolved}\n` +
        `  Expected: a path containing 'zoocodeorganization.zoo-code'`
      );
    }
  });

  afterEach(() => {
    if (existsSync(testAppDataPath)) {
      rmSync(testAppDataPath, { recursive: true, force: true });
    }
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  test('read() succeeds on a Zoo-only host (pre-fix: ENOENT on roo-cline default)', async () => {
    const result = await roosyncMcpManagement({
      action: 'manage',
      subAction: 'read'
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('manage');
    expect(result.subAction).toBe('read');
    expect(result.details).toBeDefined();
    expect(result.details.mcpServers).toBeDefined();
    expect(result.details.mcpServers['zoo-server']).toBeDefined();
  });

  test('getMcpSettingsPath resolves to the zoo-code path, not the roo-cline default', () => {
    const resolved = getMcpSettingsPath();
    expect(resolved).toContain('zoocodeorganization.zoo-code');
    expect(resolved).not.toContain('rooveterinaryinc.roo-cline');
    expect(resolved.endsWith(join('settings', 'mcp_settings.json'))).toBe(true);
  });

  test('write after read targets the zoo-code config (end-to-end on Zoo-only)', async () => {
    // Read first to authorize writes.
    await roosyncMcpManagement({ action: 'manage', subAction: 'read' });

    const result = await roosyncMcpManagement({
      action: 'manage',
      subAction: 'update_server_field',
      server_name: 'zoo-server',
      server_config: { disabled: true }
    });

    expect(result.success).toBe(true);

    // The zoo-code config file on disk must reflect the write.
    const onDisk = JSON.parse(readFileSync(testZooSettingsPath, 'utf-8'));
    expect(onDisk.mcpServers['zoo-server'].disabled).toBe(true);
  });
});
