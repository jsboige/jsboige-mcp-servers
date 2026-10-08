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
 * liste fail-closed que #3591.
 *
 * Périmètre (revue ai-01/NanoClaw 08/10, 2e tour) : le premier gate n'énumérait
 * que append/write/update et laissait `merge` (l.6853) et `scrub` (l.5484)
 * ouverts — deux chemins de la MÊME classe, sur un commentaire qui affirmait à
 * tort que merge ne stampe pas. `STAMPING_ACTIONS` couvre désormais les cinq
 * actions dérivées des sites d'écriture réels, et `scrub` atteste l'identité
 * qu'il ÉCRIT (`resolvedMachineId`), pas un `args.author` qu'il ignore.
 * read/list/delete/read_archive/read_overview ne stampent pas : `machineId` y
 * reste un filtre cross-machine légitime, non gated.
 *
 * Bite-test : reverting the dashboard.ts gate block makes
 * "append rejects a phantom untrusted author machine" fail (the phantom is
 * stamped verbatim), and reverting the message-helpers export breaks compile.
 *
 * @module tools/roosync/__tests__/dashboard-author-gate
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
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

  // --- 2e tour (revue ai-01/NanoClaw 08/10) : merge et scrub sont des chemins
  // --- de stamp de la MÊME classe que append/write/update.

  it('merge rejects a phantom untrusted author machine — the path the 1st gate left open', async () => {
    // handleMerge construit `author = args.author ?? resolvedMachineId` (l.6677)
    // et l'écrit dans `lastModifiedBy` (l.6853) : exactement le vecteur #4135,
    // sur une action que le premier prédicat laissait passer.
    await expect(
      roosyncDashboard({
        action: 'merge',
        type: 'workspace',
        sourceKey: 'workspace-source-absente',
        author: { machineId: 'myia-po-204', workspace: 'nanoclaw' },
      })
    ).rejects.toThrow('#4135');
  });

  it('merge with a TRUSTED foreign machine passes the gate (refusal, if any, is business-level)', async () => {
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-po-2024';
    const res = await roosyncDashboard({
      action: 'merge',
      type: 'workspace',
      sourceKey: 'workspace-source-absente',
      author: { machineId: 'myia-po-2024', workspace: 'roo-extensions' },
    });
    const msg = String((res as { message?: string }).message ?? '');
    expect(msg).not.toContain('#4135');
    expect(msg).not.toMatch(/assertable/);
  });

  it('scrub validates the identity it WRITES — a trusted author cannot launder a phantom machineId', async () => {
    // Le cas exigé par la revue : scrub écrit `{ machineId: resolvedMachineId }`
    // (l.5484) et IGNORE args.author. Attester un author étranger mais trusté
    // pendant que `machineId` (donc l'identité écrite) est fantôme serait un
    // laissez-passer : le gate doit refuser sur l'identité écrite.
    process.env.ROOSYNC_TRUSTED_CALLER_IDS = 'myia-po-2024';
    await expect(
      roosyncDashboard({
        action: 'scrub',
        type: 'workspace',
        machineId: 'myia-po-204',
        author: { machineId: 'myia-po-2024', workspace: 'roo-extensions' },
      })
    ).rejects.toThrow('#4135');
  });

  it('scrub with an untrusted machineId and no author is rejected (2nd path of the same class)', async () => {
    await expect(
      roosyncDashboard({ action: 'scrub', type: 'workspace', machineId: 'myia-po-204' })
    ).rejects.toThrow('machineId');
  });

  it('scrub with the local machine on a live dashboard succeeds — no regression', async () => {
    await roosyncDashboard({ action: 'append', type: 'workspace', content: 'cible scrub #4135' });
    const res = await roosyncDashboard({ action: 'scrub', type: 'workspace' });
    expect(res.success).toBe(true);
  });

  it('list with a foreign machineId is NOT gated — cross-machine filtering stays legitimate', async () => {
    const res = await roosyncDashboard({ action: 'list', machineId: 'myia-po-204' });
    expect(String((res as { message?: string }).message ?? '')).not.toContain('#4135');
  });
});

/**
 * Garde de dérive (#4135, revue ai-01 08/10) — le trou d'origine venait d'un
 * prédicat énuméré à l'intention au lieu d'être relu contre les sites
 * d'écriture. Ce test relit `dashboard.ts` et referme la classe par
 * construction : tout handler qui écrit un `lastModifiedBy:` doit être une
 * action de `STAMPING_ACTIONS`. Ajouter un 6e chemin de stamp sans l'y
 * déclarer fait échouer la suite, au lieu de reproduire le trou.
 */
describe('STAMPING_ACTIONS drift guard (#4135)', () => {
  const src = readFileSync(path.join(__dirname, '..', 'dashboard.ts'), 'utf8');
  const lines = src.split(/\r?\n/);

  // Un site d'écriture : la valeur est `author` ou un objet littéral. On exclut
  // les recopies (`dashboard.lastModifiedBy`) et les déclarations de type
  // (`Author`, `Author;`, `Author | undefined`).
  const isStampWrite = (l: string) =>
    /^\s*lastModifiedBy:\s*(author\b|\{)/.test(l) && !/lastModifiedBy:\s*Author\b/.test(l);

  const enclosingHandler = (idx: number): string | null => {
    for (let i = idx; i >= 0; i--) {
      const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/.exec(lines[i]);
      if (m) return m[1];
    }
    return null;
  };

  // handler → action : l'appel du handler est cherché DANS LA RÉGION DU
  // DISPATCHER uniquement ([dispatcherStart, dispatcherEnd)), et on remonte au
  // `case 'x':` le plus proche au-dessus. Les corps de handlers vivent
  // physiquement APRÈS le dispatcher : un scan non borné remontait donc jusqu'au
  // dernier `case` de celui-ci (`read_archive` capturait createEmptyDashboard).
  // Pas de fenêtre en nombre de lignes non plus (elle débordait sur le case
  // suivant : `handleWrite` attribué à `case 'read':`).
  const dispatcherStart = lines.findIndex(l => /export async function roosyncDashboard/.test(l));
  expect(dispatcherStart).toBeGreaterThan(0);
  const dispatcherEndRel = lines
    .slice(dispatcherStart + 1)
    .findIndex(l => /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/.test(l));
  expect(dispatcherEndRel, 'fin du dispatcher introuvable').toBeGreaterThan(0);
  const dispatcherEnd = dispatcherStart + 1 + dispatcherEndRel;
  const actionOfHandler = (handler: string): string | null => {
    const call = new RegExp(`\\b${handler}\\s*\\(`);
    for (let i = dispatcherStart; i < dispatcherEnd; i++) {
      if (!call.test(lines[i])) continue;
      for (let j = i; j >= dispatcherStart; j--) {
        const m = /^\s*case\s+'([a-z_]+)'\s*:/.exec(lines[j]);
        if (m) return m[1];
      }
      return null;
    }
    return null;
  };

  // Un helper interne (ex. `createEmptyDashboard` l.2400) stampe sans être un
  // handler : on le résout par ses APPELANTS et on exige que chacune des actions
  // qui l'atteignent soit déclarée. C'est l'invariant que sa docstring énonce
  // (« Read, delete, read_archive, read_overview et list ne l'appellent jamais »).
  const actionsReachingHelper = (fnName: string): string[] => {
    const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
    const call = new RegExp(`\\b${fnName}\\s*\\(`);
    const out = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      if (decl.test(lines[i]) || !call.test(lines[i])) continue;
      const h = enclosingHandler(i);
      if (!h) continue;
      const a = actionOfHandler(h);
      if (a) out.add(a);
    }
    return [...out].sort();
  };

  const declared = (): string[] => {
    const m = /const STAMPING_ACTIONS[^=]*=\s*new Set\(\[([^\]]*)\]\)/s.exec(src);
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : [];
  };

  it('covers the five measured stamping actions', () => {
    expect(declared()).toEqual(
      expect.arrayContaining(['append', 'write', 'update', 'merge', 'scrub'])
    );
  });

  it('every handler that writes a lastModifiedBy stamp is a declared stamping action', () => {
    const set = new Set(declared());
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(x => isStampWrite(x.l));

    // Les 7 sites mesurés au 08/10 (assertion de plancher : si un site
    // disparaît, c'est un changement de périmètre à relire, pas un silence).
    expect(sites.length).toBeGreaterThanOrEqual(7);

    const seen = new Set<string>();
    for (const s of sites) {
      const handler = enclosingHandler(s.i);
      expect(handler, `site d'écriture l.${s.i + 1} hors de tout handler`).toBeTruthy();

      const direct = actionOfHandler(handler!);
      // Handler du switch, ou helper interne résolu par ses appelants.
      const actions = direct ? [direct] : actionsReachingHelper(handler!);
      expect(
        actions.length,
        `handler/helper ${handler} (l.${s.i + 1}) n'est atteignable depuis aucune action déclarée`
      ).toBeGreaterThan(0);

      for (const a of actions) {
        seen.add(a);
        expect(
          set.has(a),
          `l'action '${a}' écrit un stamp (${handler} l.${s.i + 1}) sans être dans STAMPING_ACTIONS`
        ).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual(['append', 'merge', 'scrub', 'update', 'write']);
  });
});
