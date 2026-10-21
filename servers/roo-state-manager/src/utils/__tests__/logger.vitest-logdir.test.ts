/**
 * Tests du défaut logDir sous VITEST — grain c.34 (Refs #371)
 *
 * Constat mesuré (ai-01, 21/10) : toute exécution vitest sur un siège écrivait
 * dans le MÊME roosync-YYYYMMDD.log que le serveur vivant du RSM — une lane a
 * relayé un log de test comme une panne de production (« Cloud condensation
 * fallback DISABLED » émis par un vitest du worktree wt-4291). Le défaut sous
 * test doit donc être un répertoire DISTINCT ; le chemin de production ne
 * change jamais (FIX #371).
 *
 * tmpdir() est détournée vers un scratch via mock de 'os' (même specifier que
 * logger.ts) : le rouge lui-même ne doit pas polluer le répertoire de
 * production — ce serait commettre l'offense que ce test interdit.
 *
 * Le scratch est retiré en afterAll (grain c.35) : chaque exécution du fichier
 * laissait sinon un rsm-logdir-test-* permanent dans le tmpdir du siège (3
 * résidus mesurés sur po-2028 après les runs du 21/10). Le chemin passe par
 * globalThis : la factory vi.mock est hoistée au-dessus des déclarations du
 * module, une variable locale serait en TDZ au moment de son exécution.
 */

import { describe, test, expect, vi, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { Logger } from '../logger.js';

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    const fs = await import('fs');
    const path = await import('path');
    const scratch = fs.mkdtempSync(path.join(actual.tmpdir(), 'rsm-logdir-test-'));
    (globalThis as Record<string, unknown>).__rsmLogdirScratch = scratch;
    return { ...actual, tmpdir: () => scratch };
});

afterAll(() => {
    const scratch = (globalThis as Record<string, unknown>).__rsmLogdirScratch;
    if (typeof scratch === 'string') {
        rmSync(scratch, { recursive: true, force: true });
    }
});

describe('Logger default logDir under VITEST (Refs #371)', () => {
	test('default is a distinct -test directory, never the production one', () => {
		const logger = new Logger(); // no logDir — the default under test
		const config = logger.getConfig();
		// tmpdir() is the mocked one on BOTH sides of the comparison.
		expect(config.logDir).toBe(join(tmpdir(), 'roo-state-manager-logs-test'));
	});

	test('explicit logDir still wins over the vitest default', () => {
		const explicit = join(tmpdir(), 'my-own-logs');
		const logger = new Logger({ logDir: explicit });
		expect(logger.getConfig().logDir).toBe(explicit);
	});
});
