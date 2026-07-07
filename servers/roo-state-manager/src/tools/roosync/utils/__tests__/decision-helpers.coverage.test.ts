/**
 * #833 Sprint C3 — decision-helpers.ts coverage complement (po-2026 lane `src/tools/roosync/utils`).
 *
 * The sibling `decision-helpers.test.ts` (514 LOC) covers validateDecisionStatus fully,
 * generateNextSteps (all 5 arms), formatDecisionResult, updateRoadmapStatus (dense, incl.
 * the po-2024 metadata-contract block), createBackup main paths, restoreBackup error paths,
 * and the throw/null guards of updateRoadmapStatusAsync/loadDecisionDetails. It leaves a
 * focused set of branches cold — pinned here against source lines of `decision-helpers.ts`.
 *
 * COLD BRANCHES (source-grounded):
 * - `createBackup` catch (L458-461): the error path. Base tests only exercise the happy
 *   copyFileSync loop; the `throw new Error('Échec de la création du the backup: …')` arm is
 *   never reached. Reached here by forcing mkdirSync to fail (backupPath under an existing
 *   FILE → ENOTDIR on the recursive mkdir).
 * - `restoreBackup` success return (L496): the `return restoredFiles` after the copy loop.
 *   Base restoreBackup tests only cover the "backupDir introuvable" throw + a try/wrapped
 *   case that never asserts the concrete return; the live restore-and-return arm is cold.
 * - `moveDecisionFile` (L512-561): NOT imported by the base suite at all. All 4 status→timestamp
 *   branches (approved L535-537, rejected L538-540, applied L541-543, rolled_back L544-547),
 *   the pending no-timestamp path (L534 `now` computed but no branch taken), the
 *   `!existsSync(fromPath)` early-return-false (L522-523), and the catch→console.error+false
 *   (L556-559, reached via malformed JSON in the source file).
 *
 * All targets are LIVE exported functions, exercised by `decision.ts` approve/reject/apply/
 * rollback workflow (moveDecisionFile L228/239/305/344, createBackup L269, restoreBackup L316).
 * Pure fs fixtures (tmpdir), matching the base suite's real-fs pattern — 0 mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createBackup, restoreBackup, moveDecisionFile, updateRoadmapStatus } from '../decision-helpers.js';
import type { RooSyncConfig } from '../../../../config/roosync-config.js';

const tmpRoot = join(process.cwd(), 'test-decision-helpers-cov-temp');

beforeEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe('decision-helpers — coverage complement (#833 C3, source-grounded)', () => {

  // ============================================================
  // createBackup — error catch arm (L458-461)
  // ============================================================
  describe('createBackup — error catch (L458-461)', () => {
    it('wraps an fs failure in "Échec de la création du backup: …" (L460)', () => {
      // Source L437-439: requires() fs then mkdirSync(backupDir, {recursive:true}). Make
      // backupPath a FILE (not a dir) → join(file, 'backup-…') is under a non-dir → mkdirSync
      // throws ENOTDIR → catch L458 → throw L460 with the French prefix + the native message.
      const blocker = join(tmpRoot, 'blocker-file');
      writeFileSync(blocker, 'i am a file, not a dir', 'utf-8');

      expect(() => createBackup([blocker], blocker)).toThrow(/Échec de la création du backup/);
    });
  });

  // ============================================================
  // restoreBackup — success return arm (L483-496)
  // ============================================================
  describe('restoreBackup — success restore-and-return (L496)', () => {
    it('returns the list of restored paths after copying backups out of the dir (L482-496)', () => {
      // Source L478-494: backupDir exists → readdirSync → for each backupFile, reconstruct
      // originalPath = backupFile.replace(/_/g, '/') (L487), copyFileSync back (L491),
      // push originalPath (L492) → return restoredFiles (L496).
      const backupDir = join(tmpRoot, 'backup-restore-ok');
      mkdirSync(backupDir, { recursive: true });

      // File name chosen so that replace(/_/g,'/') yields a path that copyFileSync can write.
      // Using a single-segment name (no underscores) → originalPath === backupFile. The
      // reconstructed path is RELATIVE, so chdir into tmpRoot first to keep the restored file
      // inside the cleaned sandbox (avoid polluting the process CWD).
      const backupFileName = 'restoretarget.txt';
      const backupFilePath = join(backupDir, backupFileName);
      writeFileSync(backupFilePath, 'restored content', 'utf-8');
      const cwd = process.cwd();
      process.chdir(tmpRoot);
      try {
        const backupInfo = { timestamp: 't', files: [backupFileName], backupDir };
        const result = restoreBackup(backupInfo, tmpRoot);

        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
        // L487: originalPath = 'restoretarget.txt'.replace(/_/g,'/') === 'restoretarget.txt'.
        expect(result[0]).toBe(backupFileName);
        // The restored file landed in tmpRoot (cwd) and is readable (copyFileSync L491 live).
        expect(readFileSync(join(tmpRoot, result[0]), 'utf-8')).toBe('restored content');
      } finally {
        process.chdir(cwd);
      }
    });
  });

  // ============================================================
  // updateRoadmapStatus — "block not found" throw arm (L58-60)
  // ============================================================
  describe('updateRoadmapStatus — block-not-found throw (L58-60)', () => {
    it('throws (caught → false) when the roadmap file exists but the decision block is absent (L58-60)', () => {
      // The sibling test (decision-helpers.test.ts L333-347) reaches the false return via a
      // non-existent sharedPath (readFileSync throws first). That leaves L58-60 — the explicit
      // "Bloc de décision introuvable" throw when the regex finds no match — cold. Here the
      // roadmap file EXISTS (readFileSync succeeds at L49) but holds a different decision ID, so
      // blockRegex.exec returns null (L57) → throw L59 → outer catch → return false.
      const roadmap = [
        '# Sync Roadmap',
        '',
        '<!-- DECISION_BLOCK_START -->',
        '## Decision DEC-OTHER',
        `**ID:** \`DEC-OTHER\``,
        '**Statut:** pending',
        '<!-- DECISION_BLOCK_END -->',
        ''
      ].join('\n');
      writeFileSync(join(tmpRoot, 'sync-roadmap.md'), roadmap, 'utf-8');
      const config = { sharedPath: tmpRoot, machineId: 'myia-po-2026' } as RooSyncConfig;

      const result = updateRoadmapStatus(config, 'DEC-001', 'approved', { comment: 'x' });
      expect(result).toBe(false);
      // The roadmap is untouched (no write happened — L58 threw before any mutation).
      expect(readFileSync(join(tmpRoot, 'sync-roadmap.md'), 'utf-8')).toBe(roadmap);
    });
  });

  // ============================================================
  // moveDecisionFile — all status branches + guards (L512-561)
  // ============================================================
  describe('moveDecisionFile — status timestamp branches + guards (L512-561)', () => {
    /** Build <sharedPath>/decisions/<status>/<id>.json with a base decision payload. */
    function seedDecision(sharedPath: string, status: string, id = 'DEC-001', extra: Record<string, unknown> = {}) {
      const dir = join(sharedPath, 'decisions', status);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${id}.json`);
      writeFileSync(filePath, JSON.stringify({ id, status, ...extra }, null, 2), 'utf-8');
      return filePath;
    }

    /** Read back the moved decision at the destination status dir. */
    function readMoved(sharedPath: string, status: string, id = 'DEC-001') {
      return JSON.parse(readFileSync(join(sharedPath, 'decisions', status, `${id}.json`), 'utf-8'));
    }

    const MACHINE_ID = 'myia-po-2026';
    beforeEach(() => {
      // Source L537/540/543/546: `process.env.ROOSYNC_MACHINE_ID || 'unknown'`.
      process.env.ROOSYNC_MACHINE_ID = MACHINE_ID;
    });
    afterEach(() => {
      delete process.env.ROOSYNC_MACHINE_ID;
    });

    it('returns false when the source decision file does not exist (L522-523)', () => {
      // Source L519 fromPath = shared/decisions/pending/DEC-X.json; existsSync false → return false.
      // Pre-create the pending dir (empty) so only the file-missing branch is exercised.
      mkdirSync(join(tmpRoot, 'decisions', 'pending'), { recursive: true });
      const ok = moveDecisionFile(tmpRoot, 'DEC-MISSING', 'pending', 'approved');
      expect(ok).toBe(false);
    });

    it('approved transition: writes approvedAt/approvedBy, removes source, returns true (L535-537, L550-555)', () => {
      seedDecision(tmpRoot, 'pending');
      // Destination dir must pre-exist (writeFileSync does not mkdir — real behavior).
      mkdirSync(join(tmpRoot, 'decisions', 'approved'), { recursive: true });

      const ok = moveDecisionFile(tmpRoot, 'DEC-001', 'pending', 'approved');
      expect(ok).toBe(true);

      const moved = readMoved(tmpRoot, 'approved');
      expect(moved.status).toBe('approved');          // L531
      expect(moved.approvedAt).toBeDefined();           // L536
      expect(moved.approvedBy).toBe(MACHINE_ID);        // L537
      // L553: source file removed after the write.
      expect(existsSync(join(tmpRoot, 'decisions', 'pending', 'DEC-001.json'))).toBe(false);
    });

    it('rejected transition: writes rejectedAt/rejectedBy (L538-540)', () => {
      seedDecision(tmpRoot, 'pending');
      mkdirSync(join(tmpRoot, 'decisions', 'rejected'), { recursive: true });

      expect(moveDecisionFile(tmpRoot, 'DEC-001', 'pending', 'rejected')).toBe(true);

      const moved = readMoved(tmpRoot, 'rejected');
      expect(moved.status).toBe('rejected');
      expect(moved.rejectedAt).toBeDefined();           // L539
      expect(moved.rejectedBy).toBe(MACHINE_ID);        // L540
    });

    it('applied transition: writes appliedAt/appliedBy (L541-543)', () => {
      // Real workflow path: approved → applied (decision.ts L305).
      seedDecision(tmpRoot, 'approved');
      mkdirSync(join(tmpRoot, 'decisions', 'applied'), { recursive: true });

      expect(moveDecisionFile(tmpRoot, 'DEC-001', 'approved', 'applied')).toBe(true);

      const moved = readMoved(tmpRoot, 'applied');
      expect(moved.status).toBe('applied');
      expect(moved.appliedAt).toBeDefined();             // L542
      expect(moved.appliedBy).toBe(MACHINE_ID);          // L543
    });

    it('rolled_back transition: writes rolledBackAt/rolledBackBy (L544-547)', () => {
      // Real workflow path: applied → rolled_back (decision.ts L344).
      seedDecision(tmpRoot, 'applied');
      mkdirSync(join(tmpRoot, 'decisions', 'rolled_back'), { recursive: true });

      expect(moveDecisionFile(tmpRoot, 'DEC-001', 'applied', 'rolled_back')).toBe(true);

      const moved = readMoved(tmpRoot, 'rolled_back');
      expect(moved.status).toBe('rolled_back');
      expect(moved.rolledBackAt).toBeDefined();          // L545
      expect(moved.rolledBackBy).toBe(MACHINE_ID);       // L546
    });

    it('pending transition: sets status but adds NO timestamp field (L531-534 none-of-the-branches)', () => {
      // Source L535-547: only approved/rejected/applied/rolled_back get a timestamp. A
      // pending destination takes none of those branches (the `now` at L534 is computed but
      // unused). Pins that no *At/*By field is added.
      seedDecision(tmpRoot, 'rejected');
      mkdirSync(join(tmpRoot, 'decisions', 'pending'), { recursive: true });

      expect(moveDecisionFile(tmpRoot, 'DEC-001', 'rejected', 'pending')).toBe(true);

      const moved = readMoved(tmpRoot, 'pending');
      expect(moved.status).toBe('pending');
      expect(moved.approvedAt).toBeUndefined();
      expect(moved.rejectedAt).toBeUndefined();
      expect(moved.appliedAt).toBeUndefined();
      expect(moved.rolledBackAt).toBeUndefined();
    });

    it('catch arm: malformed JSON in source file → console.error + return false (L556-559)', () => {
      // Source L527-528: readFileSync + JSON.parse. Invalid JSON throws → catch L556 →
      // console.error L558 + return false L559. The file is left in place (no unlink).
      const dir = join(tmpRoot, 'decisions', 'pending');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'DEC-BAD.json'), '{ not valid json', 'utf-8');

      const ok = moveDecisionFile(tmpRoot, 'DEC-BAD', 'pending', 'approved');
      expect(ok).toBe(false);
      // Source file NOT removed (unlinkSync L553 is after the parse, never reached).
      expect(existsSync(join(dir, 'DEC-BAD.json'))).toBe(true);
    });
  });
});
