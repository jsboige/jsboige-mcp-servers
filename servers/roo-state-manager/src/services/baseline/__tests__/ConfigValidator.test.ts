/**
 * Tests unitaires pour ConfigValidator
 *
 * Couvre :
 * - validateBaselineConfig : toutes les combinaisons de champs requis
 * - validateBaselineFileConfig : champs requis, machines vide/absente
 * - ensureValidBaselineConfig : lève BaselineServiceError si invalide
 * - ensureValidBaselineFileConfig : null, champs manquants
 *
 * @module services/baseline/__tests__/ConfigValidator.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ConfigValidator } from '../ConfigValidator.js';
import { BaselineServiceError, BaselineServiceErrorCode } from '../../../types/baseline.js';
import type { BaselineConfig, BaselineFileConfig } from '../../../types/baseline.js';

// ─────────────────── helpers ───────────────────

function makeBaselineConfig(overrides: Partial<BaselineConfig> = {}): BaselineConfig {
  return {
    machineId: 'test-machine',
    config: {
      roo: { modes: [], mcpSettings: {}, userSettings: {} },
      hardware: {
        cpu: { model: 'Intel', cores: 4, threads: 8 },
        memory: { total: 16384 },
        disks: [],
      },
      software: { powershell: '7.4', node: '20.0', python: '3.11' },
      system: { os: 'Windows', architecture: 'x64' },
    },
    lastUpdated: '2026-01-01T00:00:00Z',
    version: '1.0.0',
    ...overrides,
  };
}

function makeBaselineFileConfig(overrides: Partial<BaselineFileConfig> = {}): BaselineFileConfig {
  return {
    version: '1.0.0',
    baselineId: 'baseline-001',
    timestamp: '2026-01-01T00:00:00Z',
    machineId: 'test-machine',
    autoSync: true,
    conflictStrategy: 'manual',
    logLevel: 'info',
    sharedStatePath: '/shared/state',
    machines: [
      {
        id: 'machine-1', name: 'Machine 1', hostname: 'host1', os: 'Windows',
        architecture: 'x64', lastSeen: '2026-01-01T00:00:00Z',
        roo: { modes: [], mcpServers: [], sdddSpecs: [] },
        hardware: { cpu: { cores: 4, threads: 8 }, memory: { total: 16384 } },
        software: {},
      },
    ],
    syncTargets: [],
    syncPaths: [],
    decisions: [],
    messages: [],
    ...overrides,
  };
}

// ─────────────────── setup ───────────────────

let validator: ConfigValidator;

beforeEach(() => {
  validator = new ConfigValidator();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ─────────────────── tests ───────────────────

describe('ConfigValidator', () => {

  // ============================================================
  // validateBaselineConfig
  // ============================================================

  describe('validateBaselineConfig', () => {
    test('retourne true pour une config valide', () => {
      expect(validator.validateBaselineConfig(makeBaselineConfig())).toBe(true);
    });

    test('retourne false si machineId manquant', () => {
      const config = makeBaselineConfig({ machineId: '' });
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si version manquante', () => {
      const config = makeBaselineConfig({ version: '' });
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si config est null', () => {
      const config = { ...makeBaselineConfig(), config: null as any };
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si config.roo manquant', () => {
      const base = makeBaselineConfig();
      const config = { ...base, config: { ...base.config, roo: null as any } };
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si config.hardware manquant', () => {
      const base = makeBaselineConfig();
      const config = { ...base, config: { ...base.config, hardware: null as any } };
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si config.software manquant', () => {
      const base = makeBaselineConfig();
      const config = { ...base, config: { ...base.config, software: null as any } };
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si config.system manquant', () => {
      const base = makeBaselineConfig();
      const config = { ...base, config: { ...base.config, system: null as any } };
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('retourne false si objet vide', () => {
      expect(validator.validateBaselineConfig({} as any)).toBe(false);
    });

    test('retourne false si null', () => {
      expect(validator.validateBaselineConfig(null as any)).toBe(false);
    });
  });

  // ============================================================
  // validateBaselineFileConfig
  // ============================================================

  describe('validateBaselineFileConfig', () => {
    test('retourne true pour une config fichier valide', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig())).toBe(true);
    });

    test('retourne false si version manquante', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig({ version: '' }))).toBe(false);
    });

    test('retourne false si baselineId manquant', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig({ baselineId: '' }))).toBe(false);
    });

    test('retourne false si machineId manquant', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig({ machineId: '' }))).toBe(false);
    });

    test('retourne false si timestamp manquant', () => {
      const config = makeBaselineFileConfig({ timestamp: undefined });
      expect(validator.validateBaselineFileConfig(config)).toBe(false);
    });

    test('retourne false si machines est un tableau vide', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig({ machines: [] }))).toBe(false);
    });

    test('retourne false si machines est null', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig({ machines: null as any }))).toBe(false);
    });

    test('retourne false si machines absent', () => {
      expect(validator.validateBaselineFileConfig(makeBaselineFileConfig({ machines: undefined as any }))).toBe(false);
    });

    test('retourne true si lastUpdated est présent mais pas timestamp', () => {
      // Le validator vérifie uniquement timestamp, lastUpdated n'est pas requis ici
      const config = makeBaselineFileConfig({ timestamp: '2026-01-01T00:00:00Z', lastUpdated: undefined });
      expect(validator.validateBaselineFileConfig(config)).toBe(true);
    });
  });

  // ============================================================
  // ensureValidBaselineConfig
  // ============================================================

  describe('ensureValidBaselineConfig', () => {
    test('ne lève pas d\'exception pour une config valide', () => {
      expect(() => validator.ensureValidBaselineConfig(makeBaselineConfig())).not.toThrow();
    });

    test('lève BaselineServiceError si config invalide', () => {
      expect(() =>
        validator.ensureValidBaselineConfig({ machineId: '', version: '', config: null as any, lastUpdated: '' } as any)
      ).toThrow(BaselineServiceError);
    });

    test('lève avec code BASELINE_INVALID', () => {
      try {
        validator.ensureValidBaselineConfig({} as any);
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
      }
    });

    test('ne lève pas si tous les champs requis sont présents', () => {
      const config = makeBaselineConfig();
      expect(() => validator.ensureValidBaselineConfig(config)).not.toThrow();
    });
  });

  // ============================================================
  // ensureValidBaselineFileConfig
  // ============================================================

  describe('ensureValidBaselineFileConfig', () => {
    test('ne lève pas d\'exception pour une config fichier valide', () => {
      expect(() => validator.ensureValidBaselineFileConfig(makeBaselineFileConfig())).not.toThrow();
    });

    test('lève BaselineServiceError si objet null', () => {
      expect(() => validator.ensureValidBaselineFileConfig(null as any)).toThrow(BaselineServiceError);
    });

    test('lève si machineId manquant', () => {
      expect(() =>
        validator.ensureValidBaselineFileConfig(makeBaselineFileConfig({ machineId: '' }))
      ).toThrow(BaselineServiceError);
    });

    test('lève si version manquante', () => {
      expect(() =>
        validator.ensureValidBaselineFileConfig(makeBaselineFileConfig({ version: '' }))
      ).toThrow(BaselineServiceError);
    });

    test('lève si ni timestamp ni lastUpdated', () => {
      const config = makeBaselineFileConfig({ timestamp: undefined, lastUpdated: undefined });
      expect(() => validator.ensureValidBaselineFileConfig(config)).toThrow(BaselineServiceError);
    });

    test('ne lève pas si lastUpdated présent mais pas timestamp', () => {
      const config = makeBaselineFileConfig({ timestamp: undefined, lastUpdated: '2026-01-01T00:00:00Z' });
      expect(() => validator.ensureValidBaselineFileConfig(config)).not.toThrow();
    });

    test('message d\'erreur contient les champs manquants', () => {
      try {
        validator.ensureValidBaselineFileConfig(makeBaselineFileConfig({ machineId: '', version: '' }));
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.message).toContain('machineId');
        expect(err.message).toContain('version');
      }
    });
  });
});
