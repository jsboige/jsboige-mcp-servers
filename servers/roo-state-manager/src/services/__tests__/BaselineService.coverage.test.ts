/**
 * BaselineService.coverage.test.ts — coverage complement (#833 Sprint C3)
 *
 * Add-only, tests-only. Targets the branch arms the nominal suites
 * (BaselineService.test.ts + BaselineService.simple.test.ts) leave cold:
 *
 *  - the #571 per-machine baseline paths in loadBaseline / readBaselineFile
 *    (machine file exists / legacy fallback / default-create + mkdirSync),
 *  - createDefaultBaseline's ROOSYNC_MACHINE_ID `|| 'default-machine'` fallback,
 *  - compareWithBaseline's `if (!baselineFile)` BASELINE_NOT_FOUND throw,
 *  - the roadmap decision chain reached via applyDecision / createSyncDecisions
 *    (parseDecisionsFromMarkdown optional-field fallbacks + JSON.parse catch,
 *    extractField not-found arm, updateDecisionInRoadmap missing-roadmap throw
 *    + write-error catch, getStatusEmoji / getSeverityEmoji unknown fallbacks,
 *    formatDecisionToMarkdown notes ternary, addDecisionsToRoadmap header vs
 *    read-existing).
 *
 * Same mock strategy as BaselineService.test.ts (vi.hoisted delegated-module
 * instances + mocked fs). Adds `mkdirSync` to the fs mock (the nominal mock
 * omits it, which is precisely why the machine-create paths were uncovered),
 * and mocks `../../utils/shared-state-path.js` at the correct depth so
 * getSharedStatePath is deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockBaselineLoaderInstance,
  mockDifferenceDetectorInstance,
  mockChangeApplierInstance,
  mockConfigValidatorInstance,
} = vi.hoisted(() => ({
  mockBaselineLoaderInstance: {
    loadBaseline: vi.fn(),
    readBaselineFile: vi.fn(),
    transformBaselineForDiffDetector: vi.fn(),
  },
  mockDifferenceDetectorInstance: {
    calculateSummary: vi.fn(),
    createSyncDecisions: vi.fn(),
  },
  mockChangeApplierInstance: {
    applyDecision: vi.fn(),
  },
  mockConfigValidatorInstance: {
    validateBaselineConfig: vi.fn().mockReturnValue(true),
    validateBaselineFileConfig: vi.fn().mockReturnValue(true),
    ensureValidBaselineConfig: vi.fn(),
    ensureValidBaselineFileConfig: vi.fn(),
  },
}));

// Deterministic shared-state path — mocked at the SUT-import depth
// (SUT imports '../utils/shared-state-path.js' from src/services/;
//  from this test in src/services/__tests__/ that is '../../utils/...').
vi.mock('../../utils/shared-state-path.js', () => ({
  getSharedStatePath: () => '/test/shared',
}));

// Full fs mock — INCLUDING mkdirSync (the nominal suite's mock omits it,
// which is why the #571 default-create branches are cold).
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../baseline/BaselineLoader.js', () => ({
  BaselineLoader: vi.fn().mockImplementation(() => mockBaselineLoaderInstance),
}));
vi.mock('../baseline/DifferenceDetector.js', () => ({
  DifferenceDetector: vi.fn().mockImplementation(() => mockDifferenceDetectorInstance),
}));
vi.mock('../baseline/ChangeApplier.js', () => ({
  ChangeApplier: vi.fn().mockImplementation(() => mockChangeApplierInstance),
}));
vi.mock('../baseline/ConfigValidator.js', () => ({
  ConfigValidator: vi.fn().mockImplementation(() => mockConfigValidatorInstance),
}));

import { promises as fs } from 'fs';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { BaselineService } from '../BaselineService.js';
import { BaselineLoader } from '../baseline/BaselineLoader.js';
import { DifferenceDetector } from '../baseline/DifferenceDetector.js';
import { ChangeApplier } from '../baseline/ChangeApplier.js';
import { ConfigValidator } from '../baseline/ConfigValidator.js';
import {
  BaselineFileConfig,
  BaselineComparisonReport,
  SyncDecision,
  BaselineServiceError,
  BaselineServiceErrorCode,
  IConfigService,
  IInventoryCollector,
  IDiffDetector,
} from '../../types/baseline.js';

// --- Helpers ---

function np(p: unknown): string {
  return String(p).replace(/\\/g, '/');
}

function createMockConfigService(): IConfigService {
  return {
    getBaselineServiceConfig: vi.fn().mockReturnValue({
      baselinePath: '', roadmapPath: '', cacheEnabled: true, cacheTTL: 300, logLevel: 'ERROR',
    }),
    getSharedStatePath: vi.fn().mockReturnValue('/test/shared'),
    getConfigVersion: vi.fn().mockResolvedValue('2.1.0'),
  } as unknown as IConfigService;
}

function makeBaselineFileConfig(overrides: Partial<BaselineFileConfig> = {}): BaselineFileConfig {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    version: '2.1.0', baselineId: 'baseline-cov', timestamp: now, lastUpdated: now,
    machineId: 'test-machine', autoSync: false, conflictStrategy: 'manual', logLevel: 'info',
    sharedStatePath: '/test/shared',
    machines: [], syncTargets: [], syncPaths: [], decisions: [], messages: [],
    ...overrides,
  } as BaselineFileConfig;
}

function makeReport(): BaselineComparisonReport {
  return {
    baselineMachine: 'test-machine', targetMachine: 'target-machine', baselineVersion: '2.1.0',
    differences: [],
    summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as BaselineComparisonReport;
}

function makeDecision(overrides: Partial<SyncDecision> = {}): SyncDecision {
  return {
    id: 'decision-001', machineId: 'target-machine', differenceId: 'config-roo.modes',
    category: 'config', description: 'Modes differents', baselineValue: ['code'],
    targetValue: [], action: 'sync_to_baseline', severity: 'IMPORTANT', status: 'pending',
    createdAt: '2026-01-01', ...overrides,
  } as SyncDecision;
}

/** A well-formed roadmap section (emoji-prefixed, as written by formatDecisionToMarkdown). */
function fullRoadmap(id = 'decision-001'): string {
  return [
    '# RooSync Roadmap', '',
    `## ✅ Décision ${id}`, '',
    '**Machine:** target-machine',
    '**Catégorie:** config',
    '**Différence:** config-roo.modes',
    '**Sévérité:** ⚠️ IMPORTANT',
    '**Statut:** approved',
    '**Créée le:** 2026-01-01',
    '**Mise à jour le:** 2026-01-02', '',
    '### Description', 'Modes differents', '',
    '### Différence',
    '- **Valeur baseline:** `["code","architect"]`',
    '- **Valeur cible:** `["code"]`', '',
    '### Action requise', '**Type:** sync_to_baseline', '',
    '### Notes', 'quelque note', '', '---',
  ].join('\n');
}

/** A sparse section: required id/machine/category/description present, all optional
 *  fields (Différence, Sévérité, Mise à jour le, Valeur baseline/cible, Type, Notes)
 *  ABSENT → drives the `? … : null` / `|| fallback` right-arms and extractField not-found. */
function sparseRoadmap(id = 'decision-001'): string {
  return [
    '# RooSync Roadmap', '',
    `## ✅ Décision ${id}`, '',
    '**Machine:** target-machine',
    '**Catégorie:** config',
    '**Statut:** approved',
    '**Créée le:** 2026-01-01', '',
    '### Description', 'Modes differents', '', '---',
  ].join('\n');
}

/** A section with malformed JSON in the baseline value → JSON.parse throws → parse catch. */
function malformedJsonRoadmap(id = 'decision-001'): string {
  return [
    `## ✅ Décision ${id}`, '',
    '**Machine:** target-machine',
    '**Catégorie:** config',
    '**Statut:** approved',
    '**Créée le:** 2026-01-01', '',
    '### Description', 'desc', '',
    '- **Valeur baseline:** `{not valid json}`', '', '---',
  ].join('\n');
}

function reinitMocks(): void {
  vi.mocked(BaselineLoader).mockImplementation(() => mockBaselineLoaderInstance as any);
  vi.mocked(DifferenceDetector).mockImplementation(() => mockDifferenceDetectorInstance as any);
  vi.mocked(ChangeApplier).mockImplementation(() => mockChangeApplierInstance as any);
  vi.mocked(ConfigValidator).mockImplementation(() => mockConfigValidatorInstance as any);
  Object.assign(mockBaselineLoaderInstance, {
    loadBaseline: vi.fn(), readBaselineFile: vi.fn(), transformBaselineForDiffDetector: vi.fn(),
  });
  Object.assign(mockDifferenceDetectorInstance, { calculateSummary: vi.fn(), createSyncDecisions: vi.fn() });
  Object.assign(mockChangeApplierInstance, { applyDecision: vi.fn() });
  Object.assign(mockConfigValidatorInstance, {
    validateBaselineConfig: vi.fn().mockReturnValue(true),
    validateBaselineFileConfig: vi.fn().mockReturnValue(true),
    ensureValidBaselineConfig: vi.fn(), ensureValidBaselineFileConfig: vi.fn(),
  });
}

describe('BaselineService — coverage complement (#833 C3)', () => {
  let service: BaselineService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    reinitMocks();
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(existsSync).mockReset();
    vi.mocked(copyFileSync).mockClear();
    vi.mocked(mkdirSync).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SHARED_STATE_PATH = '/test/shared';
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    service = new BaselineService(createMockConfigService(), { collectInventory: vi.fn() } as unknown as IInventoryCollector, { compareBaselineWithMachine: vi.fn() } as unknown as IDiffDetector);
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  // ---- #571 machine baseline paths (loadBaseline) ----

  it('loadBaseline(machineId): uses the per-machine baseline file when it exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => np(p).includes('baselines/m1.json'));
    mockBaselineLoaderInstance.loadBaseline.mockResolvedValue({ machineId: 'm1', version: '2.1.0' });

    const res = await service.loadBaseline('m1');

    expect(res).toEqual({ machineId: 'm1', version: '2.1.0' });
    expect(np(mockBaselineLoaderInstance.loadBaseline.mock.calls[0][0])).toContain('baselines/m1.json');
  });

  it('loadBaseline(machineId): falls back to the legacy baseline when the machine file is absent', async () => {
    vi.mocked(existsSync).mockImplementation((p) => np(p).includes('sync-config.ref.json'));
    mockBaselineLoaderInstance.loadBaseline.mockResolvedValue({ machineId: 'legacy', version: '2.1.0' });

    const res = await service.loadBaseline('m1');

    expect(res).toEqual({ machineId: 'legacy', version: '2.1.0' });
    // targetPath stayed on the legacy file (no default creation, no machine write)
    expect(np(mockBaselineLoaderInstance.loadBaseline.mock.calls[0][0])).toContain('sync-config.ref.json');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('loadBaseline(machineId): creates a default in baselines/ (mkdirSync) when nothing exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // machine, legacy, and baselineDir all absent
    mockBaselineLoaderInstance.loadBaseline.mockResolvedValue({ machineId: 'm1', version: '2.1.0' });

    await service.loadBaseline('m1');

    expect(mkdirSync).toHaveBeenCalledWith(expect.stringMatching(/baselines/), { recursive: true });
    expect(np(vi.mocked(fs.writeFile).mock.calls[0][0])).toContain('baselines/m1.json');
  });

  it('loadBaseline(machineId): skips mkdirSync when baselines/ already exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => np(p).includes('/baselines') && !np(p).endsWith('.json'));
    mockBaselineLoaderInstance.loadBaseline.mockResolvedValue({ machineId: 'm1', version: '2.1.0' });

    await service.loadBaseline('m1');

    expect(mkdirSync).not.toHaveBeenCalled();
    expect(np(vi.mocked(fs.writeFile).mock.calls[0][0])).toContain('baselines/m1.json');
  });

  // ---- #571 machine baseline paths (readBaselineFile) + createDefaultBaseline env fallback ----

  it('readBaselineFile(machineId): reads the per-machine file when it exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => np(p).includes('baselines/m2.json'));
    mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(makeBaselineFileConfig({ machineId: 'm2' }));

    const res = await service.readBaselineFile('m2');

    expect(res?.machineId).toBe('m2');
    expect(np(mockBaselineLoaderInstance.readBaselineFile.mock.calls[0][0])).toContain('baselines/m2.json');
  });

  it('readBaselineFile(machineId): creates a default (mkdirSync + machine path) and uses "default-machine" when ROOSYNC_MACHINE_ID is unset', async () => {
    delete process.env.ROOSYNC_MACHINE_ID; // exercise createDefaultBaseline `|| 'default-machine'`
    vi.mocked(existsSync).mockReturnValue(false);

    const res = await service.readBaselineFile('m3');

    expect(res).not.toBeNull();
    expect(res?.machineId).toBe('default-machine');
    expect(mkdirSync).toHaveBeenCalledWith(expect.stringMatching(/baselines/), { recursive: true });
  });

  // ---- compareWithBaseline: baseline unavailable ----

  it('compareWithBaseline: throws BASELINE_NOT_FOUND when the baseline file resolves to null', async () => {
    // File "exists" (so no default is created) but the loader yields null.
    vi.mocked(existsSync).mockReturnValue(true);
    mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(null);

    await expect(service.compareWithBaseline('target-machine')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.BASELINE_NOT_FOUND,
    });
    await expect(service.compareWithBaseline('target-machine')).rejects.toBeInstanceOf(BaselineServiceError);
  });

  // ---- applyDecision → roadmap parse + update chain ----

  it('applyDecision: parses a full roadmap section, applies, and rewrites the roadmap', async () => {
    vi.mocked(existsSync).mockReturnValue(true); // roadmap exists (load + update)
    vi.mocked(fs.readFile).mockResolvedValue(fullRoadmap('decision-001') as any);
    mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, appliedAt: '2026-01-03' });

    const res = await service.applyDecision('decision-001');

    expect(res.success).toBe(true);
    expect(mockChangeApplierInstance.applyDecision).toHaveBeenCalledTimes(1);
    // updateDecisionInRoadmap rewrote the roadmap
    const roadmapWrite = vi.mocked(fs.writeFile).mock.calls.find((c) => np(c[0]).endsWith('sync-roadmap.md'));
    expect(roadmapWrite).toBeDefined();
  });

  it('applyDecision: parses a sparse section (optional-field fallbacks) — decision id mismatch → DECISION_NOT_FOUND', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(sparseRoadmap('decision-001') as any);

    // The parsed decision id is 'decision-001'; request a different id so applyDecision
    // reaches the not-found throw *after* the sparse-section parse branches ran.
    await expect(service.applyDecision('decision-999')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.DECISION_NOT_FOUND,
    });
  });

  it('applyDecision: a malformed-JSON section is swallowed by the parse catch (no decision produced)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(malformedJsonRoadmap('decision-001') as any);

    // JSON.parse throws inside the per-section try → caught → section dropped → not found.
    await expect(service.applyDecision('decision-001')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.DECISION_NOT_FOUND,
    });
  });

  it('applyDecision: roadmap missing → loadDecisionsFromRoadmap returns [] → DECISION_NOT_FOUND', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // roadmap absent
    await expect(service.applyDecision('decision-001')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.DECISION_NOT_FOUND,
    });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('applyDecision: a write failure during roadmap update surfaces as an error', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(fullRoadmap('decision-001') as any);
    mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, appliedAt: '2026-01-03' });
    vi.mocked(fs.writeFile).mockRejectedValue(new Error('disk full'));

    await expect(service.applyDecision('decision-001')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED,
    });
  });

  // ---- createSyncDecisions → addDecisionsToRoadmap → format + emoji fallbacks ----

  it('createSyncDecisions: unknown status/severity hit the emoji fallbacks and notes are rendered (roadmap created fresh)', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // roadmap absent → header branch
    mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([
      makeDecision({ status: 'weird' as any, severity: 'weird' as any, notes: 'attention-note' }),
    ]);

    const res = await service.createSyncDecisions(makeReport());

    expect(res).toHaveLength(1);
    const content = String(vi.mocked(fs.writeFile).mock.calls[0][1]);
    expect(content).toContain('❓'); // getStatusEmoji fallback ❓
    expect(content).toContain('ℹ'); // getSeverityEmoji fallback ℹ️
    expect(content).toContain('attention-note'); // notes ternary true-arm
  });

  it('createSyncDecisions: appends to an existing roadmap and omits the Notes section when there are no notes', async () => {
    vi.mocked(existsSync).mockReturnValue(true); // roadmap exists → read-existing branch
    vi.mocked(fs.readFile).mockResolvedValue('# RooSync Roadmap\n' as any);
    mockDifferenceDetectorInstance.createSyncDecisions.mockReturnValue([
      makeDecision({ status: 'approved', severity: 'IMPORTANT', notes: undefined }),
    ]);

    await service.createSyncDecisions(makeReport());

    expect(fs.readFile).toHaveBeenCalled();
    const content = String(vi.mocked(fs.writeFile).mock.calls[0][1]);
    expect(content).not.toContain('### Notes'); // notes ternary false-arm
    expect(content).toContain('✅ Décision decision-001'); // known status emoji
  });

  // ---- constructor: no SHARED_STATE_PATH → getSharedStatePath()-derived paths ----

  it('constructor: derives paths from getSharedStatePath() when SHARED_STATE_PATH is unset', () => {
    delete process.env.SHARED_STATE_PATH; // exercise the `else` branch (L76)
    const svc = new BaselineService(createMockConfigService(), { collectInventory: vi.fn() } as unknown as IInventoryCollector, { compareBaselineWithMachine: vi.fn() } as unknown as IDiffDetector);
    expect(svc.getState().isBaselineLoaded).toBe(false); // constructed without throwing
  });

  // ---- readBaselineFile(machineId): legacy fallback (machine file absent, legacy present) ----

  it('readBaselineFile(machineId): falls back to legacy when the machine file is absent', async () => {
    vi.mocked(existsSync).mockImplementation((p) => np(p).includes('sync-config.ref.json'));
    mockBaselineLoaderInstance.readBaselineFile.mockResolvedValue(makeBaselineFileConfig({ machineId: 'legacy' }));

    const res = await service.readBaselineFile('m4');

    expect(res?.machineId).toBe('legacy');
    expect(np(mockBaselineLoaderInstance.readBaselineFile.mock.calls[0][0])).toContain('sync-config.ref.json');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  // ---- updateDecisionInRoadmap: roadmap disappeared between load and update ----

  it('applyDecision: roadmap present for load but missing at update → ROADMAP_UPDATE_FAILED', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValue(false); // load sees it, update does not
    vi.mocked(fs.readFile).mockResolvedValue(fullRoadmap('decision-001') as any);
    mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, appliedAt: '2026-01-03' });

    await expect(service.applyDecision('decision-001')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED,
    });
    expect(fs.writeFile).not.toHaveBeenCalled(); // threw before the write
  });

  // ---- updateDecisionInRoadmap: decision parsed without "Mise à jour le" → updatedAt || createdAt ----

  it('applyDecision: a decision lacking "Mise à jour le" falls back to createdAt for the timestamp', async () => {
    const noUpdatedAt = [
      `## ✅ Décision decision-001`, '',
      '**Machine:** target-machine',
      '**Catégorie:** config',
      '**Statut:** approved',
      '**Créée le:** 2026-01-01', '',
      '### Description', 'Modes differents', '', '---',
    ].join('\n');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(noUpdatedAt as any);
    mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, appliedAt: '2026-01-03' });

    const res = await service.applyDecision('decision-001');

    expect(res.success).toBe(true);
    const roadmapWrite = vi.mocked(fs.writeFile).mock.calls.find((c) => np(c[0]).endsWith('sync-roadmap.md'));
    expect(String(roadmapWrite?.[1])).toContain('2026-01-01'); // createdAt used as the update timestamp
  });

  // ---- updateDecisionInRoadmap: existing "## Décision <id>" heading → regex replace ----

  it('applyDecision: an existing plain "## Décision <id>" heading is replaced in place', async () => {
    // Load reads a parseable (emoji-prefixed) section; the update re-reads a roadmap
    // that already contains a plain heading the update regex `## Décision <id>` matches.
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(fullRoadmap('decision-001') as any)
      .mockResolvedValue('# Roadmap\n\n## Décision decision-001\nancien contenu\n' as any);
    mockChangeApplierInstance.applyDecision.mockResolvedValue({ success: true, appliedAt: '2026-01-03' });

    const res = await service.applyDecision('decision-001');

    expect(res.success).toBe(true);
    const roadmapWrite = vi.mocked(fs.writeFile).mock.calls.find((c) => np(c[0]).endsWith('sync-roadmap.md'));
    expect(String(roadmapWrite?.[1])).not.toContain('ancien contenu'); // replaced, not appended
  });

  // ---- parseDecisionsFromMarkdown: non-bold field + missing description ----

  it('applyDecision: parses a non-bold field via the fallback regex and an absent description', async () => {
    const odd = [
      `## ✅ Décision decision-777`, '',
      '**Machine:** target-machine',
      'Catégorie: config', // non-bold → extractField bold match fails → fallback regex
      '**Statut:** approved',
      '**Créée le:** 2026-01-01', '', '---', // no "### Description" → descriptionMatch null → ''
    ].join('\n');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(odd as any);

    // description is '' → the push guard drops it → requested id not found.
    await expect(service.applyDecision('decision-777')).rejects.toMatchObject({
      code: BaselineServiceErrorCode.DECISION_NOT_FOUND,
    });
  });
});
