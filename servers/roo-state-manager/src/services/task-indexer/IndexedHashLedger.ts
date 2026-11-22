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
 * records, on disk, the contentHashes this seat has successfully written to
 * Qdrant per task_id; B2 subtracts them before scrolling.
 *
 * Storage: ndjson, one contentHash per line, one file per task_id under
 * `INDEX_HASH_LEDGER_DIR` (default `~/.roo-state-manager/index-hash-ledgers`).
 * Append-only, deduplicated on read. Single logical writer per seat (the
 * leader drain); concurrent appends are harmless (lines are atomic at this
 * size, the loader builds a Set).
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

/**
 * Load the set of contentHashes recorded as indexed for `taskId`.
 * Any read problem (missing file included) yields an EMPTY set — never throws.
 */
export async function loadIndexedHashes(taskId: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
        const raw = await fs.readFile(ledgerFilePath(taskId), 'utf8');
        for (const line of raw.split('\n')) {
            const h = line.trim();
            if (h) out.add(h);
        }
    } catch (err: any) {
        if (err?.code !== 'ENOENT') {
            // Unreadable ledger: fall back to legacy full-scan behaviour, but
            // say it in the file log (#4352 lesson: console.* is invisible on
            // Claude-session hosts).
            getDefaultLogger().warn(`[#4861] ledger unreadable for task ${taskId}: ${err?.message || err} — falling back to full scroll`);
        }
    }
    return out;
}

/**
 * Append `hashes` to the ledger of `taskId`. Never throws: a failed append
 * only means the next pass re-scrolls those hashes (correct, just slower).
 */
export async function appendIndexedHashes(taskId: string, hashes: string[]): Promise<void> {
    const unique = [...new Set(hashes.filter(Boolean))];
    if (unique.length === 0) return;
    try {
        await fs.mkdir(ledgerRootDir(), { recursive: true });
        await fs.appendFile(ledgerFilePath(taskId), unique.map((h) => `${h}\n`).join(''), 'utf8');
    } catch (err: any) {
        getDefaultLogger().warn(`[#4861] ledger append failed for task ${taskId} (${unique.length} hashes): ${err?.message || err} — next pass will re-scroll them`);
    }
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
