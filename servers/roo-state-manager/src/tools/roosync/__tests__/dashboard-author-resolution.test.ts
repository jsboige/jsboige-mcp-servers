/**
 * ms#1339 — attribution dérivée VISIBLE dans l'ack d'append.
 *
 * Symptôme mesuré (03/10, dashboard global) : un append passerelle sans
 * `author` était attribué en silence à la lane du process hôte — l'ack ne
 * portait ni warning ni champ : la découverte ne venait que du watchdog,
 * 3 h plus tard. Classe #3591/#3230.
 *
 * Le garde : `DashboardResult.authorResolution` — présent avec la valeur
 * `process-default: <machine>|<workspace>` quand `author` est absent,
 * délibérément ABSENT quand `author` est fourni (information, jamais un
 * rejet : les sièges mono-lane légitimes ne changent pas de comportement).
 *
 * Bite-test : retirer le champ du return de handleAppend fait échouer le
 * premier test (undefined ≠ 'process-default: …') ; le retourner aussi quand
 * `author` est fourni fait échouer le second.
 *
 * @module tools/roosync/__tests__/dashboard-author-resolution
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-author-resolution-');

describe('roosync_dashboard append — authorResolution (ms#1339)', () => {
  let tmpDir: string;
  const SAVED: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    for (const k of ['ROOSYNC_SHARED_PATH', 'ROOSYNC_MACHINE_ID', 'ROOSYNC_WORKSPACE_ID', 'ROOSYNC_TRUSTED_CALLER_IDS']) {
      SAVED[k] = process.env[k];
    }
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
    process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
    delete process.env.ROOSYNC_TRUSTED_CALLER_IDS;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("append sans author => authorResolution 'process-default: <machine>|<workspace>' — la dérivation n'est plus silencieuse (occurrence 03/10)", async () => {
    const res = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'ms#1339 — append passerelle sans author',
    });
    expect(res.success).toBe(true);
    // Le champ nomme EXACTEMENT l'identité qui sera estampillée : l'émetteur
    // voit l'écart au moment du geste, pas au watchdog 3 h plus tard.
    expect(res.authorResolution).toBe('process-default: myia-ai-01|roo-extensions');
  });

  it('append AVEC author => champ délibérément absent — pas de bruit pour les sièges qui assertent', async () => {
    const res = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'ms#1339 — author explicite',
      author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
    });
    expect(res.success).toBe(true);
    expect(res.authorResolution).toBeUndefined();
  });
});
