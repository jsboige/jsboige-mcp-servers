/**
 * #4352 review (ai-01, 28/10) — a `.env` edit that changes the FILE record must
 * rebuild the embedding clients even when no allowlisted process.env key moves.
 *
 * Under host shadowing (the deadep defect) the host owns the endpoint key, so a
 * rotation in `.env` never reaches process.env: the file record (shadowing
 * canonical, or its key) is the ONLY signal that the fallback order changed, and
 * the clients must rebuild on it or keep serving the old plan.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reloadConfig } from '../../../src/services/config-reload.js';
import { resetEmbeddingFileConfigForTest } from '../../../src/services/embedding-endpoints.js';
import { captureHostEnvKeys, resetHostEnvKeysForTest } from '../../../src/services/host-env-snapshot.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-reload-record-'));

function envFile(name: string, content: string): string {
	const file = path.join(TMP_DIR, name);
	fs.writeFileSync(file, content, 'utf8');
	return file;
}

afterAll(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('#4352 review — file-record change rebuilds the embedding clients', () => {
	// The runner's real env must not leak into the plan math: with a live
	// EMBEDDING_API_BASE_URL equal to the fixture canonical, the append would
	// not be live and the key-rotation leg would silently stop resetting.
	const savedEmbeddingEnv: Record<string, string | undefined> = {};
	const EMBEDDING_ENV_KEYS = [
		'EMBEDDING_API_BASE_URL', 'EMBEDDING_API_BASE_URLS', 'EMBEDDING_API_KEY', 'OPENAI_API_KEY',
	] as const;

	beforeEach(() => {
		for (const k of EMBEDDING_ENV_KEYS) {
			savedEmbeddingEnv[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEmbeddingEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		resetEmbeddingFileConfigForTest();
		resetHostEnvKeysForTest();
	});

	it('rebuilds when the file record changes, without any process.env key moving', () => {
		// Host-own BOTH embedding keys: the reload must not copy them into
		// process.env, so the only change signal is the file record itself —
		// the exact state of a shadowed host (defect measurement ai-01).
		captureHostEnvKeys({
			RSM_HOST_ENV_KEYS: 'EMBEDDING_API_KEY,EMBEDDING_API_BASE_URL',
		} as NodeJS.ProcessEnv);

		// Baseline: a file with no embedding keys, loaded twice — the second load
		// changes nothing (whatever the boot record held is absorbed by the first).
		const empty = envFile('empty.env', '# nothing embedding-related\n');
		reloadConfig(empty);
		const baseline = reloadConfig(empty);
		expect(baseline.changed).toEqual([]);
		expect(baseline.clientsReset).toEqual([]);

		// The `.env` gains a canonical and its key → the record changed → the
		// embedding clients rebuild, although NO allowlisted key moved (host-owned).
		const withKey = envFile('with-key.env',
			'EMBEDDING_API_BASE_URL=https://embeddings.myia.io/v1\nEMBEDDING_API_KEY=key-B\n');
		const gained = reloadConfig(withKey);
		expect(gained.changed).toEqual([]);
		expect(gained.hostOwnedKeys).toEqual(expect.arrayContaining(['EMBEDDING_API_KEY', 'EMBEDDING_API_BASE_URL']));
		expect(gained.clientsReset).toContain('embeddingClient');
		expect(gained.clientsReset).toContain('codebaseEmbeddingClient');

		// Same file again → record unchanged → no rebuild.
		const steady = reloadConfig(withKey);
		expect(steady.clientsReset).toEqual([]);

		// The key rotates → the record changed again → rebuild again. This is the
		// path a fleet-wide rotation takes on a shadowed host.
		const rotated = envFile('rotated.env',
			'EMBEDDING_API_BASE_URL=https://embeddings.myia.io/v1\nEMBEDDING_API_KEY=key-C\n');
		const rotatedReport = reloadConfig(rotated);
		expect(rotatedReport.changed).toEqual([]);
		expect(rotatedReport.clientsReset).toContain('embeddingClient');
	});
});
