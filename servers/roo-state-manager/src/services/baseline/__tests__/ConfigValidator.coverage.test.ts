/**
 * Coverage tests pour ConfigValidator — branches froides / défensives
 *
 * Le base test (ConfigValidator.test.ts, 258 LOC) couvre les happy paths et
 * les champs manquants un-par-un. Ce fichier pince les branches que la base
 * n'atteint jamais ou dont elle ne vérifie pas les side-effects :
 *
 * - validateBaselineFileConfig catch (L64-67) : COLD — la base ne passe jamais
 *   null/throwing à validate* (uniquement à ensure*). Catch jamais atteint.
 * - L47 Array.isArray truthy-non-array : COLD — base ne teste que null/undefined/[]
 * - Bloc DEBUG L52-62 : déclenché par la base mais contenu console.error jamais pinné
 * - validateBaselineConfig catch L31 : console.error side-effect jamais asserté
 * - ensureValidBaselineFileConfig L102 : format join [a,b,c] avec 3 champs jamais testé
 * - Asymétrie : validateBaselineFileConfig (L45) ne vérifie QUE timestamp,
 *   ensure* (L98) accepte timestamp OU lastUpdated — pin crucial
 *
 * @module services/baseline/__tests__/ConfigValidator.coverage.test
 * @see #833 C3
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigValidator } from '../ConfigValidator.js';
import {
  BaselineServiceError,
  BaselineServiceErrorCode,
} from '../../../types/baseline.js';
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

function makeBaselineFileConfig(
  overrides: Partial<BaselineFileConfig> = {}
): BaselineFileConfig {
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
        id: 'machine-1',
        name: 'Machine 1',
        hostname: 'host1',
        os: 'Windows',
        architecture: 'x64',
        lastSeen: '2026-01-01T00:00:00Z',
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
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  validator = new ConfigValidator();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ─────────────────── tests ───────────────────

describe('ConfigValidator.coverage', () => {
  // ============================================================
  // validateBaselineFileConfig — catch block (L64-67) COLD
  // ============================================================
  describe('validateBaselineFileConfig — catch (L64-67) [COLD en base]', () => {
    test('null → catch → console.error + return false', () => {
      // La base ne passe jamais null à validate* (uniquement à ensure*).
      // Accéder à baselineFile.version sur null → TypeError → catch L64.
      expect(validator.validateBaselineFileConfig(null as any)).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toBe(
        'Erreur lors de la validation du fichier baseline'
      );
      expect(errorSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    });

    test('undefined → catch → return false', () => {
      expect(validator.validateBaselineFileConfig(undefined as any)).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    test('accesseur qui lève → catch → return false (défense runtime)', () => {
      // Objet dont le getter version lève — simulate un proxy/hostile.
      const hostile = {
        get version() {
          throw new Error('proxy blocked');
        },
      } as any;
      expect(validator.validateBaselineFileConfig(hostile)).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // validateBaselineFileConfig — L47 truthy-non-array [COLD]
  // ============================================================
  describe('validateBaselineFileConfig — L47 Array.isArray truthy-non-array [COLD]', () => {
    test('machines = {} (truthy, pas array) → L46 true, L47 false → isValid false', () => {
      // Base ne teste que null/undefined/[] — jamais un truthy non-array.
      // !!{} = true passe L46, Array.isArray({}) = false casse L47.
      const config = makeBaselineFileConfig({ machines: {} as any });
      expect(validator.validateBaselineFileConfig(config)).toBe(false);
    });

    test('machines = "string" (truthy, pas array) → isValid false', () => {
      const config = makeBaselineFileConfig({ machines: 'not-an-array' as any });
      expect(validator.validateBaselineFileConfig(config)).toBe(false);
    });

    test('machines = 42 (truthy number, pas array) → isValid false', () => {
      const config = makeBaselineFileConfig({ machines: 42 as any });
      expect(validator.validateBaselineFileConfig(config)).toBe(false);
    });
  });

  // ============================================================
  // validateBaselineFileConfig — bloc DEBUG (L52-62) contenu pinné
  // ============================================================
  describe('validateBaselineFileConfig — bloc DEBUG (L52-62) format console.error', () => {
    test('isValid false → 2 appels console.error avec préfixes exacts', () => {
      // Déclenché par la base mais contenu jamais vérifié.
      validator.validateBaselineFileConfig(makeBaselineFileConfig({ version: '' }));
      // Appel 1 : DEBUG VALIDATION FAILED + détails champ-par-champ
      expect(errorSpy.mock.calls[0][0]).toBe('DEBUG VALIDATION FAILED:');
      // Appel 2 : FULL OBJECT + JSON.stringify
      expect(errorSpy.mock.calls[1][0]).toBe('FULL OBJECT:');
      expect(typeof errorSpy.mock.calls[1][1]).toBe('string'); // JSON string
    });

    test('DEBUG call contient les flags ver/bid/mid/ts/m/isArray/len (L53-59)', () => {
      validator.validateBaselineFileConfig(
        makeBaselineFileConfig({ machineId: '', machines: [] })
      );
      const debugCall = errorSpy.mock.calls.find(
        (c) => c[0] === 'DEBUG VALIDATION FAILED:'
      );
      expect(debugCall).toBeDefined();
      // Le call spread les paires 'key:' value comme args séparés
      const debugArgs = debugCall!.slice(1).join(' ');
      expect(debugArgs).toContain('ver:');
      expect(debugArgs).toContain('bid:');
      expect(debugArgs).toContain('mid:');
      expect(debugArgs).toContain('ts:');
      expect(debugArgs).toContain('m:');
      expect(debugArgs).toContain('isArray:');
      expect(debugArgs).toContain('len:');
    });

    test('DEBUG len = undefined quand machines est null (optional-chain L59)', () => {
      // baselineFile.machines?.length → null?.length = undefined.
      // Les paires label/value sont des args séparés : ['len:', <value>].
      validator.validateBaselineFileConfig(
        makeBaselineFileConfig({ machines: null as any })
      );
      const debugCall = errorSpy.mock.calls.find(
        (c) => c[0] === 'DEBUG VALIDATION FAILED:'
      );
      const lenIdx = debugCall!.indexOf('len:');
      expect(lenIdx).toBeGreaterThan(-1);
      // L'arg suivant 'len:' est baselineFile.machines?.length (undefined ici)
      expect(debugCall![lenIdx + 1]).toBeUndefined();
    });

    test('DEBUG len = N quand machines est un array non-vide', () => {
      validator.validateBaselineFileConfig(
        makeBaselineFileConfig({ version: '', machines: [{ id: 'x' }] as any })
      );
      const debugCall = errorSpy.mock.calls.find(
        (c) => c[0] === 'DEBUG VALIDATION FAILED:'
      );
      const lenIdx = debugCall!.indexOf('len:');
      expect(debugCall![lenIdx + 1]).toBe(1);
    });

    test('isValid true → AUCUN appel console.error (bloc DEBUG skippé)', () => {
      validator.validateBaselineFileConfig(makeBaselineFileConfig());
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // validateBaselineConfig — catch L31 side-effect pinné
  // ============================================================
  describe('validateBaselineConfig — catch (L30-33) console.error pinné', () => {
    test('null → catch → console.error("Erreur lors de... baseline", error)', () => {
      // La base hit le catch via null mais n'asserte jamais le console.error.
      expect(validator.validateBaselineConfig(null as any)).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toBe(
        'Erreur lors de la validation de la baseline'
      );
      expect(errorSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    });

    test('objet vide {} → false SANS console.error (pas de throw, juste falsy)', () => {
      // {} ne throw pas (accès .machineId = undefined) → return false direct,
      // catch NON atteint → aucun console.error. Pin cette distinction.
      expect(validator.validateBaselineConfig({} as any)).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // validateBaselineConfig — boundary truthy/falsy (L21-29 !!coalesce)
  // ============================================================
  describe('validateBaselineConfig — boundary falsy (L21-29)', () => {
    test('version = 0 (falsy number) → false (!!0 = false)', () => {
      // Base teste version:'' ; pin que la coercition !! attrape aussi 0.
      const config = makeBaselineConfig({ version: 0 as any });
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });

    test('machineId = 0 (falsy) → false', () => {
      const config = makeBaselineConfig({ machineId: 0 as any });
      expect(validator.validateBaselineConfig(config)).toBe(false);
    });
  });

  // ============================================================
  // Asymétrie — validateBaselineFileConfig ignore lastUpdated (L45)
  // ============================================================
  describe('asymétrie validate vs ensure — lastUpdated (L45 vs L98)', () => {
    test('validateBaselineFileConfig retourne FALSE si timestamp absent même si lastUpdated présent', () => {
      // L45 ne vérifie QUE timestamp. lastUpdated est ignoré par validate*.
      // Pin : contrairement à ensure* (L98) qui accepte timestamp OU lastUpdated.
      const config = makeBaselineFileConfig({
        timestamp: undefined,
        lastUpdated: '2026-01-01T00:00:00Z',
      });
      expect(validator.validateBaselineFileConfig(config)).toBe(false);
    });

    test('ensureValidBaselineFileConfig ACCEPT lastUpdated seul (timestamp absent) — asymétrie', () => {
      // L98 : !timestamp && !lastUpdated → missingFields.push.
      // lastUpdated présent → pas pushé → pas de throw.
      const config = makeBaselineFileConfig({
        timestamp: undefined,
        lastUpdated: '2026-01-01T00:00:00Z',
      });
      expect(() => validator.ensureValidBaselineFileConfig(config)).not.toThrow();
    });

    test('validate=true mais ensure throw impossible — validate plus strict sur timestamp', () => {
      // Résumé du contrat : validateBaselineFileConfig exige timestamp (L45),
      // ensureValidBaselineFileConfig lève seulement si NI timestamp NI lastUpdated (L98).
      // Donc il existe une zone (lastUpdated seul) où validate=false mais ensure=OK.
      // C'est un comportement load-bearing — pin pour éviter uniformisation.
      const config = makeBaselineFileConfig({
        timestamp: undefined,
        lastUpdated: '2026-01-01T00:00:00Z',
      });
      expect(validator.validateBaselineFileConfig(config)).toBe(false);
      expect(() => validator.ensureValidBaselineFileConfig(config)).not.toThrow();
    });
  });

  // ============================================================
  // ensureValidBaselineFileConfig — format join multi-champs (L102)
  // ============================================================
  describe('ensureValidBaselineFileConfig — format join [a, b, c] (L100-105)', () => {
    test('3 champs manquants → message contient [machineId, version, timestamp/lastUpdated]', () => {
      // Base teste chaque champ individuellement mais jamais les 3 ensemble.
      const config = makeBaselineFileConfig({
        machineId: '',
        version: '',
        timestamp: undefined,
        lastUpdated: undefined,
      });
      try {
        validator.ensureValidBaselineFileConfig(config);
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BaselineServiceError);
        expect(err.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        // Format exact : champs requis manquants [a, b, c] avec join ', '
        expect(err.message).toContain('champs requis manquants [');
        expect(err.message).toContain('machineId');
        expect(err.message).toContain('version');
        expect(err.message).toContain('timestamp/lastUpdated');
        expect(err.message).toContain(']');
        // Ordre : machineId (L95), version (L96), timestamp/lastUpdated (L98)
        const bracket = err.message.slice(
          err.message.indexOf('['),
          err.message.indexOf(']') + 1
        );
        expect(bracket).toBe('[machineId, version, timestamp/lastUpdated]');
      }
    });

    test('1 champ manquant → message avec liste singleton', () => {
      const config = makeBaselineFileConfig({ machineId: 'present', version: '' });
      try {
        validator.ensureValidBaselineFileConfig(config);
        expect.fail('Should throw');
      } catch (err: any) {
        const bracket = err.message.slice(
          err.message.indexOf('['),
          err.message.indexOf(']') + 1
        );
        expect(bracket).toBe('[version]');
      }
    });

    test('2 champs manquants → join binaire', () => {
      const config = makeBaselineFileConfig({
        machineId: '',
        version: '',
        timestamp: '2026-01-01',
      });
      try {
        validator.ensureValidBaselineFileConfig(config);
        expect.fail('Should throw');
      } catch (err: any) {
        const bracket = err.message.slice(
          err.message.indexOf('['),
          err.message.indexOf(']') + 1
        );
        expect(bracket).toBe('[machineId, version]');
      }
    });
  });

  // ============================================================
  // ensureValidBaselineFileConfig — null path (L87-92)
  // ============================================================
  describe('ensureValidBaselineFileConfig — null (L87-92)', () => {
    test('null → message "objet null ou undefined" + code BASELINE_INVALID', () => {
      // Base teste le throw mais pas le message exact ni le code sur ce path.
      try {
        validator.ensureValidBaselineFileConfig(null as any);
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BaselineServiceError);
        expect(err.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        expect(err.message).toContain('objet null ou undefined');
      }
    });

    test('undefined → même path que null (falsy L87)', () => {
      try {
        validator.ensureValidBaselineFileConfig(undefined as any);
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.message).toContain('objet null ou undefined');
      }
    });
  });

  // ============================================================
  // ensureValidBaselineConfig — throw message exact (L75-78)
  // ============================================================
  describe('ensureValidBaselineConfig — throw (L73-79)', () => {
    test('invalide → message "Configuration baseline invalide" + code', () => {
      // Base vérifie le code mais pas le message exact sur ce path.
      try {
        validator.ensureValidBaselineConfig({} as any);
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BaselineServiceError);
        expect(err.code).toBe(BaselineServiceErrorCode.BASELINE_INVALID);
        expect(err.message).toBe('Configuration baseline invalide');
      }
    });
  });
});
