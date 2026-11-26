import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { getDefaultLogger } from '../../utils/logger.js';

/**
 * #4861 — local ledger of already-indexed contentHashes, per task_id.
 *
 * Why: on collections >5M points the chunk_id preflight is skipped (#2209) and
 * the contentHash preflight (B2) inherits every sub-chunk of the session at
 * every pass — measured 443,851 sub-chunks / pass on CoursIA-2 (`2279c906`),
 * 89-minute passes, ~42k scrolls. A session already indexed except its tail
 * must cost Qdrant reads proportional to the NEW chunks only. This ledger
 * records, on disk, the contentHashes confirmed present in Qdrant for a
 * task_id — written by this seat after a successful upsert, or found already
 * present by the B2 scroll (v1.1: without the second source, every session
 * indexed before the ledger existed re-scrolled in full at each pass). B2
 * subtracts them before scrolling.
 *
 * Storage: ndjson, one file per task_id under `INDEX_HASH_LEDGER_DIR` (default
 * `~/.roo-state-manager/index-hash-ledgers`). Two line kinds:
 *   `<contentHash>`         PRESENT — confirmed in Qdrant for this task_id
 *   `absent <contentHash>`  a B2 pass scrolled it and it was NOT present (v1.2)
 * Append-only, deduplicated on read; a hash carrying both lines is PRESENT.
 * Single logical writer per seat (the leader drain); concurrent appends are
 * harmless (lines are atomic at this size, the loader builds a Set).
 *
 * v1.2 — why the absent set exists. The B2 done line measures convergence per
 * pass: `rescanned` counts the hashes a PREVIOUS pass already found absent,
 * `newScan` the ones scanned for the first time. Without it, a pass that aborts
 * after answered batches (fail-closed scroll failure, watchdog) restarts at
 * batch 0 and nothing in the log tells a first scan from a re-scan. A hash is
 * appended as absent ONCE (the caller passes `absentNow − absentPrev`), so the
 * file holds at most one present + one absent line per distinct contentHash.
 * An absent line is a MEASUREMENT of a past pass, never a skip decision: B2
 * still scrolls every non-present hash. (Skipping known-absent hashes is a
 * separate change — it needs a staleness story for points another seat
 * upserts, or a reindex.)
 *
 * Failure semantics — the ledger is an OPTIMISATION, never a source of truth:
 * - read failure  -> empty set (legacy full-scan behaviour) + warn in file log
 * - write failure -> skipped append (next pass re-scrolls those hashes) + warn
 *
 * Invalidation: `resetCollection` and any `cleanupOldVectors` pass that deleted
 * points clear the whole directory — the recorded hashes no longer exist in
 * Qdrant. Known limit (documented on #4861): the ledger is per-seat; a reset
 * performed by another seat of the same workspace does not clear this seat's
 * ledger, so a subsequent B2 pass here may skip hashes that are gone. Reset is
 * a rare explicit operation and a `reindex:true` rebuild is the documented
 * follow-up, so v1 accepts this window.
 */

/** Resolve the ledger root (env override first — tests rely on it). */
export function ledgerRootDir(): string {
    return process.env.INDEX_HASH_LEDGER_DIR || path.join(os.homedir(), '.roo-state-manager', 'index-hash-ledgers');
}

/**
 * Filesystem-safe, collision-free name for a task_id. Task ids can carry `#`,
 * `/`, `:` and exceed 255 chars — encode, cap, and disambiguate with a short
 * digest of the RAW id so two long ids sharing a 120-char prefix stay distinct.
 */
export function ledgerFileName(taskId: string): string {
    const encoded = encodeURIComponent(taskId).replace(/[%.]/g, '_');
    const capped = encoded.slice(0, 120);
    const digest = crypto.createHash('sha1').update(taskId).digest('hex').slice(0, 12);
    return `${capped}-${digest}.hashes`;
}

function ledgerFilePath(taskId: string): string {
    return path.join(ledgerRootDir(), ledgerFileName(taskId));
}

/** Line prefix of a hash a past B2 pass found ABSENT (v1.2). */
const ABSENT_PREFIX = 'absent ';

/** What the ledger of one task_id knows about contentHashes (v1.2). */
export interface IndexedHashLedger {
    /** Confirmed PRESENT in Qdrant for this task_id. */
    present: Set<string>;
    /** A previous B2 pass scrolled this hash and it was NOT present. */
    absent: Set<string>;
}

/**
 * Load the present and absent contentHash sets recorded for `taskId`.
 * A pre-v1.2 file (bare hashes only) loads as all-present. A hash carrying
 * both lines is present — its absent line is stale. Any read problem (missing
 * file included) yields EMPTY sets — never throws.
 */
export async function loadIndexedHashLedger(taskId: string): Promise<IndexedHashLedger> {
    const present = new Set<string>();
    const absent = new Set<string>();
    try {
        const lines = (await fs.readFile(ledgerFilePath(taskId), 'utf8')).split('\n');
        // Two passes so a fully-indexed session never materialises both sets at
        // once (the leader's 443k-sub-chunk sessions): present first, then only
        // the absent lines that are still absent.
        for (const line of lines) {
            const h = line.trim();
            if (h && !h.startsWith(ABSENT_PREFIX)) present.add(h);
        }
        for (const line of lines) {
            const h = line.trim();
            if (h.startsWith(ABSENT_PREFIX)) {
                const a = h.slice(ABSENT_PREFIX.length).trim();
                if (a && !present.has(a)) absent.add(a);
            }
        }
    } catch (err: any) {
        if (err?.code !== 'ENOENT') {
            // Unreadable ledger: fall back to legacy full-scan behaviour, but
            // say it in the file log (#4352 lesson: console.* is invisible on
            // Claude-session hosts).
            getDefaultLogger().warn(`[#4861] ledger unreadable for task ${taskId}: ${err?.message || err} — falling back to full scroll`);
        }
    }
    return { present, absent };
}

/** Append one line per entry — never throws (see `appendIndexedHashes`). */
async function appendLedgerLines(taskId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    try {
        await fs.mkdir(ledgerRootDir(), { recursive: true });
        await fs.appendFile(ledgerFilePath(taskId), lines.map((l) => `${l}\n`).join(''), 'utf8');
    } catch (err: any) {
        getDefaultLogger().warn(`[#4861] ledger append failed for task ${taskId} (${lines.length} hashes): ${err?.message || err} — next pass will re-scroll them`);
    }
}

/**
 * Append `hashes` to the ledger of `taskId` as PRESENT. Never throws: a failed
 * append only means the next pass re-scrolls those hashes (correct, just slower).
 */
export async function appendIndexedHashes(taskId: string, hashes: string[]): Promise<void> {
    await appendLedgerLines(taskId, [...new Set(hashes.filter(Boolean))]);
}

/**
 * v1.2: record `hashes` as ABSENT for `taskId` — a B2 pass scrolled them and
 * they were not in Qdrant. The caller passes only the ones the ledger does not
 * list as absent yet, so each hash is written at most once. Same never-throws
 * contract: a failed append only under-counts `rescanned` on the next pass.
 */
export async function appendAbsentHashes(taskId: string, hashes: string[]): Promise<void> {
    await appendLedgerLines(taskId, [...new Set(hashes.filter(Boolean))].map((h) => `${ABSENT_PREFIX}${h}`));
}

/**
 * Drop every ledger file (resetCollection / cleanupOldVectors deleted points:
 * the recorded hashes no longer exist). Never throws.
 */
export async function clearIndexedHashLedgers(): Promise<void> {
    try {
        await fs.rm(ledgerRootDir(), { recursive: true, force: true });
        getDefaultLogger().info('[#4861] index-hash ledgers cleared (points removed from collection)');
    } catch (err: any) {
        getDefaultLogger().warn(`[#4861] ledger clear failed: ${err?.message || err} — stale ledgers may over-skip B2 until rewritten`);
    }
}
