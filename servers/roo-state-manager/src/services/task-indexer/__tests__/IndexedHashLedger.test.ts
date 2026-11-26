/**
 * #4861 — per-task contentHash ledger (IndexedHashLedger), unit level.
 *
 * v1.2 file format, append-only, one file per task_id:
 *   `<64-hex>`          present — confirmed in Qdrant for this task_id
 *   `absent <64-hex>`   a previous B2 pass scanned it and it was NOT present
 *
 * Pins:
 *   1. a pre-v1.2 file (bare hashes only) loads as all-present — no migration;
 *   2. present wins over a stale `absent` line (the hash was upserted since);
 *   3. `appendAbsentHashes` writes one line per distinct hash of the call; the
 *      write-once bound is the CALLER's (pinned by the B2 integration suite,
 *      `VectorIndexer.b2-incremental.test.ts`);
 *   4. a test run never points the ledger at the seat's REAL directory: a test
 *      reaching `clearIndexedHashLedgers()` (resetCollection /
 *      cleanupOldVectors) would otherwise delete the seat's production ledgers
 *      — measured on po-2028, 22/11: 40+ `ledgers cleared` lines in the test
 *      log of one full local run, from suites that set no
 *      INDEX_HASH_LEDGER_DIR.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

import {
	ledgerRootDir,
	ledgerFileName,
	loadIndexedHashLedger,
	appendIndexedHashes,
	appendAbsentHashes,
} from '../IndexedHashLedger.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const TASK = 't-4861-ledger-unit';

let tmpDir: string;

// Set by tests/setup-env.ts before this file loads: the per-worker default that
// the isolation test (last block) asserts on — restore it, never delete it.
const workerLedgerDir = process.env.INDEX_HASH_LEDGER_DIR;

describe('IndexedHashLedger — #4861 v1.2 (present + absent sets)', () => {
	beforeEach(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rsm-ledger-unit-4861-'));
		process.env.INDEX_HASH_LEDGER_DIR = tmpDir;
	});
	afterEach(async () => {
		if (workerLedgerDir) process.env.INDEX_HASH_LEDGER_DIR = workerLedgerDir;
		else delete process.env.INDEX_HASH_LEDGER_DIR;
		await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	});

	test('a pre-v1.2 file (bare hashes only) loads as all-present — no migration needed', async () => {
		await fsp.writeFile(path.join(tmpDir, ledgerFileName(TASK)), `${A}\n${B}\n`, 'utf8');
		const ledger = await loadIndexedHashLedger(TASK);
		expect([...ledger.present].sort()).toEqual([A, B]);
		expect(ledger.absent.size).toBe(0);
	});

	test('present wins over a stale absent line (the hash was upserted after being found absent)', async () => {
		await appendAbsentHashes(TASK, [A, B]);
		await appendIndexedHashes(TASK, [A, C]);
		const ledger = await loadIndexedHashLedger(TASK);
		expect([...ledger.present].sort()).toEqual([A, C]);
		// B is still to embed; A's absent line is stale and ignored.
		expect([...ledger.absent]).toEqual([B]);
	});

	test('appendAbsentHashes writes one `absent <hash>` line per distinct hash of the call — the write-once bound is the caller\'s', async () => {
		// A dumb appender on purpose: the B2 pass already holds the previous
		// absent set in memory and passes only the new ones (pinned by the B2
		// integration suite). Deduplicating here would cost a file read per append.
		await appendAbsentHashes(TASK, [A, B, B]);
		await appendAbsentHashes(TASK, [C]);
		const lines = (await fsp.readFile(path.join(tmpDir, ledgerFileName(TASK)), 'utf8')).split('\n').filter(Boolean);
		expect(lines).toEqual([`absent ${A}`, `absent ${B}`, `absent ${C}`]);
		const ledger = await loadIndexedHashLedger(TASK);
		expect(ledger.present.size).toBe(0);
		expect([...ledger.absent].sort()).toEqual([A, B, C]);
	});

	test('a missing ledger is an empty ledger — never throws', async () => {
		const ledger = await loadIndexedHashLedger('never-indexed-task');
		expect(ledger.present.size).toBe(0);
		expect(ledger.absent.size).toBe(0);
	});
});

describe('IndexedHashLedger — test isolation', () => {
	// The guard lives in tests/setup-env.ts, which runs BEFORE this file (and
	// every other one): the suites that reach `clearIndexedHashLedgers()` without
	// setting a dir inherit it.
	test("under vitest the ledger root is a per-worker temp dir — never the seat's real directory", () => {
		const realSeatDir = path.join(os.homedir(), '.roo-state-manager', 'index-hash-ledgers');
		expect(process.env.INDEX_HASH_LEDGER_DIR).toBeTruthy();
		expect(ledgerRootDir()).not.toBe(realSeatDir);
		expect(ledgerRootDir().startsWith(os.tmpdir())).toBe(true);
	});
});
