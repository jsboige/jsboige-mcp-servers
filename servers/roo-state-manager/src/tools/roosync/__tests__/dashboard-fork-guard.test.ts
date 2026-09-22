/**
 * #3482 — unit tests for the post-write fork guard (verifyDashboardWriteLanded).
 *
 * The guard runs after every dashboard write (tmp→rename) and must detect the
 * DriveFS/Windows deviation measured 06/09: the rename "succeeds" but lands on
 * a `<stem> (N).md` fork while the canonical stops advancing — an [ASK USER]
 * stayed invisible from the canonical that way.
 *
 * Discriminators under test:
 *   - totalMessages (fleet-monotonic counter, clock-independent): smaller than
 *     expected = our write never landed; larger = concurrent winner (nominal).
 *   - lastModified lexicographic ISO fallback when totalMessages is absent.
 *   - fresh collision-named sibling (mtime inside the write window) — a stale
 *     archived fork must NOT arm the guard.
 *   - never throws: unverifiable (canonical unreadable) = ok.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// #3774 critère 2 — la relecture du store autoritaire est mockée : le test porte
// sur le VERDICT rendu (pgChecked true/false, storeKey vide), pas sur PG.
vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readDashboardFromPg: vi.fn() };
});

import { readDashboardFromPg } from '../../../services/unified-store/roosync-dashboard-store.js';
import {
  verifyDashboardWriteLanded,
  verifyWriteVisibleInStore,
  mergeStoreVerification
} from '../dashboard.js';

const mockedReadDashboardFromPg = vi.mocked(readDashboardFromPg);

describe('verifyDashboardWriteLanded (#3482 fork guard)', () => {
  let dir: string;
  let canonical: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fork-guard-'));
    canonical = path.join(dir, 'workspace-v2.test.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const frontmatter = (total: number | null, lastModified: string): string =>
    total === null
      ? `---\ntype: workspace\nlastModified: '${lastModified}'\n---\n\n## Intercom\n`
      : `---\ntype: workspace\nlastModified: '${lastModified}'\ntotalMessages: ${total}\n---\n\n## Intercom\n`;

  const expected = (totalMessages: number, lastModified = '2026-09-07T10:00:00.000Z') =>
    ({ lastModified, totalMessages });

  it('ok — canonical reflects the write, no sibling', async () => {
    await writeFile(canonical, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
    expect(r.forkDetail).toBeUndefined();
  });

  it('suspect — canonical totalMessages SMALLER than expected (write never landed)', async () => {
    // The deviation signature: the fork got our write, the canonical kept its
    // previous state (here 8, we computed 10 from a base of 8).
    await writeFile(canonical, frontmatter(8, '2026-09-07T09:59:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/totalMessages canonique 8 < attendu 10/);
  });

  it('ok — canonical totalMessages LARGER than expected (concurrent winner after our rename)', async () => {
    await writeFile(canonical, frontmatter(12, '2026-09-07T10:00:05.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });

  it('suspect — fresh collision-named sibling inside the write window (dotted stem must still match)', async () => {
    await writeFile(canonical, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const forkPath = path.join(dir, 'workspace-v2.test (1).md');
    await writeFile(forkPath, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/fork frais/);
    expect(r.forkPath).toBe(forkPath);
  });

  it('ok — stale archived fork sibling (mtime outside the write window) does NOT arm the guard', async () => {
    await writeFile(canonical, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const forkPath = path.join(dir, 'workspace-v2.test (1).md');
    await writeFile(forkPath, 'old archived fork', 'utf8');
    const oneHourAgo = new Date(Date.now() - 3600_000);
    await utimes(forkPath, oneHourAgo, oneHourAgo);
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });

  it('ok — canonical unreadable (missing) is unverifiable, not suspected', async () => {
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });

  it('suspect — lastModified fallback fires when totalMessages is absent and canonical is older', async () => {
    await writeFile(canonical, frontmatter(null, '2026-09-07T09:00:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/lastModified canonique/);
  });

  it('ok — lastModified fallback passes when canonical lastModified is newer', async () => {
    await writeFile(canonical, frontmatter(null, '2026-09-07T10:05:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });
});

/**
 * #3774 — garde v2 : le discriminant devient le LIEU D'ATTERRISSAGE des octets
 * (les ids des messages neufs, que le writer seul a produits), cherché au chemin
 * DEMANDÉ. `totalMessages`/`lastModified` sont écrits par le writer : dans un
 * fork ils valent exactement ce qu'il attend, donc ils ne peuvent pas détecter
 * sa propre déviation (arbitrage 06/09).
 */
describe('verifyDashboardWriteLanded — atterrissage par ids (#3774 critère 1 & 4)', () => {
  let dir: string;
  let canonical: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fork-guard-ids-'));
    canonical = path.join(dir, 'workspace-v2.test.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const msgLine = (id: string): string => `### [2026-09-07T10:00:00.000Z] m|w\n[msg: ${id}]\n\ncorps\n`;
  const expected = (totalMessages: number) =>
    ({ lastModified: '2026-09-07T10:00:00.000Z', totalMessages });

  // Critère 4 : le test nominal est un ZÉRO FAUX POSITIF sur chemin identique.
  it('nominal — les ids neufs sont AU CHEMIN DEMANDÉ, chemin identique, aucune alerte', async () => {
    await writeFile(canonical, msgLine('m1') + msgLine('m2'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1', 'm2']);
    expect(r.forkSuspected).toBe(false);
    expect(r.landedPath).toBe(canonical);
    expect(r.forkDetail).toBeUndefined();
  });

  it('déviation — l id est dans un sibling de collision : le sibling est NOMMÉ, sans forkPath', async () => {
    // Le canonique porte l'ancien état, le fork porte nos octets.
    await writeFile(canonical, msgLine('m0'), 'utf8');
    const forkPath = path.join(dir, 'workspace-v2.test (1).md');
    await writeFile(forkPath, msgLine('m0') + msgLine('m1'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1']);
    expect(r.forkSuspected).toBe(true);
    expect(r.signal).toBe('file');
    expect(r.landedPath).toBe(forkPath);
    // Contrat (review ai-01, MAJEUR) : le scan d'id ne remplit JAMAIS forkPath —
    // ce champ décide de la suppression de source côté merge.
    expect(r.forkPath).toBeUndefined();
    expect(r.forkDetail).toMatch(/présents dans 'workspace-v2\.test \(1\)\.md'/);
  });

  it('déviation — sibling au nom NON canonique : le verdict ne dépend d aucun motif de suffixe', async () => {
    // L'arbitrage a écarté `\(\d\)\.md$` comme critère (détail d'implémentation
    // d'un DriveFS). Le scan cherche le CONTENU : n'importe quel nom doit suffire.
    await writeFile(canonical, msgLine('m0'), 'utf8');
    const oddName = path.join(dir, 'workspace-v2.test-bis.md');
    await writeFile(oddName, msgLine('m1'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1']);
    expect(r.forkSuspected).toBe(true);
    expect(r.landedPath).toBe(oddName);
    expect(r.forkPath).toBeUndefined();
  });

  it('déviation — id introuvable partout : suspicion SANS chemin d atterrissage', async () => {
    await writeFile(canonical, msgLine('m0'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1']);
    expect(r.forkSuspected).toBe(true);
    expect(r.landedPath).toBeUndefined();
    expect(r.forkDetail).toMatch(/introuvables/);
  });

  it('déviation — atterrissage PARTIEL au chemin demandé ne vaut pas nominal (every, pas some)', async () => {
    // Sans le `every`, un atterrissage partiel passerait pour nominal — la
    // moitié de nos messages serait silencieusement perdue.
    await writeFile(canonical, msgLine('m1'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1', 'm2']);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/introuvables/);
  });

  it('frontière — un tableau d ids VIDE retombe sur la garde legacy (#3482)', async () => {
    await writeFile(canonical, `---\ntotalMessages: 5\n---\n\n## Intercom\n` + msgLine('m0'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(99), Date.now() - 5000, []);
    // Message legacy : c'est le chemin compteur qui a parlé, pas le chemin ids.
    expect(r.forkDetail).toMatch(/totalMessages canonique/);
    expect(r.signal).toBeUndefined();
  });

  it('m2 (review ai-01) — répertoire illisible juste après une écriture réussie : ALERTE, pas silence', async () => {
    // L'asymétrie d'origine : chemin demandé illisible ⇒ alarme, mais readdir
    // en échec ⇒ catch ultime ⇒ « invérifiable » silencieux. Pour une garde
    // dont le défaut a vécu 3 semaines en silence, la direction conservatrice
    // s'applique des deux côtés.
    await rm(dir, { recursive: true, force: true });
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1']);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/illisible au moment de la vérification/);
  });

  it('MAJEUR (review ai-01) — merge dévié dont la SOURCE porte l id : la suppression de source doit rester ABANDONNÉE', async () => {
    // FS exact du scénario #3774 au moment de la vérification d'un merge
    // `workspace-CoursIA (1)` → `workspace-CoursIA` dont l'écriture a dévié
    // vers `(2).md` : la cible demandée ne porte PAS l'id neuf ; la SOURCE
    // `(1)` le porte PAR CONSTRUCTION (union triée par timestamp : le dernier
    // message vient de la clé la plus récente = la source) ; la déviation
    // `(2)` le porte aussi. readdir rend `(1)` avant `(2)` (ordre alphabétique)
    // — l'ancien code nommait donc la SOURCE comme `forkPath`.
    await writeFile(canonical, msgLine('m0'), 'utf8');
    const sourcePath = path.join(dir, 'workspace-v2.test (1).md');
    await writeFile(sourcePath, msgLine('m1'), 'utf8');
    await writeFile(path.join(dir, 'workspace-v2.test (2).md'), msgLine('m1'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(1), Date.now() - 5000, ['m1']);
    expect(r.forkSuspected).toBe(true);
    // Le contrat que le consommateur merge (dashboard.ts, `suspectedForeignFork`)
    // exige : le scan d'id ne remplit PAS forkPath — sinon la source, porteur
    // légitime, serait prise pour un fork ÉTRANGER à elle-même et la
    // suppression se poursuivrait (inversion du fail-closed de la base).
    expect(r.forkPath).toBeUndefined();
    expect(r.landedPath).toBeDefined();
    // Prédicat consommateur — miroir exact de `dashboard.ts` (action merge) :
    const suspectedForeignFork =
      r.forkSuspected === true && r.forkPath !== sourcePath;
    expect(suspectedForeignFork).toBe(true); // ⇒ suppression ABANDONNÉE, source intacte
  });

  it('id DÉJÀ sur disque (writer non-append) ne court-circuite PAS les contrôles legacy', async () => {
    // Le cas qui a failli passer : status/scrub/condensation réécrivent un
    // dashboard dont le dernier message est DÉJÀ au chemin demandé. Le contrôle
    // d'id y est vacant par construction — s'il sortait tôt en « nominal », il
    // affaiblirait la garde au lieu de la renforcer (le compteur, lui, sait
    // encore dire que l'écriture n'a pas atterri).
    await writeFile(
      canonical,
      `---\ntotalMessages: 8\n---\n\n## Intercom\n` + msgLine('m1'),
      'utf8'
    );
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000, ['m1']);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/totalMessages canonique 8 < attendu 10/);
  });
});

/**
 * #3774 critère 2 — substrat autoritaire (store PG). Contrat explicite :
 * `pgChecked:false` = la relecture n'a PAS eu lieu (limite assumée, jamais un
 * succès implicite).
 */
describe('verifyWriteVisibleInStore (#3774 critère 2)', () => {
  beforeEach(() => {
    mockedReadDashboardFromPg.mockReset();
  });

  const fakeStore = (ids: string[]) =>
    ({ intercom: { messages: ids.map(id => ({ id })) } }) as never;

  it('pas de relecture quand aucun id à vérifier — pgChecked:false explicite', async () => {
    const r = await verifyWriteVisibleInStore('workspace-CoursIA', []);
    expect(r.pgChecked).toBe(false);
    expect(mockedReadDashboardFromPg).not.toHaveBeenCalled();
  });

  it('store illisible / porte PG off — pgChecked:false avec la limite NOMMÉE', async () => {
    mockedReadDashboardFromPg.mockResolvedValue(null);
    const r = await verifyWriteVisibleInStore('workspace-CoursIA', ['m1']);
    expect(r.pgChecked).toBe(false);
    expect(r.detail).toMatch(/limite assumée/);
  });

  it('ids lisibles sous la clé demandée — verdict positif', async () => {
    mockedReadDashboardFromPg.mockResolvedValue(fakeStore(['m0', 'm1']));
    const r = await verifyWriteVisibleInStore('workspace-CoursIA', ['m1']);
    expect(r.pgChecked).toBe(true);
    expect(r.storeKey).toBe('workspace-CoursIA');
  });

  it('store répond SANS nos ids — pgChecked:true, storeKey vide', async () => {
    mockedReadDashboardFromPg.mockResolvedValue(fakeStore(['m0']));
    const r = await verifyWriteVisibleInStore('workspace-CoursIA', ['m1']);
    expect(r.pgChecked).toBe(true);
    expect(r.storeKey).toBe('');
    expect(r.detail).toMatch(/ne les verra pas/);
  });

  it('store en erreur (throw) ne fait jamais échouer l écriture', async () => {
    mockedReadDashboardFromPg.mockRejectedValue(new Error('PG down'));
    const r = await verifyWriteVisibleInStore('workspace-CoursIA', ['m1']);
    expect(r.pgChecked).toBe(false);
  });
});

/**
 * #3774 — la fusion est le point où les deux verdicts se rencontrent. C'est
 * exactement le cas qui a coûté 3 semaines : un atterrissage FICHIER nominal
 * masquait une absence dans le store que la flotte lit en primaire.
 */
describe('mergeStoreVerification (#3774 — aucun verdict n efface l autre)', () => {
  it('fichier nominal + store muet ⇒ ALERTE de store (le cas coûteux)', () => {
    const r = mergeStoreVerification(
      { forkSuspected: false, landedPath: 'x.md' },
      { pgChecked: true, storeKey: '', detail: 'absent du journal PG' }
    );
    expect(r.forkSuspected).toBe(true);
    expect(r.signal).toBe('store');
    expect(r.landedPath).toBe('x.md');
    expect(r.pgChecked).toBe(true);
  });

  it('fichier dévié + store muet ⇒ signal composé file+store, les deux détails', () => {
    const r = mergeStoreVerification(
      { forkSuspected: true, forkDetail: 'atterri ailleurs' },
      { pgChecked: true, storeKey: '', detail: 'absent du journal PG' }
    );
    expect(r.signal).toBe('file+store');
    expect(r.forkDetail).toBe('atterri ailleurs | absent du journal PG');
  });

  it('les deux nominaux ⇒ aucune alerte', () => {
    const r = mergeStoreVerification(
      { forkSuspected: false, landedPath: 'x.md' },
      { pgChecked: true, storeKey: 'workspace-CoursIA' }
    );
    expect(r.forkSuspected).toBe(false);
    expect(r.signal).toBeUndefined();
  });

  it('store NON relu ⇒ le verdict fichier passe intact, pgChecked:false visible', () => {
    const r = mergeStoreVerification(
      { forkSuspected: true, forkDetail: 'atterri ailleurs' },
      { pgChecked: false }
    );
    expect(r.forkSuspected).toBe(true);
    expect(r.signal).toBeUndefined();
    expect(r.pgChecked).toBe(false);
    expect(r.forkDetail).toBe('atterri ailleurs');
  });
});
