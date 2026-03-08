/**
 * Tests d'intégration pour roosyncMcpManagement
 *
 * Couvre toutes les actions de l'outil :
 * - action: 'manage' : Gestion configuration MCP (7 subActions)
 * - action: 'rebuild' : Build npm + restart MCP
 * - action: 'touch' : Force reload all MCP servers
 *
 * Framework: Vitest
 * Type: Intégration (FileSystem réel, MCP_SETTINGS_PATH mocké via process.env.APPDATA)
 *
 * IMPORTANT: MCP_SETTINGS_PATH is computed at module load time from process.env.APPDATA.
 * We must set APPDATA before the module is imported. We use vi.hoisted() for this.
 *
 * @module roosync/mcp-management.integration.test
 * @version 1.1.0 (#564 Phase 2, #606 fix)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
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

// Use vi.hoisted to set APPDATA BEFORE any module imports
// Cannot use `join` from import here (not initialized yet), use require
const { testAppDataPath, testMcpSettingsDir, testMcpSettingsPath } = vi.hoisted(() => {
  const path = require('path');
  const testAppDataPath = path.join(__dirname, '../../../__test-data__/appdata-mcp-management');
  process.env.APPDATA = testAppDataPath;
  const testMcpSettingsDir = path.join(testAppDataPath, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings');
  const testMcpSettingsPath = path.join(testMcpSettingsDir, 'mcp_settings.json');
  return { testAppDataPath, testMcpSettingsDir, testMcpSettingsPath };
});

// Mock getSharedStatePath pour isolation RooSyncService
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-mcp-mgmt');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks et env override
import { roosyncMcpManagement } from '../mcp-management.js';

// We also need to reset the module-level lastReadTimestamp between tests.
// Since it's not exported, we need to ensure each test that requires auth does a read first,
// and tests that check auth rejection run BEFORE any read in their describe block.

describe('roosyncMcpManagement (integration)', () => {
  // Configuration MCP de test
  const testMcpSettings = {
    mcpServers: {
      'test-server-1': {
        command: 'node',
        args: ['path/to/server1.js'],
        disabled: false
      },
      'test-server-2': {
        command: 'python',
        args: ['-m', 'server2'],
        disabled: true
      },
      'test-server-3': {
        command: 'node',
        args: ['path/to/server3.js'],
        disabled: false,
        alwaysAllow: ['tool1', 'tool2']
      }
    }
  };

  beforeEach(async () => {
    // Setup : créer répertoires temporaires pour tests isolés
    if (!existsSync(testMcpSettingsDir)) {
      mkdirSync(testMcpSettingsDir, { recursive: true });
    }
    if (!existsSync(testSharedStatePath)) {
      mkdirSync(testSharedStatePath, { recursive: true });
    }

    // Créer fichier mcp_settings.json initial
    writeFileSync(testMcpSettingsPath, JSON.stringify(testMcpSettings, null, 2));
  });

  afterEach(async () => {
    // Cleanup : supprimer répertoires test pour isolation
    if (existsSync(testAppDataPath)) {
      rmSync(testAppDataPath, { recursive: true, force: true });
    }
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'read'
  // ============================================================

  describe("action: 'manage', subAction: 'read'", () => {
    test('should read MCP settings successfully', async () => {
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('manage');
      expect(result.subAction).toBe('read');
      // Settings are in result.details, not result.settings
      expect(result.details).toBeDefined();
      expect(result.details.mcpServers).toBeDefined();
      expect(Object.keys(result.details.mcpServers)).toHaveLength(3);
    });

    test('should include all servers in read result', async () => {
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      expect(result.details.mcpServers['test-server-1']).toBeDefined();
      expect(result.details.mcpServers['test-server-2']).toBeDefined();
      expect(result.details.mcpServers['test-server-3']).toBeDefined();
    });

    test('should grant write authorization after read', async () => {
      const readResult = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      // Message contains authorization confirmation
      expect(readResult.message).toContain('AUTORISATION');

      // Read should authorize writes for 5 minutes
      const writeResult = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: true }
      });

      expect(writeResult.success).toBe(true);
    });

    test('should throw on missing mcp_settings.json', async () => {
      rmSync(testMcpSettingsPath);

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      })).rejects.toThrow();
    });

    test('should throw on corrupted JSON', async () => {
      writeFileSync(testMcpSettingsPath, '{ invalid json }');

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      })).rejects.toThrow();
    });
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'write'
  // ============================================================

  describe("action: 'manage', subAction: 'write'", () => {
    test('should write MCP settings after read authorization', async () => {
      // D'abord lire pour autoriser
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const newSettings = {
        mcpServers: {
          'new-server': {
            command: 'node',
            args: ['new.js'],
            disabled: false
          }
        }
      };

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'write',
        settings: newSettings
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('écrite avec succès');

      // Vérifier que le fichier a été modifié
      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers).toHaveProperty('new-server');
    });

    test('should create backup when backup is true', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'write',
        settings: testMcpSettings,
        backup: true
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('sauvegarde créée');
    });

    test('should skip backup when backup is false', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'write',
        settings: testMcpSettings,
        backup: false
      });

      expect(result.success).toBe(true);
      expect(result.message).not.toContain('sauvegarde créée');
    });

    test('should throw when settings param is missing', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'write'
        // settings manquant
      })).rejects.toThrow('settings requis');
    });
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'backup'
  // ============================================================

  describe("action: 'manage', subAction: 'backup'", () => {
    test('should create backup of MCP settings', async () => {
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'backup'
      });

      expect(result.success).toBe(true);
      // backupPath is in result.details.backupPath
      expect(result.details).toBeDefined();
      expect(result.details.backupPath).toBeDefined();
      expect(existsSync(result.details.backupPath)).toBe(true);

      // Vérifier que le backup contient les mêmes données
      const backupContent = JSON.parse(readFileSync(result.details.backupPath, 'utf-8'));
      expect(backupContent.mcpServers).toEqual(testMcpSettings.mcpServers);
    });

    test('should include timestamp in backup filename', async () => {
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'backup'
      });

      expect(result.details.backupPath).toMatch(/mcp_settings_backup_/);
    });

    test('should create multiple backups without overwriting', async () => {
      const result1 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'backup'
      });

      // Attendre un peu pour avoir un timestamp différent
      await new Promise(resolve => setTimeout(resolve, 10));

      const result2 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'backup'
      });

      expect(result1.details.backupPath).not.toBe(result2.details.backupPath);
      expect(existsSync(result1.details.backupPath)).toBe(true);
      expect(existsSync(result2.details.backupPath)).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'update_server'
  // ============================================================

  describe("action: 'manage', subAction: 'update_server'", () => {
    test('should replace entire server config', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const newServerConfig = {
        command: 'python',
        args: ['-m', 'new_server'],
        disabled: true,
        alwaysAllow: ['tool3', 'tool4']
      };

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server',
        server_name: 'test-server-1',
        server_config: newServerConfig
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('test-server-1');
      expect(result.message).toContain('mise à jour');

      // Vérifier que la config a été remplacée
      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-1'].command).toBe('python');
      expect(fileContent.mcpServers['test-server-1'].disabled).toBe(true);
    });

    test('should create or replace non-existent server (upsert behavior)', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      // update_server creates a new entry if it doesn't exist
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server',
        server_name: 'brand-new-server',
        server_config: { command: 'node', args: ['new.js'], disabled: false }
      });

      expect(result.success).toBe(true);

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['brand-new-server']).toBeDefined();
    });

    test('should throw when server_name or server_config missing', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server'
        // server_name and server_config manquants
      })).rejects.toThrow('server_name et server_config requis');
    });

    test('should create backup when backup is true', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server',
        server_name: 'test-server-1',
        server_config: { disabled: true },
        backup: true
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('sauvegarde créée');
    });
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'update_server_field'
  // ============================================================

  describe("action: 'manage', subAction: 'update_server_field'", () => {
    test('should merge server config without replacing entire config', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: true }
      });

      expect(result.success).toBe(true);

      // Vérifier que seul disabled a changé, le reste est intact
      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-1'].disabled).toBe(true);
      expect(fileContent.mcpServers['test-server-1'].command).toBe('node');
      expect(fileContent.mcpServers['test-server-1'].args).toEqual(['path/to/server1.js']);
    });

    test('should add new field to server config', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { env: { TEST_VAR: 'test_value' } }
      });

      expect(result.success).toBe(true);

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-1'].env).toEqual({ TEST_VAR: 'test_value' });
    });

    test('should throw for non-existent server', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'non-existent',
        server_config: { disabled: true }
      })).rejects.toThrow('non trouvé');
    });

    test('should report updated and preserved fields', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: true }
      });

      expect(result.success).toBe(true);
      expect(result.details).toBeDefined();
      expect(result.details.updatedFields).toContain('disabled');
      // preservedFields contains fields NOT in updatedFields
      expect(result.details.preservedFields).toBeDefined();
      expect(result.details.preservedFields.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'toggle_server'
  // ============================================================

  describe("action: 'manage', subAction: 'toggle_server'", () => {
    test('should enable disabled server', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-2' // initialement disabled: true
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('activé');

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-2'].disabled).toBe(false);
    });

    test('should disable enabled server', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-1' // initialement disabled: false
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('désactivé');

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-1'].disabled).toBe(true);
    });

    test('should throw for non-existent server', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'non-existent'
      })).rejects.toThrow('non trouvé');
    });

    test('should create backup when backup is true', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-1',
        backup: true
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('sauvegarde créée');
    });
  });

  // ============================================================
  // Tests pour action: 'manage', subAction: 'sync_always_allow'
  // ============================================================

  describe("action: 'manage', subAction: 'sync_always_allow'", () => {
    test('should update alwaysAllow list for specified server', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-1',
        tools: ['toolA', 'toolB', 'toolC']
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('test-server-1');
      expect(result.message).toContain('alwaysAllow');

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-1'].alwaysAllow).toEqual(['toolA', 'toolB', 'toolC']);
    });

    test('should replace existing alwaysAllow list', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      // test-server-3 a déjà ['tool1', 'tool2']
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-3',
        tools: ['newTool1', 'newTool2']
      });

      expect(result.success).toBe(true);

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-3'].alwaysAllow).toEqual(['newTool1', 'newTool2']);
      expect(fileContent.mcpServers['test-server-3'].alwaysAllow).not.toContain('tool1');
    });

    test('should keep existing alwaysAllow when tools array is empty', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      // Empty tools array = keep existing (no-op per source code)
      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-3',
        tools: []
      });

      expect(result.success).toBe(true);

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-3'].alwaysAllow).toEqual(['tool1', 'tool2']);
    });

    test('should throw for non-existent server', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'non-existent',
        tools: ['toolA']
      })).rejects.toThrow('non trouvé');
    });

    test('should report added and removed tools', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-3',
        tools: ['tool1', 'newTool'] // keep tool1, add newTool, remove tool2
      });

      expect(result.success).toBe(true);
      expect(result.details).toBeDefined();
      expect(result.details.added).toContain('newTool');
      expect(result.details.removed).toContain('tool2');
    });

    test('should deduplicate tools', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-1',
        tools: ['toolA', 'toolA', 'toolB']
      });

      expect(result.success).toBe(true);

      const fileContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(fileContent.mcpServers['test-server-1'].alwaysAllow).toEqual(['toolA', 'toolB']);
    });
  });

  // ============================================================
  // Tests pour action: 'rebuild'
  // ============================================================

  describe("action: 'rebuild'", () => {
    test('should throw when mcp_name not found in settings', async () => {
      await expect(roosyncMcpManagement({
        action: 'rebuild',
        mcp_name: 'non-existent-mcp'
      })).rejects.toThrow('non trouvé');
    });

    test('should throw when mcp_name is missing', async () => {
      await expect(roosyncMcpManagement({
        action: 'rebuild'
        // mcp_name manquant
      })).rejects.toThrow('mcp_name requis');
    });

    test('should throw when MCP has no resolvable working directory', async () => {
      // test-server-2 has args: ['-m', 'server2'] - no path separator, no cwd
      await expect(roosyncMcpManagement({
        action: 'rebuild',
        mcp_name: 'test-server-2'
      })).rejects.toThrow(); // Should throw MISSING_CWD or similar
    });
  });

  // ============================================================
  // Tests pour action: 'touch'
  // ============================================================

  describe("action: 'touch'", () => {
    test('should touch mcp_settings.json to force reload', async () => {
      const result = await roosyncMcpManagement({
        action: 'touch'
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('touch');
      expect(result.message).toContain('mcp_settings.json');
      expect(result.message).toContain('touché');
    });

    test('should not modify MCP settings content', async () => {
      const originalContent = readFileSync(testMcpSettingsPath, 'utf-8');

      await roosyncMcpManagement({
        action: 'touch'
      });

      const newContent = readFileSync(testMcpSettingsPath, 'utf-8');
      expect(newContent).toBe(originalContent);
    });

    test('should include timestamp in result', async () => {
      const result = await roosyncMcpManagement({
        action: 'touch'
      });

      expect(result.timestamp).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.details.touchedAt).toBeDefined();
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should throw for invalid action', async () => {
      await expect(roosyncMcpManagement({
        action: 'invalid' as any
      })).rejects.toThrow();
    });

    test('should throw for missing subAction with manage', async () => {
      await expect(roosyncMcpManagement({
        action: 'manage'
        // subAction manquant
      })).rejects.toThrow('subAction requis');
    });

    test('should throw for invalid subAction', async () => {
      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'invalid' as any
      })).rejects.toThrow('non reconnue');
    });

    test('should throw for missing required parameters', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server'
        // server_name and server_config manquants
      })).rejects.toThrow();
    });

    test('should throw for JSON parse errors', async () => {
      writeFileSync(testMcpSettingsPath, 'invalid json content');

      await expect(roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      })).rejects.toThrow();
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete read -> modify -> verify workflow', async () => {
      // Step 1: Read
      const readResult = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });
      expect(readResult.success).toBe(true);

      // Step 2: Modify via update_server_field
      const modifyResult = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: true }
      });
      expect(modifyResult.success).toBe(true);

      // Step 3: Verify by reading again
      const verifyResult = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });
      expect(verifyResult.details.mcpServers['test-server-1'].disabled).toBe(true);
    });

    test('should handle backup -> modify -> restore workflow', async () => {
      // Step 1: Backup
      const backupResult = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'backup'
      });
      expect(backupResult.success).toBe(true);
      const savedBackupPath = backupResult.details.backupPath;

      // Step 2: Modify
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-1'
      });

      // Step 3: Restore from backup
      copyFileSync(savedBackupPath, testMcpSettingsPath);
      const restoredContent = JSON.parse(readFileSync(testMcpSettingsPath, 'utf-8'));
      expect(restoredContent.mcpServers['test-server-1'].disabled).toBe(false);
    });

    test('should handle multiple operations in sequence', async () => {
      // Read
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      // Toggle server 1
      const result1 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-1'
      });
      expect(result1.success).toBe(true);

      // Toggle server 2
      const result2 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-2'
      });
      expect(result2.success).toBe(true);

      // Sync alwaysAllow on server 3
      const result3 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-3',
        tools: ['newTool']
      });
      expect(result3.success).toBe(true);

      // Verify all changes
      const finalRead = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });
      expect(finalRead.details.mcpServers['test-server-1'].disabled).toBe(true);
      expect(finalRead.details.mcpServers['test-server-2'].disabled).toBe(false);
      expect(finalRead.details.mcpServers['test-server-3'].alwaysAllow).toEqual(['newTool']);
    });

    test('should persist authorization across multiple operations', async () => {
      // Read once
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      // Multiple write operations should all succeed
      const op1 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: true }
      });

      const op2 = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: false }
      });

      expect(op1.success).toBe(true);
      expect(op2.success).toBe(true);
    });
  });

  // ============================================================
  // Tests de sécurité - Write Authorization
  // ============================================================

  describe('write authorization security', () => {
    test('should allow write after read', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'write',
        settings: testMcpSettings
      });

      expect(result.success).toBe(true);
    });

    test('should allow update_server_field after read', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'update_server_field',
        server_name: 'test-server-1',
        server_config: { disabled: true }
      });

      expect(result.success).toBe(true);
    });

    test('should allow toggle_server after read', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'toggle_server',
        server_name: 'test-server-1'
      });

      expect(result.success).toBe(true);
    });

    test('should allow sync_always_allow after read', async () => {
      await roosyncMcpManagement({
        action: 'manage',
        subAction: 'read'
      });

      const result = await roosyncMcpManagement({
        action: 'manage',
        subAction: 'sync_always_allow',
        server_name: 'test-server-1',
        tools: ['toolA']
      });

      expect(result.success).toBe(true);
    });
  });
});
