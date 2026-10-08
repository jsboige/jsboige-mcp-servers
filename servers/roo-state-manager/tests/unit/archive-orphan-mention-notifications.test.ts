/**
 * Drift-guard + functional tests for scripts/archive-orphan-mention-notifications.mjs
 * (#2591 / #4131 grain G-M).
 *
 * The sweep script duplicates the recipient classification that ships in
 * src/utils/dashboard-helpers.ts (isFleetRecipient). Duplication without a
 * guard is how a sweep silently diverges from the guard it complements — and
 * this particular classifier has a documented failure mode (lane addresses
 * `machine:workspace` miscounted as orphans, 3814 legitimate messages in the
 * 08/10 dry-run) that must never come back. The drift-guard tests assert the
 * two implementations agree on a fixed corpus, extras included.
 *
 * Review ms#1413 added four fail-closed requirements, each with its own
 * coverage below: (1) NanoClaw's out-of-shape targets — including LANE-shaped
 * ones — are kept, not orphaned; (2) source and destination are confined, the
 * inbox AND the archive are frozen in the manifest, links are refused and the
 * archive is the sibling of the inbox (the doubled `messages/messages` fix);
 * (3) the `[MENTION]` scope is revalidated at apply time from disk, and a
 * widened manifest is refused unless the live run opted in; (4) the CLI exit
 * code is propagated, tested in a subprocess without a real store.
 *
 * @module tests/unit/archive-orphan-mention-notifications
 * @issue #2591
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';

vi.mock('../../src/utils/message-helpers.js', () => ({
	getLocalMachineId: () => 'myia-po-2027'
}));
vi.mock('../../src/utils/logger.js', () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));
vi.mock('../../src/utils/server-helpers.js', () => ({
	getSharedStatePath: () => '/shared-state'
}));
vi.mock('../../src/services/MessageManager.js', () => ({
	getMessageManager: () => ({ sendMessage: vi.fn() })
}));
vi.mock('../../src/config/roosync-config.js', () => ({
	tryLoadRooSyncConfig: () => null
}));

import {
	classifyRecipient,
	loadExtraRecipients,
	isOrphanRecipient,
	runDryRun,
	applyManifest,
	archiveSiblingOf
} from '../../scripts/archive-orphan-mention-notifications.mjs';
import {
	isFleetRecipient,
	loadExtraMentionRecipients
} from '../../src/utils/dashboard-helpers.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/archive-orphan-mention-notifications.mjs', import.meta.url));

/** Corpus spanning every classification the fleet can produce. */
const CORPUS = [
	// bare fleet machines (8/8 measured in .shared-state/configs)
	'myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025',
	'myia-po-2026', 'myia-po-2027', 'myia-web1', 'myia-web2',
	// lane addresses — the documented trap (must be KEPT)
	'myia-po-2026:workspace-cluster-coordination', 'myia-ai-01:CoursIA-2',
	// explicit out-of-shape live consumers (review ms#1408 + ms#1413) — must be KEPT.
	// The last four are the ms#1413 additions: lane-shaped targets the poller reads.
	'nanoclaw-cluster', 'nanoclaw-cluster:nanoclaw', 'nanoclaw:agent', 'nanoclaw:nanoclaw',
	'cluster-manager:nanoclaw-cluster',
	// orphan population measured on #2591 (must be SWEPT)
	'head', 'main', 'v4', 'gmail', '11', '09', '120', 'anthropic', 'vscode',
	'NanoClaw', 'Hermes', 'hermes-pr-review', 'mention', '7ecbb49f',
	'b749e9fa557c', 'po-2023', 'po-2026', 'ai-01', 'Myia-Po-2027',
	'5', ''
];

describe('drift-guard — script classifier vs production guard (#2591)', () => {
	beforeEach(() => { delete process.env.ROO_MENTION_EXTRA_RECIPIENTS; });
	afterEach(() => { delete process.env.ROO_MENTION_EXTRA_RECIPIENTS; });

	it('never sweeps what the production guard keeps (subset invariant, extras aligned)', () => {
		expect([...loadExtraRecipients()]).toEqual([...loadExtraMentionRecipients()]);
		const extras = loadExtraMentionRecipients();
		// The two classifiers serve different populations: the production guard
		// sees v1 prose mentions only (parseMentions cannot emit ':' — bare
		// tokens), while the sweep walks the whole store, which also carries
		// `machine:workspace` lane addresses from direct/v3 sends. So the
		// script classifier is a SUPERSET by design: it adds the 'lane' class.
		// The invariant that must never break is one-directional — anything the
		// production guard keeps, the sweep keeps too.
		for (const r of CORPUS) {
			const productionKeeps = isFleetRecipient(r, null, extras);
			if (productionKeeps) {
				expect(isOrphanRecipient(r), `corpus '${r}'`).toBe(false);
			}
		}
		// And on the bare-token population (everything production can see),
		// agreement is total: production drops <=> script sweeps.
		for (const r of CORPUS.filter(x => !x.includes(':'))) {
			expect(isOrphanRecipient(r), `corpus '${r}'`).toBe(!isFleetRecipient(r, null, extras));
		}
	});

	it('agrees when ROO_MENTION_EXTRA_RECIPIENTS extends the extras (both sides)', () => {
		process.env.ROO_MENTION_EXTRA_RECIPIENTS = 'custom-bot';
		expect([...loadExtraRecipients()]).toEqual([...loadExtraMentionRecipients()]);
		expect(isOrphanRecipient('custom-bot')).toBe(false);
		expect(isOrphanRecipient('other-bot')).toBe(true);
		// The extension inherits the lane rule, on BOTH sides.
		expect(isOrphanRecipient('custom-bot:workspace')).toBe(false);
		expect(isFleetRecipient('custom-bot:workspace', null, loadExtraMentionRecipients())).toBe(true);
	});

	it('classifies the lane-address trap as KEPT, not orphan', () => {
		expect(classifyRecipient('myia-po-2026:workspace-cluster-coordination')).toBe('lane');
	});
});

describe('NanoClaw targets — the ms#1413 regression', () => {
	beforeEach(() => { delete process.env.ROO_MENTION_EXTRA_RECIPIENTS; });
	afterEach(() => { delete process.env.ROO_MENTION_EXTRA_RECIPIENTS; });

	/**
	 * The first version matched extras by FULL ADDRESS only, so a lane-shaped
	 * target fell through to `orphan` and would have been archived. Every one of
	 * these is a live consumer of the poller.
	 */
	it('keeps the bare id AND every two-points target the poller reads', () => {
		for (const t of ['nanoclaw-cluster', 'nanoclaw-cluster:nanoclaw', 'nanoclaw:agent', 'nanoclaw:nanoclaw']) {
			expect(isOrphanRecipient(t), `${t} must be KEPT`).toBe(false);
			expect(classifyRecipient(t), `${t} class`).toBe('extra');
			expect(isFleetRecipient(t, null, loadExtraMentionRecipients()), `${t} production`).toBe(true);
		}
		// Conservative exclusion: not a measured consumer, kept anyway — the two
		// errors are not symmetric (a kept dead notification costs an inode, an
		// archived live one loses a message silently).
		expect(isOrphanRecipient('cluster-manager:nanoclaw-cluster')).toBe(false);
	});

	it('does not widen the orphan class by accident (case, prefix, bare-head near-misses)', () => {
		// A bare `nanoclaw` entry would blacken the whole NaNoclaw orphan class;
		// it is deliberately absent, so all of these stay orphan.
		for (const t of ['NanoClaw', 'nanoclaw', 'NANOCLAW', 'nanoclaw-cluster-2', 'nanoclaw-clusterx', 'nanoclaw-cluster-x:y']) {
			expect(isOrphanRecipient(t), `${t} must stay ORPHAN`).toBe(true);
		}
		// A two-points entry stays exact: it does not blanch its own head.
		expect(isOrphanRecipient('nanoclaw:other')).toBe(true);
	});

	it('matches the extras case-insensitively (case never decides survival)', () => {
		expect(isOrphanRecipient('NanoClaw-Cluster:NanoClaw')).toBe(false);
		expect(isOrphanRecipient('NANOCLAW:AGENT')).toBe(false);
	});
});

describe('sweep — dry-run on a temp store', () => {
	let dir: string;
	let inbox: string;
	let archive: string;
	let manifestPath: string;

	beforeEach(() => {
		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		dir = mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-'));
		inbox = path.join(dir, 'messages', 'inbox');
		archive = path.join(dir, 'messages', 'archive');
		mkdirSync(inbox, { recursive: true });
		manifestPath = path.join(dir, 'manifest.json');
	});
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	function put(file: string, msg: Record<string, unknown>) {
		writeFileSync(path.join(inbox, file), JSON.stringify(msg), 'utf-8');
	}

	it('selects only orphan [MENTION] notifications and moves nothing', () => {
		put('a.json', { id: 'a', to: 'myia-ai-01', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('b.json', { id: 'b', to: 'myia-po-2026:ws', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('c.json', { id: 'c', to: 'nanoclaw-cluster', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('d.json', { id: 'd', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('e.json', { id: 'e', to: 'po-2023', subject: 'Correction : pas un MENTION', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		writeFileSync(path.join(inbox, 'z.json'), '{not json', 'utf-8');

		const m = runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath });

		expect(m.kept).toEqual({ fleet: 1, lane: 1, extra: 1 });
		expect(m.unreadable).toBe(1);
		expect(m.selected).toBe(1); // d.json only — e.json is non-mention
		expect(m.rows[0].file).toBe('d.json');
		expect(m.rows[0].sha256).toHaveLength(64);
		// Nothing moved: every file still in the inbox, archive untouched.
		expect(existsSync(path.join(inbox, 'd.json'))).toBe(true);
		expect(existsSync(archive)).toBe(false);
	});

	it('keeps every NanoClaw target found in the store (ms#1413)', () => {
		put('n1.json', { id: 'n1', to: 'nanoclaw-cluster', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('n2.json', { id: 'n2', to: 'nanoclaw-cluster:nanoclaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('n3.json', { id: 'n3', to: 'nanoclaw:agent', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('n4.json', { id: 'n4', to: 'nanoclaw:nanoclaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		put('n5.json', { id: 'n5', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });

		const m = runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath });

		expect(m.kept.extra).toBe(4);
		expect(m.selected).toBe(1);
		expect(m.rows[0].file).toBe('n5.json');
	});

	it('--include-non-mention widens the selection (explicit, not default)', () => {
		put('e.json', { id: 'e', to: 'po-2023', subject: 'Correction : direct send', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		const m = runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath, includeNonMention: true });
		expect(m.selected).toBe(1);
	});

	it('handles structured `to` objects (machineId key)', () => {
		put('s.json', { id: 's', to: { machineId: 'NanoClaw', workspace: 'x' }, subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		const m = runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath });
		expect(m.selected).toBe(1);
		expect(m.rows[0].to).toBe('NanoClaw');
	});

	it('derives the archive as the SIBLING of the inbox (the doubled-path fix)', () => {
		// The documented `--inbox <store>/messages/inbox` form used to derive
		// `<store>/messages/messages/archive` — a phantom tree the apply pass
		// would have written into, moving nothing into the real archive.
		expect(archiveSiblingOf(path.join(dir, 'messages', 'inbox'))).toBe(archive);
		// Property form rather than a POSIX literal: `path.resolve` prefixes the
		// current drive on win32, so the claim is "basename is archive, parent is
		// the inbox's parent, and the doubled `messages/messages` never appears".
		const derived = archiveSiblingOf(path.join('any', 'store', 'messages', 'inbox'));
		expect(path.basename(derived)).toBe('archive');
		expect(path.dirname(derived)).toBe(path.dirname(path.resolve(path.join('any', 'store', 'messages', 'inbox'))));
		expect(derived).not.toContain(`messages${path.sep}messages`);
		const m = runDryRun({ inboxPath: inbox, archivePath: archiveSiblingOf(inbox), manifestPath });
		expect(m.archive).toBe(archive);
		expect(m.inbox).toBe(inbox);
		expect(readFileSync(manifestPath, 'utf-8')).toContain(`"archive": ${JSON.stringify(archive)}`);
	});

	it('reports a non-file *.json entry as unsafe and never selects it', () => {
		// A directory named like a message is not a message. (A junction would be
		// the same class; the plain directory needs no privilege to create.)
		mkdirSync(path.join(inbox, 'dir.json'));
		put('ok.json', { id: 'ok', to: 'po-2023', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });

		const m = runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath });

		expect(m.unsafe).toBe(1);
		expect(m.selected).toBe(1);
		expect(m.rows.map(r => r.file)).toEqual(['ok.json']);
	});

	it('refuses a symlinked/junctioned store root (traversed boundary)', () => {
		const realDir = mkdtempSync(path.join(os.tmpdir(), 'orphan-real-'));
		mkdirSync(path.join(realDir, 'messages', 'inbox'), { recursive: true });
		const linkParent = mkdtempSync(path.join(os.tmpdir(), 'orphan-link-'));
		const link = path.join(linkParent, 'inbox-link');
		try {
			symlinkSync(path.join(realDir, 'messages', 'inbox'), link, 'junction');
			expect(() => runDryRun({
				inboxPath: link,
				archivePath: path.join(linkParent, 'archive'),
				manifestPath: path.join(linkParent, 'm.json')
			})).toThrow(/link\/junction/);
		} finally {
			rmSync(link, { recursive: true, force: true });
			rmSync(linkParent, { recursive: true, force: true });
			rmSync(realDir, { recursive: true, force: true });
		}
	});

	it('refuses an archive inside the inbox, or equal to it', () => {
		expect(() => runDryRun({ inboxPath: inbox, archivePath: inbox, manifestPath })).toThrow(/same directory/);
		expect(() => runDryRun({ inboxPath: inbox, archivePath: path.join(inbox, 'archive'), manifestPath }))
			.toThrow(/inside the inbox/);
	});
});

describe('sweep — live apply on a temp store', () => {
	let dir: string;
	let inbox: string;
	let archive: string;
	let manifestPath: string;

	beforeEach(() => {
		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		dir = mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-live-'));
		inbox = path.join(dir, 'messages', 'inbox');
		archive = path.join(dir, 'messages', 'archive');
		mkdirSync(inbox, { recursive: true });
		manifestPath = path.join(dir, 'manifest.json');
	});
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	function put(file: string, msg: Record<string, unknown>) {
		writeFileSync(path.join(inbox, file), JSON.stringify(msg), 'utf-8');
	}

	function shaOf(file: string) {
		return createHash('sha256').update(readFileSync(path.join(inbox, file), 'utf-8')).digest('hex');
	}

	function freeManifest(rows: Array<{ file: string; sha256: string }>, includeNonMention = false) {
		writeFileSync(manifestPath, JSON.stringify({
			mode: 'dry-run', inbox, archive, includeNonMention, rows
		}), 'utf-8');
	}

	it('moves re-verified rows and skips mutated / missing / reclassified / collision rows', () => {
		// ONE dry-run over five orphan rows, then ALL mutations happen between
		// the dry-run and the apply — the apply pass must re-verify each row
		// against the live store, never trust the manifest.
		put('a.json', { id: 'a', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // untouched -> moved
		put('b.json', { id: 'b', to: 'Hermes', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // mutated -> changed
		put('c.json', { id: 'c', to: 'head', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // recipient fixed -> reclassified
		put('d.json', { id: 'd', to: 'v4', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // deleted -> missing
		put('col.json', { id: 'col', to: 'main', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // archive target taken -> collision
		const m = runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath });
		expect(m.selected).toBe(5);

		// b mutates after the dry-run (hash no longer matches the pre-image)
		put('b.json', { id: 'b', to: 'Hermes', subject: '[MENTION] x CHANGED', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		// c's recipient becomes legit WITHOUT the file changing: the classifier
		// itself moved between the two passes (env gained an extra recipient).
		// The apply pass re-classifies live and must not move the row.
		process.env.ROO_MENTION_EXTRA_RECIPIENTS = 'head';
		// d disappears (archived by someone else meanwhile)
		rmSync(path.join(inbox, 'd.json'));
		// col's archive target already exists
		mkdirSync(archive, { recursive: true });
		writeFileSync(path.join(archive, 'col.json'), '{"id":"col","already":"there"}', 'utf-8');

		let applied: ReturnType<typeof applyManifest>;
		try {
			applied = applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive });
		} finally {
			delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		}

		// counts are spread at the top level, arrays live under outcomes
		expect(applied.moved).toBe(1);
		expect(applied.outcomes.moved).toEqual(['a.json']);
		expect(applied.outcomes.changed).toEqual(['b.json']);
		expect(applied.outcomes.reclassified).toEqual(['c.json']);
		expect(applied.outcomes.missing).toEqual(['d.json']);
		expect(applied.outcomes.collision).toEqual(['col.json']);
		// untouched row really moved, content intact
		expect(existsSync(path.join(inbox, 'a.json'))).toBe(false);
		expect(existsSync(path.join(archive, 'a.json'))).toBe(true);
		expect(JSON.parse(readFileSync(path.join(archive, 'a.json'), 'utf-8')).to).toBe('NanoClaw');
		// skipped rows stay in the inbox
		expect(existsSync(path.join(inbox, 'b.json'))).toBe(true);
		expect(existsSync(path.join(inbox, 'c.json'))).toBe(true);
		expect(existsSync(manifestPath + '.applied.json')).toBe(true);
	});

	it('refuses a manifest that is not a dry-run pre-image', () => {
		writeFileSync(manifestPath, JSON.stringify({ mode: 'applied', rows: [] }), 'utf-8');
		expect(() => applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive }))
			.toThrow(/mode 'applied'/);
	});

	it('refuses a manifest that does not freeze both roots', () => {
		writeFileSync(manifestPath, JSON.stringify({ mode: 'dry-run', rows: [] }), 'utf-8');
		expect(() => applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive }))
			.toThrow(/no inbox/);
		writeFileSync(manifestPath, JSON.stringify({ mode: 'dry-run', inbox, rows: [] }), 'utf-8');
		expect(() => applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive }))
			.toThrow(/no archive/);
	});

	it('refuses a live invocation whose paths differ from the frozen pre-image', () => {
		put('a.json', { id: 'a', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath });
		const other = path.join(dir, 'other-archive');
		expect(() => applyManifest({ manifestPath, inboxPath: inbox, archivePath: other }))
			.toThrow(/does not match the manifest/);
		const otherInbox = path.join(dir, 'other-inbox');
		mkdirSync(otherInbox, { recursive: true });
		expect(() => applyManifest({ manifestPath, inboxPath: otherInbox, archivePath: archive }))
			.toThrow(/does not match the manifest/);
		// nothing moved
		expect(existsSync(path.join(inbox, 'a.json'))).toBe(true);
	});

	it('refuses a manifest whose scope was widened without the invocation opting in (and vice versa)', () => {
		put('e.json', { id: 'e', to: 'po-2023', subject: 'direct send', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		const wide = path.join(dir, 'wide.json');
		runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath: wide, includeNonMention: true });
		expect(() => applyManifest({ manifestPath: wide, inboxPath: inbox, archivePath: archive }))
			.toThrow(/scope mismatch/);
		// and the mirror case: a [MENTION]-only pre-image applied with the wider flag
		const narrow = path.join(dir, 'narrow.json');
		runDryRun({ inboxPath: inbox, archivePath: archive, manifestPath: narrow });
		expect(() => applyManifest({ manifestPath: narrow, inboxPath: inbox, archivePath: archive, includeNonMention: true }))
			.toThrow(/scope mismatch/);
		expect(existsSync(path.join(inbox, 'e.json'))).toBe(true);
	});

	it('revalidates the [MENTION] subject live — a manifest cannot smuggle a wider row', () => {
		// The row's sha256 matches the file on disk exactly, and the recipient IS
		// an orphan: only the subject re-check can catch it. The manifest claims
		// eligibility; the message on disk does not have it.
		put('e.json', { id: 'e', to: 'po-2023', subject: 'Correction : direct send', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		freeManifest([{ file: 'e.json', sha256: shaOf('e.json') }]);

		const applied = applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive });

		expect(applied.moved).toBe(0);
		expect(applied.outcomes.reclassified).toEqual(['e.json']);
		expect(existsSync(path.join(inbox, 'e.json'))).toBe(true);
		expect(existsSync(path.join(archive, 'e.json'))).toBe(false);
	});

	it('confines every row: traversal, sub-paths and ADS names are refused', () => {
		put('a.json', { id: 'a', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		const sha = shaOf('a.json');
		for (const file of ['../escape.json', 'a/b.json', '..\\escape.json', 'a.json:stream', '.', 'x.txt']) {
			freeManifest([{ file, sha256: sha }]);
			expect(() => applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive }), file)
				.toThrow(/not a JSON basename/);
		}
		// nothing escaped the store
		expect(existsSync(path.join(dir, 'escape.json'))).toBe(false);
		expect(existsSync(path.join(dir, 'messages', 'escape.json'))).toBe(false);
	});

	it('skips a linked source file instead of moving through it', () => {
		// A junction named like a message: lstat says "link", never "file".
		const outside = mkdtempSync(path.join(os.tmpdir(), 'orphan-outside-'));
		try {
			symlinkSync(outside, path.join(inbox, 'link.json'), 'junction');
			freeManifest([{ file: 'link.json', sha256: 'x'.repeat(64) }]);
			const applied = applyManifest({ manifestPath, inboxPath: inbox, archivePath: archive });
			expect(applied.moved).toBe(0);
			expect(applied.outcomes.changed).toEqual(['link.json']);
			rmSync(path.join(inbox, 'link.json'), { recursive: true, force: true });
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe('CLI exit codes — ms#1413 point 4 (subprocess, no real store)', () => {
	function runCli(args: string[]) {
		const env = { ...process.env };
		// Deterministic "no store": neither the env var nor a server .env is present.
		delete env.ROOSYNC_SHARED_PATH;
		return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8', env, timeout: 30000 });
	}

	it('exits 2 on every fail-closed refusal (the fix: it used to exit 0)', () => {
		expect(runCli(['--nope']).status).toBe(2);
		expect(runCli([]).status).toBe(2);
		expect(runCli(['--manifest', 'x.json']).status).toBe(2); // no store resolvable
		expect(runCli(['--manifest', 'x.json', '--limit', '0']).status).toBe(2);
		expect(runCli(['--manifest', 'x.json', '--manifest', 'y.json']).status).toBe(2);
	});

	it('exits 0 on --help', () => {
		const r = runCli(['--help']);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/store-level sweep/);
	});

	it('exits 0 for a completed dry-run, freezing the sibling archive, and 1 for an empty pre-image', () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'orphan-cli-'));
		try {
			const inbox = path.join(dir, 'messages', 'inbox');
			mkdirSync(inbox, { recursive: true });
			writeFileSync(path.join(inbox, 'a.json'), JSON.stringify({
				id: 'a', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z'
			}), 'utf-8');
			const man = path.join(dir, 'm.json');

			const dry = runCli(['--manifest', man, '--inbox', inbox]);
			expect(dry.status).toBe(0);
			expect(dry.stdout).toMatch(/selected 1 orphan/);
			const frozen = JSON.parse(readFileSync(man, 'utf-8'));
			// the doubled-path fix, observed through the real CLI
			expect(frozen.archive).toBe(path.join(dir, 'messages', 'archive'));
			expect(frozen.archive).not.toContain(`messages${path.sep}messages`);

			// an empty pre-image applies nothing
			const emptyMan = path.join(dir, 'empty.json');
			writeFileSync(emptyMan, JSON.stringify({
				mode: 'dry-run', inbox, archive: path.join(dir, 'messages', 'archive'), includeNonMention: false, rows: []
			}), 'utf-8');
			const live = runCli(['--manifest', emptyMan, '--inbox', inbox, '--live']);
			expect(live.status).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
