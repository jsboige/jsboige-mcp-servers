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
 * @module tests/unit/archive-orphan-mention-notifications
 * @issue #2591
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
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
	applyManifest
} from '../../scripts/archive-orphan-mention-notifications.mjs';
import {
	isFleetRecipient,
	loadExtraMentionRecipients
} from '../../src/utils/dashboard-helpers.js';

/** Corpus spanning every classification the fleet can produce. */
const CORPUS = [
	// bare fleet machines (8/8 measured in .shared-state/configs)
	'myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025',
	'myia-po-2026', 'myia-po-2027', 'myia-web1', 'myia-web2',
	// lane addresses — the documented trap (must be KEPT)
	'myia-po-2026:workspace-cluster-coordination', 'myia-ai-01:CoursIA-2',
	// explicit out-of-shape live consumer (review ms#1408)
	'nanoclaw-cluster',
	// orphan population measured on #2591 (must be SWEPT)
	'head', 'main', 'v4', 'gmail', '11', '09', '120', 'anthropic', 'vscode',
	'NanoClaw', 'Hermes', 'hermes-pr-review', 'mention', '7ecbb49f',
	'b749e9fa557c', 'po-2023', 'po-2026', 'ai-01', 'Myia-Po-2027',
	'cluster-manager:nanoclaw-cluster', '5', ''
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
	});

	it('classifies the lane-address trap as KEPT, not orphan', () => {
		expect(classifyRecipient('myia-po-2026:workspace-cluster-coordination')).toBe('lane');
	});
});

describe('sweep — dry-run on a temp store', () => {
	let dir: string;
	let inbox: string;
	let manifestPath: string;

	beforeEach(() => {
		delete process.env.ROO_MENTION_EXTRA_RECIPIENTS;
		dir = mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-'));
		inbox = path.join(dir, 'messages', 'inbox');
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

		const m = runDryRun({ inboxPath: inbox, manifestPath });

		expect(m.kept).toEqual({ fleet: 1, lane: 1, extra: 1 });
		expect(m.unreadable).toBe(1);
		expect(m.selected).toBe(1); // d.json only — e.json is non-mention
		expect(m.rows[0].file).toBe('d.json');
		expect(m.rows[0].sha256).toHaveLength(64);
		// Nothing moved: every file still in the inbox, archive untouched.
		expect(existsSync(path.join(inbox, 'd.json'))).toBe(true);
		expect(existsSync(path.join(dir, 'messages', 'archive'))).toBe(false);
	});

	it('--include-non-mention widens the selection (explicit, not default)', () => {
		put('e.json', { id: 'e', to: 'po-2023', subject: 'Correction : direct send', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		const m = runDryRun({ inboxPath: inbox, manifestPath, includeNonMention: true });
		expect(m.selected).toBe(1);
	});

	it('handles structured `to` objects (machineId key)', () => {
		put('s.json', { id: 's', to: { machineId: 'NanoClaw', workspace: 'x' }, subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' });
		const m = runDryRun({ inboxPath: inbox, manifestPath });
		expect(m.selected).toBe(1);
		expect(m.rows[0].to).toBe('NanoClaw');
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

	it('moves re-verified rows and skips mutated / missing / reclassified / collision rows', () => {
		// ONE dry-run over five orphan rows, then ALL mutations happen between
		// the dry-run and the apply — the apply pass must re-verify each row
		// against the live store, never trust the manifest.
		put('a.json', { id: 'a', to: 'NanoClaw', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // untouched -> moved
		put('b.json', { id: 'b', to: 'Hermes', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // mutated -> changed
		put('c.json', { id: 'c', to: 'head', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // recipient fixed -> reclassified
		put('d.json', { id: 'd', to: 'v4', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // deleted -> missing
		put('col.json', { id: 'col', to: 'main', subject: '[MENTION] x', from: 'f', timestamp: '2026-10-01T00:00:00Z' }); // archive target taken -> collision
		const m = runDryRun({ inboxPath: inbox, manifestPath });
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
			applied = applyManifest({ manifestPath, archivePath: archive });
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
		expect(() => applyManifest({ manifestPath, archivePath: archive })).toThrow(/mode 'applied'/);
	});
});
