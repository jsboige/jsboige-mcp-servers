/**
 * #3537 §6.3 (borne vide) — garde création-seule dans createEmptyDashboard.
 *
 * La clé `workspace-` (nom vide) vit au rang de clé de plein droit dans le
 * store partagé (#3537 §4) : le schéma accepte `workspace: ""` et le `??` du
 * handler ne remplace pas une chaîne vide. Ces tests verrouillent que la
 * CRÉATION d'un espace de noms à nom vide/whitespace est refusée, à l'entrée
 * exacte où elle se produit (la fabrique), et que rien d'autre ne bouge :
 *
 *   - read/write/append d'une clé historique vide EXISTANTE : service INTACT
 *     (compatibilité des clés existantes — la garde ne bloque jamais une
 *     MISE À JOUR, seulement la création) ;
 *   - preuve d'absence d'effet de bord : `dualWriteDashboardSync` espionné —
 *     zéro appel sur chaque refus (le throw précède writeDashboardFile),
 *     exactement un appel (le primaire) sur le cross-post à cible refuseuse ;
 *   - cross-post vers une cible vide : attrapé par cible, l'append primaire
 *     réussit (contrat d'indépendance des cibles) ;
 *   - formes `(1)`, `.md.bak`, casse : JAMAIS refusées à la création — leur
 *     réconciliation relève de l'opération explicite §6.2, pas d'un rejet
 *     heuristique à la dérivation.
 *
 * Contre-épreuve : sans la garde dans la fabrique, les tests « refuses to
 * create » rougissent (l'appel crée le dashboard fantôme au lieu de jeter),
 * tandis que les tests de compatibilité restent verts avant ET après.
 *
 * Isolation : store tmpdir UNIQUE par test (aucune dépendance à l'ordre),
 * env sauvegardé puis restauré à l'identique, tmpdir supprimé en afterEach.
 * Gates PG désactivées + writer Null — aucune écriture réelle PG/GDrive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

// Preuve « zéro appel writer » : double espionné sur le chemin dual-write PG.
// Le reste du module store reste RÉEL (lectures PG gate-off => null).
const { dualWriteSyncSpy } = vi.hoisted(() => ({ dualWriteSyncSpy: vi.fn() }));
vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dualWriteDashboardSync: dualWriteSyncSpy };
});

// #858 / #864: garder le client LLM (condensation) inert — pattern
// fail-closed-store.test.ts. Aucun appel ne doit y arriver.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard, createEmptyDashboard } from '../dashboard.js';

// --- Isolation : un store unique par test, purgé en afterEach -------------
let testDir = '';
let dashboardsDir = '';
let testSerial = 0;

const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
] as const;
let savedEnv: Partial<Record<typeof WATCHED_ENV[number], string | undefined>> = {};

const noFile = (name: string) => expect(existsSync(path.join(dashboardsDir, name))).toBe(false);

/** Fixture : clé historique parasite `workspace-` pré-existante sur disque. */
function seedHistoricalEmptyKey(statusText = '*Historique figé — clé parasite recensée #3537.*'): void {
  mkdirSync(dashboardsDir, { recursive: true });
  writeFileSync(path.join(dashboardsDir, 'workspace-.md'),
    `---
type: workspace
lastModified: 2026-09-05T17:02:00.000Z
---

## Status

${statusText}

## Intercom (0 messages)

*Aucun message.*
`, 'utf8');
}

const author = { machineId: 'test-machine', workspace: 'test-workspace' };

beforeEach(() => {
  // Store jetable, unique par test : aucune dépendance à l'ordre des tests.
  testDir = path.join(os.tmpdir(), `roosync-emptykey-${Date.now()}-${process.pid}-${++testSerial}`);
  dashboardsDir = path.join(testDir, 'shared-state', 'dashboards');
  // Le store doit EXISTER : le fail-closed #3459 (assertSharedStoreAccessible)
  // coupe l'appel bien avant la branche de création si la racine est absente.
  mkdirSync(path.join(testDir, 'shared-state'), { recursive: true });

  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = path.join(testDir, 'shared-state');
  process.env.ROOSYNC_MACHINE_ID = 'test-machine';
  process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
  // Gates #3151 fermées : lecture fichier, writer Null — zéro PG, zéro G:.
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_API_BASE_URL;

  dualWriteSyncSpy.mockClear();
});

afterEach(() => {
  // Restauration EXACTE de l'environnement d'origine (valeur ou absence).
  for (const key of WATCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('createEmptyDashboard — refus de création à nom vide (#3537 §6.3)', () => {
  it("jette sur la clé 'workspace-' (workspace vide passé à travers ??)", () => {
    expect(() => createEmptyDashboard('workspace', 'workspace-', author))
      .toThrow(/nom vide.*#3537/u);
  });

  it("jette sur 'workspace- ' (whitespace : basename(' ') n'est pas vide)", () => {
    expect(() => createEmptyDashboard('workspace', 'workspace- ', author))
      .toThrow(/nom vide/u);
  });

  it("jette sur 'machine-' (machineId vide)", () => {
    expect(() => createEmptyDashboard('machine', 'machine-', author))
      .toThrow(/nom vide/u);
  });

  it('ne rejette AUCUNE autre forme — borné à la borne vide, rien d’autre', () => {
    // (1) : deux écrivains vivants #3482 — fusion §6.2 explicite, jamais rejet.
    expect(() => createEmptyDashboard('workspace', 'workspace-CoursIA (1)', author)).not.toThrow();
    // Résidus .md/.bak : lisibles à jamais, pas d’heuristique de rejet.
    expect(() => createEmptyDashboard('workspace', 'workspace-CoursIA.md.bak', author)).not.toThrow();
    // URL-encodé : idem.
    expect(() => createEmptyDashboard('workspace', 'workspace-myia-po-2025%3ACoursIA-2', author)).not.toThrow();
    // Casse préservée (mandat 2026-05-23).
    expect(() => createEmptyDashboard('workspace', 'workspace-CoursIA', author)).not.toThrow();
    expect(() => createEmptyDashboard('machine', 'machine-myia-po-2025', author)).not.toThrow();
    expect(() => createEmptyDashboard('global', 'global', author)).not.toThrow();
  });

  it('reste une fabrique : le dashboard rendu est inchangé pour une clé valide', () => {
    const d = createEmptyDashboard('workspace', 'workspace-CoursIA', author);
    expect(d.type).toBe('workspace');
    expect(d.key).toBe('workspace-CoursIA');
    expect(d.intercom.messages).toEqual([]);
    expect(d.lastModifiedBy).toEqual(author);
  });
});

describe('seam append/write — le refus arrive avant TOUTE écriture', () => {
  it("append workspace:'' → rejette, aucun fichier, ZÉRO appel dual-write PG", async () => {
    await expect(
      roosyncDashboard({ action: 'append', type: 'workspace', workspace: '', content: 'message' })
    ).rejects.toThrow(/nom vide/u);
    noFile('workspace-.md');
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
  });

  it("write workspace:'   ' → rejette (whitespace traverse ??), aucun fichier, ZÉRO appel", async () => {
    await expect(
      roosyncDashboard({ action: 'write', type: 'workspace', workspace: '   ', content: '# status' })
    ).rejects.toThrow(/nom vide/u);
    noFile('workspace-.md');
    noFile('workspace-   .md');
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
  });

  it("append machineId:'' → rejette, aucun fichier 'machine-.md', ZÉRO appel", async () => {
    await expect(
      roosyncDashboard({ action: 'append', type: 'machine', machineId: '', content: 'message' })
    ).rejects.toThrow(/nom vide/u);
    noFile('machine-.md');
    expect(dualWriteSyncSpy).not.toHaveBeenCalled();
  });
});

describe('compatibilité des clés historiques EXISTANTES — la garde est création-seule', () => {
  it("read workspace:'' d'une clé MANQUANTE : réponse introuvable, pas de throw, pas de création", async () => {
    const result = await roosyncDashboard({ action: 'read', type: 'workspace', workspace: '' }) as any;
    expect(result.success).toBe(false);
    expect(result.key).toBe('workspace-');
    expect(String(result.message)).toContain("introuvable");
    // Read ne crée jamais — et la garde ne doit pas transformer ce read en erreur.
    noFile('workspace-.md');
  });

  it("read workspace:'' d'une clé HISTORIQUE existante : contenu servi intact", async () => {
    // La clé parasite `workspace-` existe dans le store réel (#3537 §4) — elle
    // doit rester lisible par le seul canal qui la désigne : workspace:''.
    seedHistoricalEmptyKey();

    const result = await roosyncDashboard({ action: 'read', type: 'workspace', workspace: '' }) as any;
    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-');
    expect(JSON.stringify(result)).toContain('clé parasite recensée');
  });

  it("WRITE workspace:'' sur clé historique existante : mise à jour RÉUSSIE (jamais bloquée)", async () => {
    seedHistoricalEmptyKey();

    const result = await roosyncDashboard({
      action: 'write', type: 'workspace', workspace: '', content: '# status mis à jour'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-');
    expect(existsSync(path.join(dashboardsDir, 'workspace-.md'))).toBe(true);
    expect(readFileSync(path.join(dashboardsDir, 'workspace-.md'), 'utf8')).toContain('status mis à jour');
  });

  it("APPEND workspace:'' sur clé historique existante : message ajouté (jamais bloqué)", async () => {
    seedHistoricalEmptyKey();

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', workspace: '', content: 'message sur clé historique'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-');
    const onDisk = readFileSync(path.join(dashboardsDir, 'workspace-.md'), 'utf8');
    expect(onDisk).toContain('message sur clé historique');
    expect(onDisk).toContain('clé parasite recensée'); // le statut n'est pas écrasé par l'append
  });
});

describe('cross-post — indépendance des cibles (contrat #1363)', () => {
  it("cible workspace:'' → primaire réussit, cible rejetée par cible, exactement UN dual-write (le primaire)", async () => {
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      workspace: 'empty-key-guard-ok',
      content: 'message primaire',
      crossPost: [{ type: 'workspace', workspace: '' }]
    }) as any;

    // Le primaire n'est pas pénalisé par la cible refuseuse.
    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-empty-key-guard-ok');
    expect(String(result.message)).toContain('cross-post: 0/1 OK');
    expect(String(result.message)).toContain('1 échecs');
    expect(existsSync(path.join(dashboardsDir, 'workspace-empty-key-guard-ok.md'))).toBe(true);
    // La cible refuseuse n'a PAS créé son espace de noms fantôme.
    noFile('workspace-.md');
    // PREUVE : un seul passage dans le chemin dual-write PG — le primaire.
    // La cible refuseuse n'a atteint AUCUN writer (le throw précède l'écriture).
    expect(dualWriteSyncSpy).toHaveBeenCalledTimes(1);
  });
});
