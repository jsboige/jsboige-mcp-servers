/**
 * #833 Sprint C3 — RollbackManager branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `RollbackManager.test.ts` (16 tests) covers the happy paths and the
 * two-terminal outcomes (full success, single-failure) of the public API using a
 * real tmpdir. It leaves a focused set of branches cold, all pinned here against
 * source lines of `RollbackManager.ts`:
 *
 * - `restoreAll` L92 `if (entry.restored) continue` — the idempotence skip. The base
 *   never calls restoreAll twice, so a second pass over already-restored entries is
 *   never exercised.
 * - `restoreAll` L124-126 **MIX partial message** — `Rollback partiel: X restaurés,
 *   Y échoués`. The base has either full success (X>0, Y=0) or pure failure
 *   (X=0, Y=1); the simultaneous X>0 AND Y>0 arm is never reached.
 * - `restoreAll` L108-115 **cleanup unlink failure warn** — the inner try/catch
 *   around `unlink` (L110) that logs a warn (L113) but does NOT fail the restore.
 *   The base only exercises the happy unlink (test "should cleanup backups").
 * - `restoreAll` L96-98 **backup-missing error string** — the base triggers the
 *   throw but never asserts `failedFiles[0].error` carries the exact
 *   `Backup non trouvé: ${path}` message (L97).
 * - `release` L146 **existsSync guard false** — when a tracked backup no longer
 *   exists on disk, the `if (existsSync(entry.backupPath))` guard skips unlink.
 *   Base release-cleanup test always has an existing file.
 * - `release` L150-152 **cleanup unlink failure warn** — symmetric to restoreAll's
 *   catch; never exercised.
 * - Logger side-effects L58/L76/L89/L105/L113/L128 — the debug/info/warn lines are
 *   emitted on every path but never asserted (the base's mockLogger is unchecked).
 * - `restoreAll` **no-clear invariant** — restoreAll marks entries `restored=true`
 *   but does NOT clear the map (only `release` does, L156). The base never asserts
 *   that `size` is unchanged after restoreAll.
 *
 * Strategy: real tmpdir (matches base) for realistic scenarios; a partial
 * `fs/promises` mock (importActual spread + `unlink` override) for the two
 * unlink-failure branches that can't be reproduced reliably on a real filesystem.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

// ─────────────────── partial mock: fs/promises (unlink failure injection) ───────────────────

let forceUnlinkFailure = false;

vi.mock('fs/promises', async (importActual) => {
    const actual = await importActual() as any;
    return {
        ...actual,
        unlink: vi.fn(async (p: string) => {
            if (forceUnlinkFailure) {
                throw Object.assign(new Error('EUNLINK mock: permission denied'), { code: 'EUNLINK' });
            }
            return actual.unlink(p);
        }),
    };
});

import { RollbackManager } from '../RollbackManager.js';
import type { Logger } from '../../utils/logger.js';

// ─────────────────── helpers ───────────────────

function makeMockLogger(): Logger {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
    } as any;
}

// ─────────────────── setup ───────────────────

let rollbackManager: RollbackManager;
let mockLogger: Logger;
let tempDir: string;

beforeEach(async () => {
    forceUnlinkFailure = false;
    vi.clearAllMocks();
    mockLogger = makeMockLogger();
    rollbackManager = new RollbackManager(mockLogger);
    tempDir = await mkdtemp(join(tmpdir(), 'rollback-cov-'));
});

afterEach(async () => {
    forceUnlinkFailure = false;
    if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('RollbackManager — branch coverage (#833 C3, source-grounded)', () => {

    // ============================================================
    // track — logger.debug side-effect (L58)
    // ============================================================
    describe('track — logger side-effect (L58)', () => {
        test('emits a debug log naming both paths (L58)', () => {
            rollbackManager.track('/orig/a.json', '/bk/a.json');

            // L58: `Backup tracké: ${backupPath} → ${originalPath}`
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            const msg = (mockLogger.debug as any).mock.calls[0][0] as string;
            expect(msg).toContain('/bk/a.json');
            expect(msg).toContain('/orig/a.json');
            expect(msg).toContain('→');
        });
    });

    // ============================================================
    // createAndTrack — logger.info side-effect (L76) + backup path format (L67-68)
    // ============================================================
    describe('createAndTrack — logger + path format (L67-68, L76)', () => {
        test('emits an info log and uses the ISO-timestamp backup naming (L67-68, L76)', async () => {
            const originalPath = join(tempDir, 'cfg.json');
            await writeFile(originalPath, '{}');

            const backupPath = await rollbackManager.createAndTrack(originalPath);

            // L67-68: `${filePath}.backup_${isoTimestamp with :/. replaced by -}`.
            // ISO `2026-07-03T14:08:36.174Z` → `2026-07-03T14-08-36-174Z` (colons AND dot → `-`).
            expect(backupPath).toMatch(/backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
            // L76: `Backup créé et tracké: ${backupPath}`
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Backup créé et tracké:')
            );
            const infoMsg = (mockLogger.info as any).mock.calls
                .find((c: any[]) => typeof c[0] === 'string' && c[0].includes('Backup créé'))?.[0] as string;
            expect(infoMsg).toContain(backupPath);
        });
    });

    // ============================================================
    // restoreAll — idempotence skip (L92) + no-clear invariant
    // ============================================================
    describe('restoreAll — idempotence (L92) + no-clear invariant', () => {
        test('skips already-restored entries on a second restoreAll pass (L92)', async () => {
            const originalPath = join(tempDir, 'cfg.json');
            const backupPath = join(tempDir, 'cfg.json.backup');
            await writeFile(originalPath, JSON.stringify({ v: 1 }));
            await writeFile(backupPath, JSON.stringify({ v: 0 }));

            rollbackManager.track(originalPath, backupPath);

            const first = await rollbackManager.restoreAll(false); // keep backups
            const second = await rollbackManager.restoreAll(false);

            // First pass restores 1 file.
            expect(first.restoredFiles).toHaveLength(1);
            // L92: second pass hits `if (entry.restored) continue` → no double-restore.
            expect(second.restoredFiles).toEqual([]);
            expect(second.success).toBe(true); // 0 failed
            // No-clear invariant: restoreAll does NOT clear the map (only release does, L156).
            expect(rollbackManager.size).toBe(1);
            expect(rollbackManager.hasTrackedBackups).toBe(true);
        });

        test('logs the start count and the per-file restore line (L89, L105)', async () => {
            const originalPath = join(tempDir, 'cfg.json');
            const backupPath = join(tempDir, 'cfg.json.backup');
            await writeFile(originalPath, '{}');
            await writeFile(backupPath, '{"o":true}');

            rollbackManager.track(originalPath, backupPath);
            await rollbackManager.restoreAll(false);

            // L89: `Rollback démarré: ${size} fichiers à restaurer`
            const startLog = (mockLogger.info as any).mock.calls
                .find((c: any[]) => typeof c[0] === 'string' && c[0].includes('Rollback démarré'))?.[0];
            expect(startLog).toContain('1 fichiers à restaurer');
            // L105: `Restauré: ${originalPath} depuis ${backupPath}`
            const restoreLog = (mockLogger.info as any).mock.calls
                .find((c: any[]) => typeof c[0] === 'string' && c[0].includes('Restauré:'))?.[0];
            expect(restoreLog).toContain(originalPath);
            expect(restoreLog).toContain(backupPath);
        });
    });

    // ============================================================
    // restoreAll — MIX partial message (L124-126)
    // ============================================================
    describe('restoreAll — MIX partial outcome message (L124-126)', () => {
        test('returns the partial message when some restore AND some fail (L126)', async () => {
            // Entry 1: restorable (real files).
            const okOriginal = join(tempDir, 'ok.json');
            const okBackup = join(tempDir, 'ok.json.backup');
            await writeFile(okOriginal, '{}');
            await writeFile(okBackup, '{"ok":true}');
            rollbackManager.track(okOriginal, okBackup);

            // Entry 2: backup missing → L96-98 throw → failedFiles.
            rollbackManager.track(join(tempDir, 'bad.json'), join(tempDir, 'missing-backup.json'));

            const result = await rollbackManager.restoreAll(false);

            // MIX arm: 1 restored AND 1 failed simultaneously.
            expect(result.restoredFiles).toHaveLength(1);
            expect(result.failedFiles).toHaveLength(1);
            expect(result.success).toBe(false); // failedFiles.length > 0 (L123)
            // L126: `Rollback partiel: ${restored} restaurés, ${failed} échoués`
            expect(result.message).toBe('Rollback partiel: 1 restaurés, 1 échoués');
        });

        test('returns the success message when all restore (L125)', async () => {
            const o1 = join(tempDir, 'a.json');
            const b1 = join(tempDir, 'a.json.bak');
            const o2 = join(tempDir, 'b.json');
            const b2 = join(tempDir, 'b.json.bak');
            await writeFile(o1, '{}'); await writeFile(b1, '{"a":1}');
            await writeFile(o2, '{}'); await writeFile(b2, '{"b":2}');
            rollbackManager.track(o1, b1);
            rollbackManager.track(o2, b2);

            const result = await rollbackManager.restoreAll(false);

            expect(result.success).toBe(true);
            // L125: `Rollback réussi: ${restored} fichiers restaurés`
            expect(result.message).toBe('Rollback réussi: 2 fichiers restaurés');
        });
    });

    // ============================================================
    // restoreAll — backup-missing error string (L96-98)
    // ============================================================
    describe('restoreAll — backup-missing error string (L96-98)', () => {
        test('records the exact "Backup non trouvé" message in failedFiles (L97)', async () => {
            const missingBackup = join(tempDir, 'ghost.json.backup');
            rollbackManager.track(join(tempDir, 'ghost.json'), missingBackup);

            const result = await rollbackManager.restoreAll();

            expect(result.failedFiles).toHaveLength(1);
            // L97: `Backup non trouvé: ${entry.backupPath}` → propagated as err.message (L119).
            expect(result.failedFiles[0].error).toBe(`Backup non trouvé: ${missingBackup}`);
            // L118: the outer error log is emitted too.
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Échec restauration')
            );
        });
    });

    // ============================================================
    // restoreAll — cleanup unlink failure warn (L108-115)
    // ============================================================
    describe('restoreAll — cleanup unlink failure (L108-115)', () => {
        test('warns but still reports success when post-restore cleanup unlink fails (L110-114)', async () => {
            const originalPath = join(tempDir, 'cfg.json');
            const backupPath = join(tempDir, 'cfg.json.backup');
            await writeFile(originalPath, '{"v":1}');
            await writeFile(backupPath, '{"v":0}');

            rollbackManager.track(originalPath, backupPath);
            forceUnlinkFailure = true; // unlink throws on cleanup (L110)

            const result = await rollbackManager.restoreAll(true); // cleanupBackups=true

            // The restore itself succeeded (copyFile L101 ran before the cleanup unlink).
            expect(result.success).toBe(true);
            expect(result.restoredFiles).toContain(originalPath);
            // The file was actually restored despite the cleanup failure.
            expect(JSON.parse(await readFile(originalPath, 'utf-8'))).toEqual({ v: 0 });
            // L113: warn emitted with the backup path + the unlink error.
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Impossible de supprimer le backup')
            );
            const warnMsg = (mockLogger.warn as any).mock.calls
                .find((c: any[]) => typeof c[0] === 'string' && c[0].includes('Impossible de supprimer'))?.[0] as string;
            expect(warnMsg).toContain(backupPath);
            expect(warnMsg).toContain('EUNLINK mock');
        });
    });

    // ============================================================
    // release — existsSync guard false (L146)
    // ============================================================
    describe('release — existsSync guard false (L146)', () => {
        test('skips unlink for a tracked backup that no longer exists on disk (L146)', async () => {
            // Track a backup path that was never written → existsSync=false at L146.
            rollbackManager.track(join(tempDir, 'orig.json'), join(tempDir, 'never-created.backup'));

            await rollbackManager.release(true); // cleanupBackups=true, but file absent

            // The map is cleared regardless (L156).
            expect(rollbackManager.size).toBe(0);
            expect(rollbackManager.hasTrackedBackups).toBe(false);
            // No warn emitted: the existsSync guard (L146) skipped the unlink try entirely,
            // so the catch (L150-152) was never reached.
            expect(mockLogger.warn).not.toHaveBeenCalled();
            // L157: cleared log.
            expect(mockLogger.debug).toHaveBeenCalledWith('RollbackManager libéré');
        });
    });

    // ============================================================
    // release — cleanup unlink failure warn (L150-152)
    // ============================================================
    describe('release — cleanup unlink failure (L150-152)', () => {
        test('warns on unlink failure but still clears the map (L150-156)', async () => {
            const backupPath = join(tempDir, 'real.backup');
            await writeFile(backupPath, '{"x":1}');
            rollbackManager.track(join(tempDir, 'orig.json'), backupPath);

            forceUnlinkFailure = true;
            await rollbackManager.release(true);

            // L151: warn with path + error.
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Impossible de supprimer')
            );
            const warnMsg = (mockLogger.warn as any).mock.calls
                .find((c: any[]) => typeof c[0] === 'string' && c[0].includes('Impossible de supprimer'))?.[0] as string;
            expect(warnMsg).toContain(backupPath);
            // L156: map cleared even though unlink failed.
            expect(rollbackManager.size).toBe(0);
        });
    });

    // ============================================================
    // listTracked — entry shape incl. timestamp (L177-179)
    // ============================================================
    describe('listTracked — entry shape (L177-179)', () => {
        test('returns entries with originalPath/backupPath/timestamp Date (L177-179)', () => {
            rollbackManager.track('/o.json', '/b.json');

            const entries = rollbackManager.listTracked();

            expect(entries).toHaveLength(1);
            expect(entries[0].originalPath).toBe('/o.json');
            expect(entries[0].backupPath).toBe('/b.json');
            expect(entries[0].timestamp).toBeInstanceOf(Date);
        });
    });
});
