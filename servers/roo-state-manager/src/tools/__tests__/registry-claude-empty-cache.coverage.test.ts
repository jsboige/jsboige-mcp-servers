/**
 * #2307 (résolveur frère) — header claude-* en cache à messageCount=0 ne doit
 * plus court-circuiter le chargement Claude.
 *
 * Bug (point 2 du rapport #2307 c.6282664942, dispatch ai-01 c.33 23:03Z) :
 * le resolver inline de conversation_browser (registry.ts) rend
 * `{...cached, sequence: []}` dès qu'un header en cache porte
 * `messageCount === 0` — AVANT la branche `claude-*` (étape 2), qui aurait pu
 * charger la conversation réelle via ClaudeStorageDetector. Résultat : vue /
 * résumé vide sur une session Claude indexée à 0 (p.ex. session ayant grandi
 * après indexation). Même signature dans le miroir view-details.tool.ts :
 * `needsClaudeLoad` exige `messageCount > 0`, un header claude-* à 0 ne
 * déclenche jamais le detector.
 *
 * Ce test verrouille l'ordre corrigé : pour un id claude-* avec header en
 * cache à messageCount=0, le detector est consulté AVANT de rendre un
 * squelette vide ; si le detector rend une séquence, elle est servie et mise
 * en cache. Chemin réel CallTool handler → registry resolver → summarize,
 * seuls les détecteurs disque et delegates hors-summarize sont mockés
 * (harnais jumeau de registry-claude-failfast.coverage.test.ts, #2191).
 *
 * Framework: Vitest (coverage, add-only #1936)
 *
 * @module tools/__tests__/registry-claude-empty-cache.coverage
 * @version 1.0.0 (#2307)
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

vi.mock('../../utils/server-helpers.js', () => ({
    resolveFullConversationSkeleton: vi.fn(async () => null),
    hydrateTier3SkeletonFromCache: mockHydrateTier3
}));

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

const CLAUDE_ID = 'claude-c--dev-CoursIA-2--6b175c67-1f2a-4c3d-9e4f-0a1b2c3d4e5f';

/** Header en cache tel que le scanner l'indexe pour une session vide/à 0 : pas de séquence, messageCount=0. */
function makeEmptyHeader(): ConversationSkeleton {
    return {
        taskId: CLAUDE_ID,
        metadata: {
            taskId: CLAUDE_ID,
            title: 'indexed-empty',
            workspace: 'test',
            dataSource: 'claude',
            messageCount: 0,
            totalSize: 0,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString()
        }
    } as any;
}

/** Conversation Claude réelle que le detector SAIT charger (fichier lisible, séquence non vide). */
function makeRealClaudeSkeleton(): ConversationSkeleton {
    return {
        taskId: CLAUDE_ID,
        sequence: [
            { role: 'user', content: 'real message from disk', timestamp: new Date().toISOString(), isTruncated: false },
            { role: 'assistant', content: 'real answer', timestamp: new Date().toISOString(), isTruncated: false }
        ],
        metadata: {
            taskId: CLAUDE_ID,
            title: 'real-session',
            workspace: 'test',
            dataSource: 'claude',
            messageCount: 2,
            totalSize: 64,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString()
        }
    } as any;
}

describe('#2307 — resolver: header claude-* en cache à messageCount=0 → detector consulté avant squelette vide', () => {
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
        mockHydrateTier3.mockResolvedValue(null);

        mockServer = { setRequestHandler: vi.fn() };
        mockState = {
            conversationCache: new Map<string, ConversationSkeleton>(),
            qdrantIndexQueue: new Set<string>(),
            isQdrantIndexingEnabled: false,
            xmlExporterService: {},
            exportConfigManager: {}
        } as any;

        // Header indexé à 0 dans le cache + conversation réelle disponible au detector.
        mockState.conversationCache.set(CLAUDE_ID, makeEmptyHeader());
        mockFindConversationById.mockResolvedValue(makeRealClaudeSkeleton());

        registerCallToolHandler(
            mockServer,
            mockState,
            vi.fn(async () => ({ content: [{ type: 'text', text: 'Settings touched' }] })),
            vi.fn(async () => {}),
            vi.fn(async () => {})
        );
        handler = mockServer.setRequestHandler.mock.calls[0][1];
    });

    // Timeout 60s : cf. #2191 — chargement du graphe réel roosync-summarize.
    test('le detector est consulté, la séquence réelle atterrit en cache', async () => {
        const result = await handler(summarizeRequest(CLAUDE_ID));

        // Le cœur du bug : sur main, le cached-branch rend {...cached, sequence: []}
        // AVANT l'étape claude-* → detector jamais appelé.
        expect(mockFindConversationById).toHaveBeenCalledWith(CLAUDE_ID);

        // La séquence réelle est servie puis mise en cache (comme l'étape 2 le
        // fait déjà pour un id absent du cache) — pas un squelette vide.
        const cachedAfter = mockState.conversationCache.get(CLAUDE_ID) as any;
        expect(Array.isArray(cachedAfter?.sequence)).toBe(true);
        expect(cachedAfter.sequence.length).toBeGreaterThan(0);

        // Le résumé rendu n'est pas une erreur.
        expect(result.isError).toBeFalsy();
    }, 60_000);

    test('detector muet (null) → comportement inchangé : header vide rendu, pas de scan Roo', async () => {
        mockFindConversationById.mockResolvedValue(null);

        const result = await handler(summarizeRequest(CLAUDE_ID));

        // Le detector est bien consulté (nouvel ordre)…
        expect(mockFindConversationById).toHaveBeenCalledWith(CLAUDE_ID);
        // …mais l'absence de conversation réelle retombe sur l'ancien comportement :
        // header vide rendu, et pour claude-* jamais de scan disque Roo (#2191).
        expect(mockDetectStorageLocations).not.toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
    }, 60_000);

    test('non-régression: id Roo en cache à messageCount=0 → comportement inchangé (header rendu, ni detector ni scan)', async () => {
        const ROO_ID = '18f47c2b665b8a1f';
        const rooHeader = { ...makeEmptyHeader(), taskId: ROO_ID, metadata: { ...makeEmptyHeader().metadata, taskId: ROO_ID, dataSource: undefined } } as any;
        mockState.conversationCache.set(ROO_ID, rooHeader);
        mockFindConversationById.mockClear();

        await handler(summarizeRequest(ROO_ID));

        // Id Roo : jamais routé vers le detector Claude. Le cached-branch rend
        // le header tel quel (comportement pré-existant, inchangé par ce fix —
        // le fallback disque #1325 ne vit que pour un id ABSENT du cache).
        expect(mockFindConversationById).not.toHaveBeenCalledWith(ROO_ID);
        expect(mockDetectStorageLocations).not.toHaveBeenCalled();
    }, 60_000);
});

describe('#2307 — miroir view_task_details: header claude-* à messageCount=0 → detector consulté', () => {
    // Le miroir cité par ai-01 : needsClaudeLoad exigeait messageCount > 0,
    // un header claude-* indexé à 0 ne déclenchait jamais le chargement.
    test('le detector est consulté et la séquence réelle adoptée', async () => {
        const { viewTaskDetailsTool } = await import('../conversation/view-details.tool.js');
        const cache = new Map<string, ConversationSkeleton>();
        cache.set(CLAUDE_ID, makeEmptyHeader());
        mockFindConversationById.mockResolvedValue(makeRealClaudeSkeleton());

        await viewTaskDetailsTool.handler({ task_id: CLAUDE_ID }, cache);

        expect(mockFindConversationById).toHaveBeenCalledWith(CLAUDE_ID);
        const cachedAfter = cache.get(CLAUDE_ID) as any;
        expect(Array.isArray(cachedAfter?.sequence)).toBe(true);
        expect(cachedAfter.sequence.length).toBeGreaterThan(0);
    });
});
