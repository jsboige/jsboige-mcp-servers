/**
 * #4104 — contentPattern : le filtre doit être VISIBLE dans la réponse.
 *
 * Constat fondateur (banc #2609, run 07/10, ai-01) : `list` avec
 * `contentPattern: 'roosync'` retourne 10 conversations dont AUCUNE ne
 * contient le motif dans sa forme sérialisée. Mécanisme : matchesContentPattern
 * cherche le motif PROFOND dans le contenu (sequence en mémoire, archive via
 * lecture bornée, historique Roo via disque — contrat #1244 volontaire, « une
 * recherche par contenu ne rend JAMAIS un faux négatif silencieux »), mais le
 * SkeletonNode n'expose que des previews (premier/dernier message, 900/500
 * cars) — un match en milieu de conversation y est invisible. Le consommateur
 * (agent, banc) ne peut ni voir POURQUOI une conversation a survécu au filtre,
 * ni distinguer « filtre appliqué » de « filtre ignoré ».
 *
 * Ce test fixe le contrat opérationnel : quand contentPattern est actif, chaque
 * nœud retourné porte un `contentMatch` { field, snippet } dont l'extrait
 * CONTIENT le motif — la réponse est auto-évidente. Le contrat de recherche
 * profonde #1244 est préservé (pas de restriction aux seuls champs visibles).
 *
 * Le tier PG est alimenté simultanément : ses lignes ne matchent que par label
 * (title/truncatedInstruction) au niveau list — une ligne dont le motif n'est
 * que dans le contenu profond (indisponible à ce niveau) doit être EXCLUE
 * (fail-closed), jamais retournée hors-motif.
 *
 * @issue roo-extensions#4104 (banc #2609 scenario list)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock hoisted (avant tout vi.mock) ---
const { mockHomedir, mockPgRows, mockGetUnifiedStoreReader } = vi.hoisted(() => ({
  mockHomedir: vi.fn(() => '/Users/test'),
  mockPgRows: vi.fn(() => [] as Array<Record<string, unknown>>),
  mockGetUnifiedStoreReader: vi.fn(),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: { ...actual, homedir: mockHomedir },
    homedir: mockHomedir,
  };
});

// fs/promises partiel — le SUT ne doit toucher le disque que si un test le branche.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
  };
});

// Chemins résolus DEPUIS LE RÉPERTOIRE DU SUT (src/tools/conversation/), pas
// depuis ce fichier de test — leçon #2642 : un même littéral ne résout pas pareil.
vi.mock('../../task/disk-scanner.js', () => ({
  scanDiskForNewTasks: vi.fn(() => Promise.resolve([])),
  evictGoneLocalTasks: vi.fn(async () => ({ evicted: [], skippedRemote: 0, failOpenRoo: true, failOpenClaude: true })),
}));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
  ClaudeStorageDetector: {
    detectStorageLocations: vi.fn(() => Promise.resolve([])),
    analyzeConversation: vi.fn(),
  },
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(() => Promise.resolve([])),
  },
}));

// Tier 3 borné — non sollicité ici (includeArchives absent), mock défensif.
const { mockReadArchivedTaskFromPath } = vi.hoisted(() => ({
  mockReadArchivedTaskFromPath: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../../services/task-archiver/index.js', () => ({
  TaskArchiver: {
    listArchivedTaskFiles: vi.fn(() => Promise.resolve([])),
    readArchivedTaskFromPath: mockReadArchivedTaskFromPath,
  },
}));

// Cache Tier 3 vide, aucune archive en cours de chargement.
const { mockGetCache, mockImmediateCache, mockGetInstance, mockAwaitFreshness, mockGetCacheAge, mockIsLoadInProgress, mockTier3KnowsMachine } = vi.hoisted(() => {
  const cacheFn = vi.fn(() => Promise.resolve(new Map()));
  const immediateFn = vi.fn(() => new Map());
  const awaitFn = vi.fn(() => Promise.resolve(true));
  const ageFn = vi.fn(() => 1234);
  const loadInProgressFn = vi.fn(() => false);
  const knowsMachineFn = vi.fn(() => true);
  return {
    mockGetCache: cacheFn,
    mockImmediateCache: immediateFn,
    mockAwaitFreshness: awaitFn,
    mockGetCacheAge: ageFn,
    mockIsLoadInProgress: loadInProgressFn,
    mockTier3KnowsMachine: knowsMachineFn,
    mockGetInstance: vi.fn(() => ({ getCache: cacheFn, getCacheImmediate: immediateFn, awaitFreshnessWithBudget: awaitFn, getCacheAgeMs: ageFn, isLoadInProgress: loadInProgressFn, tier3KnowsMachine: knowsMachineFn })),
  };
});
vi.mock('../../../services/skeleton-cache.service.js', () => ({
  SkeletonCacheService: {
    getInstance: mockGetInstance,
  },
}));

// Tier PG — la factory réelle est remplacée par un reader stub dont
// listConversations sert les lignes du test. La vraie logique du store
// (mapRowToSkeleton / resolveLabel / dédoublonnage) tourne, seule la
// connexion est factice.
vi.mock('../../../services/unified-store/reader-factory.js', () => ({
  getUnifiedStoreReader: mockGetUnifiedStoreReader,
}));

import { listConversationsTool } from '../list-conversations.tool.js';

/** Extraction du tableau de conversations, même normalisation que le banc. */
function parseConversations(result: { content: Array<{ type: string; text?: string }> }): any[] {
  const text = result.content[0].text as string;
  const parsed = JSON.parse(text);
  return parsed.conversations ?? parsed;
}

describe('#4104 — contentPattern appliqué ET visible (tiers fichier + PG)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue('/Users/test');
    process.env.UNIFIED_STORE_CONVERSATION_READ_PG = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgresql://stub/test';
    mockGetUnifiedStoreReader.mockReturnValue({
      isNull: () => false,
      init: async () => {},
      listConversations: async () => mockPgRows(),
    });
  });

  afterEach(() => {
    delete process.env.UNIFIED_STORE_CONVERSATION_READ_PG;
    delete process.env.UNIFIED_STORE_PG_URL;
    vi.restoreAllMocks();
  });

  it("toute conversation retournée porte le motif de façon VISIBLE (contentMatch), match profond inclus", async () => {
    // Tier fichier : session Claude locale. Le motif est AU MILIEU de la
    // séquence — invisible dans title / premier / dernier message (previews).
    // C'est le profil exact des 10 survivants hors-motif du banc #2609.
    const deepMatch = {
      taskId: 'claude-deep-match',
      metadata: {
        title: 'Refactor du pipeline de build',   // PAS le motif
        lastActivity: '2026-10-07T08:00:00.000Z',
        createdAt: '2026-10-06T08:00:00.000Z',
        messageCount: 4,
        actionCount: 0,
        totalSize: 1000,
      },
      sequence: [
        { role: 'user', content: 'Peux-tu refactorer le pipeline de build ?' },
        { role: 'assistant', content: 'Je commence par lire la configuration actuelle.' },
        { role: 'user', content: 'Au passage, vérifie que le dashboard roosync reste cohérent après le refactor.' },
        { role: 'user', content: 'Merci, ça ira pour aujourd\'hui.' },
        { role: 'assistant', content: 'C\'est terminé, le pipeline est refactoré.' },
      ],
    };
    const noMatch = {
      taskId: 'claude-no-match',
      metadata: {
        title: 'Session sans rapport',
        lastActivity: '2026-10-07T07:00:00.000Z',
        createdAt: '2026-10-06T07:00:00.000Z',
        messageCount: 1,
        actionCount: 0,
        totalSize: 100,
      },
      sequence: [{ role: 'user', content: 'Rien à voir avec le motif recherché.' }],
    };
    const cache = new Map<string, any>([
      [deepMatch.taskId, deepMatch],
      [noMatch.taskId, noMatch],
    ]);

    // Tier PG : une ligne dont le LABEL porte le motif (match fast-path,
    // visible via title/firstUserMessage), une ligne dont le motif n'existe
    // que dans le contenu profond — indisponible au niveau list, elle doit
    // être EXCLUE (fail-closed), jamais retournée hors-motif.
    mockPgRows.mockReturnValue([
      {
        task_id: 'task-pg-label-match',
        title: 'Notes de déploiement roosync',
        metadata: null,
        first_user_message: 'Premier message',
        last_ts: '2026-10-07T06:00:00Z',
        first_ts: '2026-10-06T06:00:00Z',
        ingested_at: '2026-10-07T06:00:00Z',
        msg_count: 3,
        workspace: null,
        machine_id: 'stub-machine',
        harness: 'claude',
        parent_task_id: null,
      },
      {
        task_id: 'task-pg-deep-only',
        title: 'Titre quelconque',
        metadata: null,
        first_user_message: 'Contenu sans le motif ici',
        last_ts: '2026-10-05T06:00:00Z',
        first_ts: '2026-10-05T06:00:00Z',
        ingested_at: '2026-10-05T06:00:00Z',
        msg_count: 9,
        workspace: null,
        machine_id: 'stub-machine',
        harness: 'claude',
        parent_task_id: null,
      },
    ]);

    const result = await listConversationsTool.handler(
      { contentPattern: 'roosync' },
      cache,
    );
    const conversations = parseConversations(result);

    // Le filtre garde exactement les deux conversations qui matchent.
    expect(conversations).toHaveLength(2);
    const ids = conversations.map((c: any) => c.taskId).sort();
    expect(ids).toEqual(['claude-deep-match', 'task-pg-label-match']);

    // Contrat opérationnel du banc #2609 : TOUTE conversation retournée
    // contient le motif dans sa forme sérialisée. Avant le fix, le nœud du
    // match profond ne porte le motif nulle part (title/previews hors-motif).
    for (const c of conversations) {
      const serialized = JSON.stringify(c).toLowerCase();
      expect(serialized.includes('roosync')).toBe(true);
    }

    // Le match profond est EXPLICITE : le nœud porte un contentMatch dont
    // l'extrait contient le motif (où il a été trouvé, pas seulement qu'il
    // l'a été).
    const deep = conversations.find((c: any) => c.taskId === 'claude-deep-match');
    expect(deep.contentMatch).toBeDefined();
    expect(deep.contentMatch.field).toBe('sequence');
    expect(deep.contentMatch.snippet.toLowerCase()).toContain('roosync');
    expect(deep.contentMatch.snippet.toLowerCase()).toContain('dashboard');

    // Le match fast-path PG porte aussi son contentMatch.
    const pg = conversations.find((c: any) => c.taskId === 'task-pg-label-match');
    expect(pg.contentMatch).toBeDefined();
    expect(pg.contentMatch.snippet.toLowerCase()).toContain('roosync');
  });

  it('sans contentPattern, aucun contentMatch n\'est ajouté (comportement inchangé)', async () => {
    const session = {
      taskId: 'claude-plain',
      metadata: {
        title: 'Session ordinaire',
        lastActivity: '2026-10-07T08:00:00.000Z',
        createdAt: '2026-10-06T08:00:00.000Z',
        messageCount: 1,
        actionCount: 0,
        totalSize: 100,
      },
      sequence: [{ role: 'user', content: 'Bonjour' }],
    };
    const result = await listConversationsTool.handler({}, new Map<string, any>([[session.taskId, session]]));
    const conversations = parseConversations(result);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].contentMatch).toBeUndefined();
  });
});
