/**
 * #4135 — Dashboard author-stamp gate (mirror of the #3591 `as` gate).
 *
 * Symptôme mesuré : deux appends du dashboard `workspace-cluster-coordination`
 * estampillés `myia-po-204|nanoclaw` alors que la lane NanoClaw s'exécute sur
 * myia-ai-01 — l'id d'une machine décommissionnée/typoïée, devenu machine
 * « online » dans le health flotte avec un `lastSeen` frais.
 *
 * Cause (audit code, issue #4135 c.6062830851) : `handleAppend`/`handleWrite`/
 * `handleUpdate` stampent `args.author ?? resolvedMachineId` SANS validation —
 * contrairement à `messages`/`manage` qui gatent via `resolveCallerIdentity`
 * (#3591, single choke point). Le dashboard n'importe même pas la fonction.
 *
 * Le garde : `assertStampsMachine` (message-helpers.ts) — machine locale passe
 * toujours ; machine étrangère exigée dans ROOSYNC_TRUSTED_CALLER_IDS, même
 * liste fail-closed que #3591. read/list/merge/delete ne stampent pas :
 * `machineId` y reste un filtre cross-machine légitime, non gated.
 *
 * Bite-test : reverting the dashboard.ts gate block makes
 * "append rejects a phantom untrusted author machine" fail (the phantom is
 * stamped verbatim), and reverting the message-helpers export breaks compile.
 *
 * @module tools/roosync/__tests__/dashboard-author-gate
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { assertStampsMachine, StateManagerError } from '../../../utils/message-helpers.js';
import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-author-gate-');

describe('assertStampsMachine (#4135, unit)', () => {
  const SAVED: Record<string, string | undefined> = {};
  const save = (k: string) => {
    SAVED[k] = process.env[k];
  };
  const restore = () => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  beforeEach(() => {
    save('ROOSYNC_MACHINE_ID');
    save('ROOSYNC_TRUSTED_CALLER_IDS');
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
    delete process.env.ROOSYNC_TRUSTED_CALLER_IDS;
  });
  afterEach(restore);

  it('local machine always passes — zero behavior change for seats that do not assert', () => {
    expect(() => assertStampsMachine('myia-ai-01', 'author')).not.toThrow();
    // Case-insensitive
    expect(() => assertStampsMachine('MYIA-AI-01', 'author')).not.toThrow();
  });

  it('foreign machine not in the trust list is rejected (the measured phantom case)', () => {
    // myia-po-204 : décommissionnée/typoïée, pas au ROO_FLEET_ROSTER (#4135)
    expect(() => assertStampsMachine('myia-po-204', 'author')).toThrow(StateManagerError);
    try {
      assertStampsMachine('myia-po-204', 'author');
      expect.unreachable('must throw');
    } catch (err) {
      const e = err as StateManagerError;
      expect(e.message).toContain('#4135');
      expect(e.message).toContain('ROOSYNC_TRUSTED_CALLER_IDS');
      expect(e.message).toContain('myia-po-204');
    }
  });

  it('foreign machine listed in ROOSYNC_TRUSTED_CALLER_IDS passes (gateway seat asserting its real machine)', () => {
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-po-2024, myia-web1';
    expect(() => assertStampsMachine('myia-po-2024', 'machineId')).not.toThrow();
    expect(() => assertStampsMachine('myia-web1', 'author')).not.toThrow();
    // Not in the list despite the list being non-empty
    expect(() => assertStampsMachine('myia-po-204', 'author')).toThrow(StateManagerError);
  });

  it('short-form aliases canonicalize on BOTH sides (asserted id and trust list)', () => {
    // #3292 : "po-2024" asserté doit matcher une entrée de confiance écrite "myia-po-2024"
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-po-2024';
    expect(() => assertStampsMachine('po-2024', 'author')).not.toThrow();
    // Et réciproquement : entrée de confiance en forme courte, id asserté canonique
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'po-2025';
    expect(() => assertStampsMachine('myia-po-2025', 'machineId')).not.toThrow();
  });

  it('empty assertion passes (no machine to validate)', () => {
    expect(() => assertStampsMachine('', 'author')).not.toThrow();
    expect(() => assertStampsMachine('  ', 'author')).not.toThrow();
  });
});

describe('roosync_dashboard author-stamp gate (#4135, dispatch)', () => {
  let tmpDir: string;
  const SAVED: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    for (const k of ['ROOSYNC_SHARED_PATH', 'ROOSYNC_MACHINE_ID', 'ROOSYNC_WORKSPACE_ID', 'ROOSYNC_TRUSTED_CALLER_IDS']) {
      SAVED[k] = process.env[k];
    }
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01';
    process.env.ROOSYNC_WORKSPACE_ID = 'nanoclaw';
    delete process.env.ROOSYNC_TRUSTED_CALLER_IDS;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('append rejects a phantom untrusted author machine — the exact #4135 reproduction', async () => {
    await expect(
      roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: 'test #4135 phantom author',
        author: { machineId: 'myia-po-204', workspace: 'nanoclaw' },
      })
    ).rejects.toThrow('#4135');
  });

  it('append with an untrusted machineId (no author) is rejected too — same vector, other param', async () => {
    await expect(
      roosyncDashboard({
        action: 'append',
        type: 'workspace',
        machineId: 'myia-po-204',
        content: 'test #4135 phantom machineId',
      })
    ).rejects.toThrow('machineId');
  });

  it('append with the local machine (no assertion) still succeeds — no regression for the normal path', async () => {
    const res = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'nominal append, no author asserted',
    });
    expect(res.success).toBe(true);
  });

  it('append from a TRUSTED foreign machine is stamped as asserted (gateway seat remedy)', async () => {
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-po-2024';
    const res = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'gateway seat asserting its real machine',
      author: { machineId: 'myia-po-2024', workspace: 'roo-extensions' },
    });
    expect(res.success).toBe(true);
    const read = await roosyncDashboard({ action: 'read', type: 'workspace', section: 'intercom' });
    expect(read.success).toBe(true);
  });

  it('read with a foreign machineId is NOT gated — cross-machine filtering stays legitimate', async () => {
    // Le gate ne s'applique qu'aux actions qui stampent un auteur. Un read
    // filtrant sur une autre machine ne doit pas être refusé par #4135
    // (il peut rendre "introuvable" — c'est un autre code d'erreur, pas le gate).
    const res = await roosyncDashboard({
      action: 'read',
      type: 'workspace',
      machineId: 'myia-po-204',
      section: 'intercom',
    });
    // Pas de rejection #4135 : soit succès, soit introuvable — jamais le gate.
    expect(String((res as { message?: string }).message ?? '')).not.toContain('#4135');
  });
});
