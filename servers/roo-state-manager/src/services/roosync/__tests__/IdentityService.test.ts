/**
 * Tests unitaires pour IdentityService
 *
 * Couvre :
 * - getInstance : singleton
 * - validateIdentityProtection : sharedPath inexistant
 * - validateIdentityProtection : sharedPath existe, aucun fichier optionnel
 * - validateIdentityProtection : registryFile présent (valide / invalide JSON)
 * - validateIdentityProtection : identityFile avec et sans conflits
 * - validateIdentityProtection : presenceFiles (unicité IDs)
 * - validateIdentityProtection : dashboardFile présent
 * - validateIdentityProtection : configFiles machineId correspondant / non correspondant
 * - validateIdentityProtection : erreur inattendue
 *
 * @module services/roosync/__tests__/IdentityService.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted) ───────────────────

const { mockAccess, mockReadFile, mockReaddir } = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: (...args: any[]) => mockAccess(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
}));

import { IdentityService } from '../IdentityService.js';

// ─────────────────── helpers ───────────────────

const SHARED_PATH = '/shared/state';
const MACHINE_ID = 'test-machine';

/** Simule qu'un chemin existe (access ne rejette pas) */
function pathExists(path?: string): void {
  mockAccess.mockResolvedValue(undefined);
}

/** Simule qu'un chemin n'existe pas */
function pathNotExists(): void {
  mockAccess.mockRejectedValue(new Error('ENOENT'));
}

/** Simule qu'un chemin existe ou non selon un prédicat */
function pathExistsByName(existPredicate: (p: string) => boolean): void {
  mockAccess.mockImplementation((p: string) => {
    if (existPredicate(p)) return Promise.resolve(undefined);
    return Promise.reject(new Error('ENOENT'));
  });
}

// ─────────────────── setup ───────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset le singleton entre les tests
  (IdentityService as any).instance = undefined;
});

// ─────────────────── tests ───────────────────

describe('IdentityService', () => {

  // ============================================================
  // Singleton
  // ============================================================

  describe('getInstance', () => {
    test('retourne une instance valide', () => {
      const instance = IdentityService.getInstance();
      expect(instance).toBeInstanceOf(IdentityService);
    });

    test('retourne toujours la même instance (singleton)', () => {
      const a = IdentityService.getInstance();
      const b = IdentityService.getInstance();
      expect(a).toBe(b);
    });
  });

  // ============================================================
  // sharedPath inexistant
  // ============================================================

  describe('validateIdentityProtection - sharedPath inexistant', () => {
    test('retourne tous les checks à false si le sharedPath n\'existe pas', async () => {
      pathNotExists();
      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.registryFile).toBe(false);
      expect(result.checks.identityRegistry).toBe(false);
      expect(result.checks.presenceFiles).toBe(false);
      expect(result.checks.dashboardFile).toBe(false);
      expect(result.checks.configFiles).toBe(false);
    });

    test('retourne le machineId et sharedPath corrects', async () => {
      pathNotExists();
      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.machineId).toBe(MACHINE_ID);
      expect(result.sharedPath).toBe(SHARED_PATH);
    });

    test('ajoute un log ERROR pour sharedPath inexistant', async () => {
      pathNotExists();
      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[ERROR]'))).toBe(true);
    });
  });

  // ============================================================
  // sharedPath existe, aucun fichier optionnel
  // ============================================================

  describe('validateIdentityProtection - sharedPath existe sans fichiers', () => {
    test('checks restent à false si aucun fichier optionnel n\'existe', async () => {
      // sharedPath existe, tous les autres accès échouent
      let callCount = 0;
      mockAccess.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(undefined); // sharedPath OK
        return Promise.reject(new Error('ENOENT')); // autres non trouvés
      });

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.registryFile).toBe(false);
      expect(result.checks.identityRegistry).toBe(false);
      expect(result.checks.presenceFiles).toBe(false);
      expect(result.checks.dashboardFile).toBe(false);
      expect(result.checks.configFiles).toBe(false);
    });

    test('contient des logs WARN pour les fichiers manquants', async () => {
      let callCount = 0;
      mockAccess.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(undefined);
        return Promise.reject(new Error('ENOENT'));
      });

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      const warnLogs = result.logs.filter(l => l.includes('[WARN]'));
      expect(warnLogs.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // registryFile valide
  // ============================================================

  describe('validateIdentityProtection - registryFile valide', () => {
    test('checks.registryFile = true si fichier présent et valide', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.machine-registry.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({
        machines: { 'machine-1': {}, 'machine-2': {} }
      }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.registryFile).toBe(true);
    });

    test('details.registry contient le contenu parsé', async () => {
      const registryContent = { machines: { 'machine-1': { name: 'test' } } };
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.machine-registry.json'));
      mockReadFile.mockResolvedValue(JSON.stringify(registryContent));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.details.registry).toEqual(registryContent);
    });

    test('log SUCCESS si registryFile trouvé', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.machine-registry.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({ machines: {} }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[SUCCESS]') && l.includes('registry'))).toBe(true);
    });
  });

  // ============================================================
  // registryFile invalide (JSON malformé)
  // ============================================================

  describe('validateIdentityProtection - registryFile JSON invalide', () => {
    test('log ERROR si JSON invalide', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.machine-registry.json'));
      mockReadFile.mockResolvedValue('not-valid-json');
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[ERROR]') && l.includes('registry'))).toBe(true);
    });
  });

  // ============================================================
  // identityFile avec conflits
  // ============================================================

  describe('validateIdentityProtection - identityFile avec conflits', () => {
    test('checks.identityRegistry = true si identityFile présent', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.identity-registry.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({ identities: {} }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.identityRegistry).toBe(true);
    });

    test('log WARN si conflits détectés', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.identity-registry.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({
        identities: {
          'machine-conflict': { status: 'conflict' }
        }
      }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[WARN]') && l.includes('conflict'))).toBe(true);
      expect(result.details.conflicts).toContain('machine-conflict');
    });

    test('log SUCCESS si aucun conflit', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('.identity-registry.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({
        identities: { 'machine-ok': { status: 'active' } }
      }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[SUCCESS]') && l.includes('conflict'))).toBe(true);
      expect(result.details.conflicts).toEqual([]);
    });
  });

  // ============================================================
  // presenceFiles
  // ============================================================

  describe('validateIdentityProtection - presenceFiles', () => {
    test('checks.presenceFiles = true si répertoire presence existe', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('presence'));
      mockReaddir.mockResolvedValue(['machine-a.json', 'machine-b.json']);
      mockReadFile.mockImplementation((p: string) => {
        if (p.endsWith('machine-a.json')) return Promise.resolve(JSON.stringify({ id: 'machine-a' }));
        return Promise.resolve(JSON.stringify({ id: 'machine-b' }));
      });

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.presenceFiles).toBe(true);
    });

    test('log WARN si IDs dupliqués dans presence', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('presence'));
      mockReaddir.mockResolvedValue(['m1.json', 'm2.json']);
      mockReadFile.mockResolvedValue(JSON.stringify({ id: 'duplicate-machine' }));

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[WARN]') && l.includes('Duplicate'))).toBe(true);
    });

    test('log SUCCESS avec nombre de fichiers présence', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('presence'));
      mockReaddir.mockResolvedValue(['m1.json']);
      mockReadFile.mockResolvedValue(JSON.stringify({ id: 'machine-1' }));

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[SUCCESS]') && l.includes('presence'))).toBe(true);
    });
  });

  // ============================================================
  // dashboardFile
  // ============================================================

  describe('validateIdentityProtection - dashboardFile', () => {
    test('checks.dashboardFile = true si fichier présent et valide', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('sync-dashboard.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0' }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.dashboardFile).toBe(true);
    });

    test('details.dashboard contient le contenu parsé', async () => {
      const dashContent = { version: '2.0', machines: [] };
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('sync-dashboard.json'));
      mockReadFile.mockResolvedValue(JSON.stringify(dashContent));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.details.dashboard).toEqual(dashContent);
    });
  });

  // ============================================================
  // configFiles - machineId matching
  // ============================================================

  describe('validateIdentityProtection - configFiles', () => {
    test('checks.configFiles = true si sync-config.json présent', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('sync-config.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({ machineId: MACHINE_ID }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.checks.configFiles).toBe(true);
    });

    test('log SUCCESS si machineId correspond', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('sync-config.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({ machineId: MACHINE_ID }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[SUCCESS]') && l.includes('matches'))).toBe(true);
    });

    test('log WARN si machineId ne correspond pas', async () => {
      pathExistsByName(p => p === SHARED_PATH || p.endsWith('sync-config.json'));
      mockReadFile.mockResolvedValue(JSON.stringify({ machineId: 'other-machine' }));
      mockReaddir.mockResolvedValue([]);

      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(result.logs.some(l => l.includes('[WARN]') && l.includes('mismatch'))).toBe(true);
    });
  });

  // ============================================================
  // Structure résultat
  // ============================================================

  describe('structure du résultat', () => {
    test('résultat contient toujours un tableau logs', async () => {
      pathNotExists();
      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(Array.isArray(result.logs)).toBe(true);
    });

    test('résultat contient toujours un objet details', async () => {
      pathNotExists();
      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(typeof result.details).toBe('object');
    });

    test('résultat contient toujours un objet checks avec 5 propriétés', async () => {
      pathNotExists();
      const service = IdentityService.getInstance();
      const result = await service.validateIdentityProtection(SHARED_PATH, MACHINE_ID);

      expect(Object.keys(result.checks)).toHaveLength(5);
    });
  });
});
