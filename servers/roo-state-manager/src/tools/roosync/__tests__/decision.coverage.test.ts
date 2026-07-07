/**
 * Coverage complement pour roosyncDecision (decision.ts) — bras froids CQRS (COLD)
 *
 * Le test de base (decision.test.ts) couvre essentiellement la validation de schéma
 * (RooSyncDecisionArgsSchema + RooSyncDecisionResultSchema) + quelques chemins via
 * l'integration test. Les chemins d'exécution réels restent froids en CI (43%S isolé,
 * ~72%S full CI) :
 *
 * - decision introuvable (loadDecisionDetails → null) — L163-175
 * - status invalide (validateDecisionStatus → false) — L190-202
 * - action 'info' (délégation roosyncDecisionInfo) — L180-187
 * - switch approve/reject/apply/rollback — L219-345
 *   * apply dry-run (L244-253)
 *   * apply backup creation (fichiers existent / aucun fichier) — L257-280
 *   * apply backup error (sans force = return error / avec force = warn) — L281-296
 *   * rollback avec meta / sans meta / error — L308-345
 * - ZodError action handling (L360-368) + generic error catch (L370-383)
 *
 * Epic C3 #833 — test-only, 0 source touché. Mocks complets (lazy-roosync + helpers
 * + decision-info + fs dynamic imports). Continuité PR #830 (decision-helpers).
 *
 * @module tools/roosync/__tests__/decision.coverage
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { roosyncDecision } from '../decision.js';

// ─────────────────── mocks (hoisted) ───────────────────

const mocks = vi.hoisted(() => ({
    // decision-helpers (7 exports consommés par decision.ts)
    loadDecisionDetails: vi.fn(),
    validateDecisionStatus: vi.fn(),
    updateRoadmapStatus: vi.fn(),
    formatDecisionResult: vi.fn(),
    moveDecisionFile: vi.fn(),
    createBackup: vi.fn(),
    restoreBackup: vi.fn(),
    // decision-info
    roosyncDecisionInfo: vi.fn(),
    // fs (dynamic imports dans apply/rollback)
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
}));

// lazy-roosync : import RÉEL du code (L15) — getRooSyncService async
// Chemin résolu DEPUIS le fichier de test (__tests__/ → 3 niveaux vers src/services)
vi.mock('../../../services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(async () => ({
        getConfig: () => ({ machineId: 'po-2026', sharedPath: '/shared' }),
    })),
    RooSyncServiceError: class extends Error {
        code: string;
        constructor(message: string, code: string) {
            super(message);
            this.name = 'RooSyncServiceError';
            this.code = code;
        }
    },
}));

vi.mock('../utils/decision-helpers.js', () => ({
    loadDecisionDetails: mocks.loadDecisionDetails,
    validateDecisionStatus: mocks.validateDecisionStatus,
    updateRoadmapStatus: mocks.updateRoadmapStatus,
    formatDecisionResult: mocks.formatDecisionResult,
    moveDecisionFile: mocks.moveDecisionFile,
    createBackup: mocks.createBackup,
    restoreBackup: mocks.restoreBackup,
}));

vi.mock('../decision-info.js', () => ({
    roosyncDecisionInfo: mocks.roosyncDecisionInfo,
}));

// fs dynamic imports : await import('fs') → mock
vi.mock('fs', () => ({
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    writeFileSync: mocks.writeFileSync,
    // le module fs peut exposer plus, mais seules ces 3 sont utilisées dynamiquement
}));

// ─────────────────── helpers ───────────────────

const SENTINEL_RESULT = { success: true, decisionId: 'DEC-X', action: 'approve', sentinel: true };

function decisionFound(status: string) {
    return { id: 'DEC-001', status, title: 'Test decision' };
}

beforeEach(() => {
    vi.clearAllMocks();
    // formatDecisionResult retourne un sentinel par défaut (chemins success)
    mocks.formatDecisionResult.mockReturnValue(SENTINEL_RESULT);
    mocks.validateDecisionStatus.mockReturnValue(true);
    mocks.loadDecisionDetails.mockResolvedValue(decisionFound('pending'));
    mocks.moveDecisionFile.mockReturnValue(undefined);
    mocks.updateRoadmapStatus.mockReturnValue(undefined);
    mocks.createBackup.mockReturnValue({ files: ['/shared/decisions/pending/DEC-001.json'], backupDir: '/shared/decisions/backups' });
    mocks.restoreBackup.mockReturnValue(['/shared/decisions/pending/DEC-001.json']);
    mocks.roosyncDecisionInfo.mockResolvedValue({ success: true, decisionId: 'DEC-001', action: 'info' });
});

// ─────────────────── tests ───────────────────

describe('roosyncDecision — coverage complement (cold branches)', () => {

    // ============================================================
    // Decision introuvable (L163-175)
    // ============================================================
    describe('decision not found', () => {
        test('returns success:false when loadDecisionDetails returns null', async () => {
            mocks.loadDecisionDetails.mockResolvedValue(null);
            const result = await roosyncDecision({ action: 'approve', decisionId: 'MISSING' } as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain('introuvable');
            expect(result.decisionId).toBe('MISSING');
        });
    });

    // ============================================================
    // Status invalide (L190-202)
    // ============================================================
    describe('invalid status transition', () => {
        test('returns success:false when validateDecisionStatus rejects', async () => {
            mocks.validateDecisionStatus.mockReturnValue(false);
            const result = await roosyncDecision({ action: 'approve', decisionId: 'DEC-001' } as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain("non permise");
            expect(result.newStatus).toBe('pending'); // unchanged
        });
    });

    // ============================================================
    // action 'info' (L180-187)
    // ============================================================
    describe('action info', () => {
        test('delegates to roosyncDecisionInfo and returns its result', async () => {
            const result = await roosyncDecision({ action: 'info', decisionId: 'DEC-001' } as any);
            expect(mocks.roosyncDecisionInfo).toHaveBeenCalled();
            expect(result).toMatchObject({ success: true, action: 'info' });
        });
    });

    // ============================================================
    // approve / reject (L220-240)
    // ============================================================
    describe('approve / reject', () => {
        test('approve calls updateRoadmapStatus + moveDecisionFile', async () => {
            const result = await roosyncDecision({ action: 'approve', decisionId: 'DEC-001', comment: 'LGTM' } as any);
            expect(mocks.updateRoadmapStatus).toHaveBeenCalledWith(expect.anything(), 'DEC-001', 'approved', expect.objectContaining({ comment: 'LGTM' }));
            expect(mocks.moveDecisionFile).toHaveBeenCalled();
            expect(result).toBe(SENTINEL_RESULT);
        });

        test('reject calls updateRoadmapStatus with reason', async () => {
            await roosyncDecision({ action: 'reject', decisionId: 'DEC-001', reason: 'bad' } as any);
            expect(mocks.updateRoadmapStatus).toHaveBeenCalledWith(expect.anything(), 'DEC-001', 'rejected', expect.objectContaining({ reason: 'bad' }));
            expect(mocks.moveDecisionFile).toHaveBeenCalled();
        });
    });

    // ============================================================
    // apply — dry-run (L244-253)
    // ============================================================
    describe('apply dry-run', () => {
        test('dry-run returns early via formatDecisionResult without backup', async () => {
            const dryResult = { success: true, dry: true };
            mocks.formatDecisionResult.mockReturnValue(dryResult);
            const result = await roosyncDecision({ action: 'apply', decisionId: 'DEC-001', dryRun: true } as any);
            expect(mocks.createBackup).not.toHaveBeenCalled();
            expect(result).toBe(dryResult);
        });
    });

    // ============================================================
    // apply — backup paths (L257-296)
    // ============================================================
    describe('apply backup', () => {
        test('creates backup when decision JSON exists (rollbackAvailable=true)', async () => {
            mocks.existsSync.mockReturnValue(true); // both decisionJsonPath + roadmapPath exist
            await roosyncDecision({ action: 'apply', decisionId: 'DEC-001' } as any);
            expect(mocks.createBackup).toHaveBeenCalled();
            expect(mocks.writeFileSync).toHaveBeenCalled(); // meta write
            // formatDecisionResult called with rollbackAvailable option
            const opts = mocks.formatDecisionResult.mock.calls[0][5];
            expect(opts.rollbackAvailable).toBe(true);
        });

        test('skips backup when no files exist (rollbackAvailable=false)', async () => {
            mocks.existsSync.mockReturnValue(false); // neither file exists
            await roosyncDecision({ action: 'apply', decisionId: 'DEC-001' } as any);
            expect(mocks.createBackup).not.toHaveBeenCalled();
            const opts = mocks.formatDecisionResult.mock.calls[0][5];
            expect(opts.rollbackAvailable).toBe(false);
        });

        test('returns error when backup throws and force not set', async () => {
            mocks.existsSync.mockReturnValue(true);
            mocks.createBackup.mockImplementation(() => { throw new Error('disk full'); });
            const result = await roosyncDecision({ action: 'apply', decisionId: 'DEC-001' } as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain('disk full');
            expect(result.error).toContain('force=true');
        });

        test('continues with warn when backup throws and force=true', async () => {
            mocks.existsSync.mockReturnValue(true);
            mocks.createBackup.mockImplementation(() => { throw new Error('disk full'); });
            await roosyncDecision({ action: 'apply', decisionId: 'DEC-001', force: true } as any);
            // formatDecisionResult still called (success path)
            const opts = mocks.formatDecisionResult.mock.calls[0][5];
            expect(opts.executionLog).toBeDefined();
            expect(opts.executionLog.some((l: string) => l.includes('force=true'))).toBe(true);
        });
    });

    // ============================================================
    // rollback (L308-345)
    // ============================================================
    describe('rollback', () => {
        test('restores files when meta backup exists', async () => {
            mocks.existsSync.mockReturnValue(true);
            mocks.readFileSync.mockReturnValue(JSON.stringify({ files: ['/a.json'], backupDir: '/backups' }));
            await roosyncDecision({ action: 'rollback', decisionId: 'DEC-001', reason: 'bug' } as any);
            expect(mocks.restoreBackup).toHaveBeenCalled();
            const opts = mocks.formatDecisionResult.mock.calls[0][5];
            expect(opts.restoredFiles).toBeDefined();
            expect(opts.restoredFiles.length).toBe(1);
        });

        test('warns when no meta backup found (status-only update)', async () => {
            mocks.existsSync.mockReturnValue(false);
            await roosyncDecision({ action: 'rollback', decisionId: 'DEC-001', reason: 'bug' } as any);
            expect(mocks.restoreBackup).not.toHaveBeenCalled();
            const opts = mocks.formatDecisionResult.mock.calls[0][5];
            expect(opts.executionLog.some((l: string) => l.includes('Aucun backup'))).toBe(true);
        });

        test('returns error when restoreBackup throws', async () => {
            mocks.existsSync.mockReturnValue(true);
            mocks.readFileSync.mockReturnValue('not-json'); // JSON.parse throws
            const result = await roosyncDecision({ action: 'rollback', decisionId: 'DEC-001', reason: 'bug' } as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain('rollback');
        });
    });

    // ============================================================
    // Error handling (L357-383)
    // ============================================================
    describe('error handling', () => {
        test('ZodError on action returns success:false (graceful)', async () => {
            // action invalide → parse() lève ZodError avec path=['action']
            const result = await roosyncDecision({ action: 'bogus', decisionId: 'DEC-001' } as any);
            expect(result.success).toBe(false);
            expect(result.machineId).toBeDefined();
        });

        test('non-action ZodError is rethrown', async () => {
            // reject sans reason → superRefine lève ZodError path=['reason'] (non-action) → rethrown
            await expect(roosyncDecision({ action: 'reject', decisionId: 'DEC-001' } as any)).rejects.toThrow();
        });

        test('generic non-Zod error returns success:false with message', async () => {
            mocks.loadDecisionDetails.mockRejectedValue(new Error('fs read failed'));
            const result = await roosyncDecision({ action: 'approve', decisionId: 'DEC-001' } as any);
            expect(result.success).toBe(false);
            expect(result.error).toBe('fs read failed');
            expect(result.machineId).toBe('unknown');
        });
    });
});
