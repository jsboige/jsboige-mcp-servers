/**
 * #3537 §6.3 (borne vide) — garde création-seule dans createEmptyDashboard.
 *
 * La clé `workspace-` (nom vide) vit au rang de clé de plein droit dans le
 * store partagé (#3537 §4) : le schéma accepte `workspace: ""` et le `??` du
 * handler ne remplace pas une chaîne vide. Ces tests verrouillent que la
 * CRÉATION d'un espace de noms à nom vide/whitespace est refusée, à l'entrée
 * exacte où elle se produit (la fabrique), et que rien d'autre ne bouge :
 *
 *   - read d'une clé historique vide : SERVICE INTACT (le verrou
 *     « aucune lecture affectée » — vert avant ET après la garde) ;
 *   - cross-post vers une cible vide : attrapé par cible, l'append primaire
 *     réussit (contrat d'indépendance des cibles) ;
 *   - formes `(1)`, `.md.bak`, casse : JAMAIS refusées à la création — leur
 *     réconciliation relève de l'opération explicite §6.2, pas d'un rejet
 *     heuristique à la dérivation.
 *
 * Contre-épreuve : sans la garde dans la fabrique, les tests « refuses to
 * create » rougissent (l'appel crée le dashboard fantôme au lieu de jeter).
 *
 * Aucune écriture réelle : store = tmpdir jetable, gates PG désactivées,
 * writer NullUnifiedStoreWriter (UNIFIED_STORE_DUAL_WRITE/PG_URL absents).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { roosyncDashboard, createEmptyDashboard } from '../dashboard.js';

// #858 / #864: garder le client LLM (condensation) inert — pattern
// fail-closed-store.test.ts. Aucun appel ne doit y arriver.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

// Store jetable, unique par run : aucune écriture ne peut atteindre G:.
const STORE = path.join(
  path.resolve(os.tmpdir(), `roosync-emptykey-test-${Date.now()}-${process.pid}`),
  'shared-state'
);
const dashboardsDir = () => path.join(STORE, 'dashboards');
const noFile = (name: string) => expect(existsSync(path.join(dashboardsDir(), name))).toBe(false);

const author = { machineId: 'test-machine', workspace: 'test-workspace' };

beforeEach(() => {
  // Le store doit EXISTER : le fail-closed #3459 (assertSharedStoreAccessible)
  // coupe l'appel bien avant la branche de création si la racine est absente.
  mkdirSync(STORE, { recursive: true });
  process.env.ROOSYNC_SHARED_PATH = STORE;
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
});

afterEach(() => {
  delete process.env.ROOSYNC_SHARED_PATH;
  delete process.env.ROOSYNC_MACHINE_ID;
  delete process.env.ROOSYNC_WORKSPACE_ID;
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
  it("append workspace:'' → rejette, aucun fichier 'workspace-.md' créé", async () => {
    await expect(
      roosyncDashboard({ action: 'append', type: 'workspace', workspace: '', content: 'message' })
    ).rejects.toThrow(/nom vide/u);
    noFile('workspace-.md');
  });

  it("write workspace:'   ' → rejette (whitespace traverse ??), aucun fichier", async () => {
    await expect(
      roosyncDashboard({ action: 'write', type: 'workspace', workspace: '   ', content: '# status' })
    ).rejects.toThrow(/nom vide/u);
    noFile('workspace-.md');
    noFile('workspace-   .md');
  });

  it("append machineId:'' → rejette, aucun fichier 'machine-.md'", async () => {
    await expect(
      roosyncDashboard({ action: 'append', type: 'machine', machineId: '', content: 'message' })
    ).rejects.toThrow(/nom vide/u);
    noFile('machine-.md');
  });
});

describe('verrou « aucune lecture affectée » — comportement AVANT/Après identique', () => {
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
    mkdirSync(dashboardsDir(), { recursive: true });
    writeFileSync(path.join(dashboardsDir(), 'workspace-.md'),
      `---
type: workspace
lastModified: 2026-09-05T17:02:00.000Z
---

## Status

*Historique figé — clé parasite recensée #3537.*

## Intercom (0 messages)

*Aucun message.*
`, 'utf8');

    const result = await roosyncDashboard({ action: 'read', type: 'workspace', workspace: '' }) as any;
    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-');
    expect(JSON.stringify(result)).toContain('clé parasite recensée');
  });
});

describe('cross-post — indépendance des cibles (contrat #1363)', () => {
  it("cible workspace:'' → primaire réussit, cible rejetée par cible, aucun fork de fichier", async () => {
    // Store partagé entre tests du fichier : purger le fixture historique pour
    // que la cible 'workspace-' soit bien MANQUANTE et passe par la création.
    const phantom = path.join(dashboardsDir(), 'workspace-.md');
    if (existsSync(phantom)) rmSync(phantom);

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
    expect(existsSync(path.join(dashboardsDir(), 'workspace-empty-key-guard-ok.md'))).toBe(true);
    // La cible refuseuse n'a PAS créé son espace de noms fantôme.
    noFile('workspace-.md');
  });
});
