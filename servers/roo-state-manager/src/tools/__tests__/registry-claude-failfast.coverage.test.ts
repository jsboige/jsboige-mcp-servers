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
    });

    test('non-régression: id Roo absent garde le fallback scan disque (#1325)', async () => {
        const result = await handler(summarizeRequest(ROO_ID));

        expect(result.isError).toBe(true);

        // Pour un id Roo, le fallback disque DOIT vivre (résolution Tier 1).
        expect(mockDetectStorageLocations).toHaveBeenCalledTimes(1);
        expect(mockAnalyzeConversation).not.toHaveBeenCalled(); // locations=[] → aucun chemin à analyser
        // Id Roo: jamais routé vers le détecteur Claude.
        expect(mockFindConversationById).not.toHaveBeenCalled();
    });

    // NOTE follow-up (découverte en écrivant ce test, hors périmètre du grain) :
    // summarize_type='cluster' sur un root claude-* déclenche AUSSI un scan disque
    // Roo via hierarchy-reconstruction-engine.ts:61 (buildHierarchicalSkeletonsLegacy
    // → detectStorageLocations), consommateur distinct du resolver registry. La
    // garde findChildTasks du registry couvre son propre bloc ; le moteur de
    // hiérarchie mérite la même analyse mais dépasse le grain #2191 (échec net
    // summarize) — consigné dans la PR, pas codé ici (chirurgical #1936).
});
