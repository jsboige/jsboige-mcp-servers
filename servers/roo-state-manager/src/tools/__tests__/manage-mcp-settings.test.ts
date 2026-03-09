/**
 * Tests unitaires pour manage-mcp-settings.ts
 *
 * Couvre :
 * - action=read : succès et échec
 * - action=write : autorisé (après read) et refusé (sans read)
 * - action=backup : succès et échec
 * - action=update_server : autorisé, refusé, params manquants
 * - action=toggle_server : autorisé, refusé, serveur introuvable
 * - action inconnue : retour message erreur
 * - Mécanisme de sécurité (lastReadTimestamp)
 *
 * Pattern modifié (#609) : Utilise beforeAll pour l'import unique au lieu de
 * vi.resetModules() qui causait des timeouts dans le suite complet.
 *
 * @module tools/__tests__/manage-mcp-settings.test
 * @version 1.1.0 (#492, #609 fix)
 */

import { describe, test, expect, vi, beforeEach, beforeAll } from 'vitest';

// ─────────────────── mock factories ───────────────────

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockStat = vi.fn();
const mockReaddir = vi.fn();
const mockAccess = vi.fn();

vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  stat: (...args: any[]) => mockStat(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
  access: (...args: any[]) => mockAccess(...args),
}));

// os.homedir() utilisé par rebuildTaskIndexFixed
vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home',
}));

// ─────────────────── helpers ───────────────────

const mockSettings = {
  mcpServers: {
    'test-server': {
      command: 'node',
      args: ['server.js'],
      disabled: false,
    },
  },
};

const mockSettingsJson = JSON.stringify(mockSettings, null, 2);

let manageMcpSettings: any;
let resetLastReadTimestamp: (() => void) | undefined;

// ─────────────────── setup ───────────────────

beforeAll(async () => {
  // Import unique avec mocks déjà définis au niveau module
  const mod = await import('../manage-mcp-settings.js');
  manageMcpSettings = mod.manageMcpSettings;
  resetLastReadTimestamp = mod._test_resetLastReadTimestamp;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockReadFile.mockResolvedValue(mockSettingsJson);
  mockWriteFile.mockResolvedValue(undefined);

  // Reset module-level state for clean test isolation
  resetLastReadTimestamp?.();
});

// ─────────────────── tests ───────────────────

describe('manageMcpSettings', () => {

  // ============================================================
  // action = inconnue
  // ============================================================

  describe('action inconnue', () => {
    test('retourne un message d\'action non reconnue', async () => {
      const result = await manageMcpSettings.handler({ action: 'invalid' as any });

      expect(result.content[0].text).toContain('non reconnue');
    });
  });

  // ============================================================
  // action = 'read'
  // ============================================================

  describe('action=read', () => {
    test('lit les settings et retourne le contenu', async () => {
      const result = await manageMcpSettings.handler({ action: 'read' });

      expect(mockReadFile).toHaveBeenCalled();
      expect(result.content[0].text).toContain('AUTORISATION');
    });

    test('retourne le JSON des settings', async () => {
      mockReadFile.mockResolvedValue(mockSettingsJson);

      const result = await manageMcpSettings.handler({ action: 'read' });

      expect(result.content[0].text).toContain('test-server');
    });

    test('retourne un message d\'erreur si readFile échoue', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'));

      const result = await manageMcpSettings.handler({ action: 'read' });

      expect(result.content[0].text).toContain('Erreur de lecture');
      expect(result.content[0].text).toContain('ENOENT');
    });
  });

  // ============================================================
  // action = 'write'
  // ============================================================

  describe('action=write - autorisation requise', () => {
    test('refusé si aucune lecture préalable (lastReadTimestamp = null)', async () => {
      // Note: Module-level state persists across tests in suite
      // This test assumes lastReadTimestamp starts null
      const result = await manageMcpSettings.handler({ action: 'write', settings: mockSettings });

      expect(result.content[0].text).toContain('REFUSÉE');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    test('refusé si settings manquant', async () => {
      // Effectuer la lecture d'abord
      await manageMcpSettings.handler({ action: 'read' });

      const result = await manageMcpSettings.handler({ action: 'write' });

      expect(result.content[0].text).toContain('settings requis');
    });

    test('autorisé après une lecture préalable', async () => {
      await manageMcpSettings.handler({ action: 'read' });

      const result = await manageMcpSettings.handler({ action: 'write', settings: mockSettings });

      expect(result.content[0].text).toContain('AUTORISÉE');
      expect(mockWriteFile).toHaveBeenCalled();
    });

    test('appelle writeFile avec le contenu JSON', async () => {
      await manageMcpSettings.handler({ action: 'read' });

      await manageMcpSettings.handler({ action: 'write', settings: mockSettings, backup: false });

      const callArgs = mockWriteFile.mock.calls[0];
      expect(callArgs[1]).toContain('test-server');
    });

    test('retourne une erreur si structure mcpServers manquante', async () => {
      await manageMcpSettings.handler({ action: 'read' });

      const result = await manageMcpSettings.handler({
        action: 'write',
        settings: { mcpServers: null as any },
        backup: false
      });

      // L'erreur est catchée et retournée comme message
      expect(result.content[0].text).toContain('Erreur');
    });
  });

  // ============================================================
  // action = 'backup'
  // ============================================================

  describe('action=backup', () => {
    test('crée une sauvegarde avec succès', async () => {
      const result = await manageMcpSettings.handler({ action: 'backup' });

      expect(mockReadFile).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Sauvegarde');
    });

    test('retourne une erreur si readFile échoue', async () => {
      mockReadFile.mockRejectedValue(new Error('Disk error'));

      const result = await manageMcpSettings.handler({ action: 'backup' });

      expect(result.content[0].text).toContain('Erreur de sauvegarde');
    });
  });

  // ============================================================
  // action = 'update_server'
  // ============================================================

  describe('action=update_server', () => {
    test('retourne message si server_name ou server_config manquant', async () => {
      const result = await manageMcpSettings.handler({ action: 'update_server' });

      expect(result.content[0].text).toContain('server_name');
    });

    test('refusé si aucune lecture préalable', async () => {
      const result = await manageMcpSettings.handler({
        action: 'update_server',
        server_name: 'test-server',
        server_config: { command: 'node' },
      });

      expect(result.content[0].text).toContain('REFUSÉE');
    });

    test('autorisé après une lecture préalable', async () => {
      await manageMcpSettings.handler({ action: 'read' });

      const result = await manageMcpSettings.handler({
        action: 'update_server',
        server_name: 'test-server',
        server_config: { command: 'python', disabled: true },
        backup: false,
      });

      expect(result.content[0].text).toContain('AUTORISÉE');
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  // ============================================================
  // action = 'toggle_server'
  // ============================================================

  describe('action=toggle_server', () => {
    test('retourne message si server_name manquant', async () => {
      const result = await manageMcpSettings.handler({ action: 'toggle_server' });

      expect(result.content[0].text).toContain('server_name');
    });

    test('refusé si aucune lecture préalable', async () => {
      const result = await manageMcpSettings.handler({
        action: 'toggle_server',
        server_name: 'test-server',
      });

      expect(result.content[0].text).toContain('REFUSÉ');
    });

    test('autorisé après lecture - server non trouvé lance une erreur catchée', async () => {
      await manageMcpSettings.handler({ action: 'read' });
      // mockReadFile retourne settings avec test-server mais on essaie 'unknown-server'
      const result = await manageMcpSettings.handler({
        action: 'toggle_server',
        server_name: 'unknown-server',
        backup: false,
      });

      expect(result.content[0].text).toContain('Erreur');
    });

    test('autorisé après lecture - bascule disabled d\'un serveur existant', async () => {
      await manageMcpSettings.handler({ action: 'read' });

      const result = await manageMcpSettings.handler({
        action: 'toggle_server',
        server_name: 'test-server',
        backup: false,
      });

      expect(mockWriteFile).toHaveBeenCalled();
      expect(result.content[0].text).toContain('AUTORISÉ');
    });
  });
});
