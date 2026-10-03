/**
 * #2191 — fail-fast du resolver conversation_browser pour les ids claude-*.
 *
 * Bug mesuré (web1 c.568, rapporté par ai-01 02/10 19:10Z) : summarize sur un
 * id claude-* non résoluble (absent localement, sans stub Tier 3) paie le
 * fallback scan disque Roo du resolver (registry.ts étape 3) alors qu'un id
 * claude-* ne peut JAMAIS vivre dans tasks/ Roo (ids Roo = timestamps hex).
 * detectStorageLocations() globe globalStorage — des secondes à dizaines de
 * secondes sur un siège Roo chargé — pendant que le timeout dur #1262 (30 s)
 * frappe avant le CONVERSATION_NOT_FOUND net.
 *
 * Ce test verrouille la garde : pour claude-*, le scan Roo ne doit JAMAIS
 * courir (échec immédiat) ; pour un id Roo, le fallback DOIT vivre
 * (non-régression #1325). Chemin réel de bout en bout : CallTool handler →
 * registry resolver → handleRooSyncSummarize → dispatchTraceHandler →
 * handleGenerateTraceSummary (throw CONVERSATION_NOT_FOUND) — seuls les
 * détecteurs disque et les delegates hors-summarize sont mockés.
 *
 * Framework: Vitest (coverage, add-only #1936)
 *
 * @module tools/__tests__/registry-claude-failfast.coverage
 * @version 1.0.0 (#2191)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (ESM) -------------------------------------------------
const {
    mockDetectStorageLocations,
    mockAnalyzeConversation,
    mockFindConversationById,
    mockHydrateTier3
} = vi.hoisted(() => ({
    mockDetectStorageLocations: vi.fn(),
    mockAnalyzeConversation: vi.fn(),
    mockFindConversationById: vi.fn(),
    mockHydrateTier3: vi.fn()
}));

// Détecteurs disque — spies : le compte d'appels EST l'assert central.
vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: class {
        static detectStorageLocations = mockDetectStorageLocations;
        static analyzeConversation = mockAnalyzeConversation;
    }
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: class {
        static findConversationById = mockFindConversationById;
    }
}));

// server-helpers : hydrateTier3 isolé (pas de SkeletonCacheService réel) ;
// resolveFullConversationSkeleton n'est pas sur le chemin summarize (il sert
// export_data/task_export) — mock factice suffisant pour l'import registry.
vi.mock('../../utils/server-helpers.js', () => ({
    resolveFullConversationSkeleton: vi.fn(async () => null),
    hydrateTier3SkeletonFromCache: mockHydrateTier3
}));

// Delegates hors-summarize de conversation-browser — isoler la chaîne lourde
// SANS mocker roosync-summarize.tool.js : le chemin réel du grain passe par lui.
vi.mock('../task/browse.js', () => ({
    handleTaskBrowse: vi.fn(async () => ({ content: [{ type: 'text', text: 'browse' }] }))
}));
vi.mock('../view-conversation-tree.js', () => ({
    viewConversationTree: { handler: vi.fn(async () => ({ content: [{ type: 'text', text: 'tree' }] })) }
}));
vi.mock('../summary/get-conversation-synthesis.tool.js', () => ({
    handleGetConversationSynthesis: vi.fn(async () => 'synthesis')
}));

import { registerCallToolHandler } from '../registry.js';
import { ServerState } from '../../services/state-manager.service.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Id au format réel des sessions Claude Code (projet -- uuid).
const CLAUDE_ID = 'claude-c--dev-CoursIA-2--6b175c67-1f2a-4c3d-9e4f-0a1b2c3d4e5f';
// Id au format Roo (timestamp hex).
const ROO_ID = '18f47c2b665b8a1f';

describe('#2191 — resolver conversation_browser: pas de scan Roo pour claude-*', () => {
    let mockServer: any;
    let mockState: ServerState;
    let handler: (request: any) => Promise<any>;

    function summarizeRequest(taskId: string): any {
        return {
            params: {
                name: 'conversation_browser',
                arguments: {
                    action: 'summarize',
                    task_id: taskId,
                    summarize_type: 'trace'
                }
            }
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockDetectStorageLocations.mockResolvedValue([]);
        mockAnalyzeConversation.mockResolvedValue(null);
        mockFindConversationById.mockResolvedValue(null);
        mockHydrateTier3.mockResolvedValue(null);

        mockServer = { setRequestHandler: vi.fn() };
        mockState = {
            conversationCache: new Map<string, ConversationSkeleton>(),
            qdrantIndexQueue: new Set<string>(),
            isQdrantIndexingEnabled: false,
            xmlExporterService: {},
            exportConfigManager: {}
        } as any;

        registerCallToolHandler(
            mockServer,
            mockState,
            vi.fn(async () => ({ content: [{ type: 'text', text: 'Settings touched' }] })),
            vi.fn(async () => {}),
            vi.fn(async () => {})
        );
        handler = mockServer.setRequestHandler.mock.calls[0][1];
    });

    // Timeout 60s : ce test charge le graphe réel roosync-summarize (import
    // dynamique de ~1000 modules). ~2s à froid seul, >15s (timeout défaut)
    // mesuré quand le fichier tombe dans la tempête de cold-transform du
    // début de suite CI pleine (c.572) — borne haute, pas nouvelle attente.
    test('summarize sur id claude-* non résoluble: échec net, AUCUN scan Roo', async () => {
        const result = await handler(summarizeRequest(CLAUDE_ID));

        // L'échec est rendu (isError), pas un timeout #1262.
        expect(result.isError).toBe(true);
        const text: string = result.content?.[0]?.text ?? '';
        expect(text).toContain('introuvable');

        // Le cœur du fix : le glob globalStorage ne court jamais pour claude-*.
        expect(mockDetectStorageLocations).not.toHaveBeenCalled();
        expect(mockAnalyzeConversation).not.toHaveBeenCalled();

        // Les étapes légitimes du resolver ont bien couru avant l'échec.
        expect(mockFindConversationById).toHaveBeenCalledWith(CLAUDE_ID);
        expect(mockHydrateTier3).toHaveBeenCalledWith(CLAUDE_ID, mockState.conversationCache);
    }, 60_000);

    test('non-régression: id Roo absent garde le fallback scan disque (#1325)', async () => {
        const result = await handler(summarizeRequest(ROO_ID));

        expect(result.isError).toBe(true);

        // Pour un id Roo, le fallback disque DOIT vivre (résolution Tier 1).
        expect(mockDetectStorageLocations).toHaveBeenCalledTimes(1);
        expect(mockAnalyzeConversation).not.toHaveBeenCalled(); // locations=[] → aucun chemin à analyser
        // Id Roo: jamais routé vers le détecteur Claude. Assertion scopée sur
        // l'argument : si le test précédent dépasse son timeout, sa continuation
        // zombie peut appeler le détecteur avec un id claude-* APRÈS le
        // clearAllMocks de ce beforeEach — hors du périmètre de cette propriété
        // (mesuré c.572 : échec fantôme sur ce test, cause = test 1 timed out).
        expect(mockFindConversationById).not.toHaveBeenCalledWith(ROO_ID);
    });

    test('#2191 follow-up: cluster sur racine claude-* — aucun scan disque (ExportConfigManager lazy)', async () => {
        // Diagnostic stack complet (c.572) : le scan du chemin cluster venait du
        // CONSTRUCTEUR d'ExportConfigManager (initializeConfigPath →
        // detectStorageLocations, fire-and-forget) instancié par
        // generate-cluster-summary.tool.ts:235 — pas de l'engine de hiérarchie
        // (inférence initiale c.571, corrigée par la mesure). Le constructeur
        // étant désormais vide, le chemin cluster d'une racine claude-* ne
        // touche plus le disque Roo : le root est servi par le cache RAM, les
        // enfants par le cache RAM (garde findChildTasks #1328).
        const root: ConversationSkeleton = {
            taskId: CLAUDE_ID,
            sequence: [{ role: 'user', content: 'hello' } as any],
            metadata: {
                taskId: CLAUDE_ID,
                title: 'root',
                workspace: 'test',
                dataSource: 'claude',
                messageCount: 1,
                totalSize: 10,
                createdAt: new Date().toISOString(),
                lastActivity: new Date().toISOString()
            }
        } as any;
        mockState.conversationCache.set(CLAUDE_ID, root);

        const request = {
            params: {
                name: 'conversation_browser',
                arguments: {
                    action: 'summarize',
                    task_id: CLAUDE_ID,
                    summarize_type: 'cluster'
                }
            }
        };
        const result = await handler(request);

        // Le cluster a rendu (sortie ou erreur du service — sans I/O disque).
        expect(result).toBeDefined();

        // Zéro glob sur tout le chemin : resolver (garde #1328) ET
        // ExportConfigManager (lazy, ce fix).
        expect(mockDetectStorageLocations).not.toHaveBeenCalled();
        expect(mockFindConversationById).not.toHaveBeenCalled();
    }, 60_000);
});
