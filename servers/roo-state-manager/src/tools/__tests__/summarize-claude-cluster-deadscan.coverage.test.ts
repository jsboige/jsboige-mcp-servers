/**
 * #2191 follow-up — plus de scan mort sur summarize cluster source=claude.
 *
 * Bug mesuré (web1 c.573, spies nommés) : `createChildTasksFinder('claude')`
 * (roosync-summarize.tool.ts) scannait CHAQUE projet Claude local —
 * `analyzeConversation('dummy', projectPath)` par projet, plus
 * `detectStorageLocations()` par projet « trouvé » — pour remplir une liste
 * `allTasks` qui n'était JAMAIS remplie : retour [] garanti, coût
 * detect×2 + listProjects×2 + analyze×7 par requête cluster (sur le mock
 * 2 locations × 3 projets ; sur un vrai siège, ∝ nombre de projets), PUIS
 * rejet si un détecteur jetait. Le chemin se déclenche aussi via
 * conversation-browser `source:'all'` auto-détecté 'claude' sur un id
 * claude-* (conversation-browser.ts:596-598).
 *
 * Ce test verrouille le contrat : cluster source=claude rend le même
 * résultat (root, zéro enfant — le contrat [] d'avant) SANS aucun travail
 * détecteur au-delà de la résolution du root par le getter.
 *
 * Framework: Vitest (coverage, add-only #1936)
 *
 * @module tools/__tests__/summarize-claude-cluster-deadscan.coverage
 * @version 1.0.0 (#2191)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (ESM) -------------------------------------------------
const {
    mockRooDetect,
    mockClaudeDetect,
    mockClaudeAnalyze,
    mockListProjects,
    mockFindConversationById,
    mockHydrateTier3
} = vi.hoisted(() => ({
    mockRooDetect: vi.fn(),
    mockClaudeDetect: vi.fn(),
    mockClaudeAnalyze: vi.fn(),
    mockListProjects: vi.fn(),
    mockFindConversationById: vi.fn(),
    mockHydrateTier3: vi.fn()
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: class {
        static detectStorageLocations = mockRooDetect;
        static analyzeConversation = vi.fn(async () => null);
    }
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: class {
        static detectStorageLocations = mockClaudeDetect;
        static analyzeConversation = mockClaudeAnalyze;
        static listProjects = mockListProjects;
        static findConversationById = mockFindConversationById;
    }
}));

vi.mock('../../utils/server-helpers.js', () => ({
    resolveFullConversationSkeleton: vi.fn(async () => null),
    hydrateTier3SkeletonFromCache: mockHydrateTier3
}));

// Delegates hors-summarize — isoler la chaîne sans mocker
// roosync-summarize.tool.js : le chemin réel du grain passe par lui.
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
import { ConversationSkeleton } from '../../types/conversation.js';

const CLAUDE_ID = 'claude-c--dev-Cov--6b175c67-1f2a-4c3d-9e4f-0a1b2c3d4e5f';

function makeRoot(): ConversationSkeleton {
    return {
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
}

describe('#2191 follow-up — cluster source=claude: zéro scan mort, contrat [] préservé', () => {
    let mockServer: any;
    let mockState: any;
    let handler: (request: any) => Promise<any>;

    function clusterRequest(source?: string): any {
        const args: Record<string, unknown> = {
            action: 'summarize',
            task_id: CLAUDE_ID,
            summarize_type: 'cluster'
        };
        if (source !== undefined) args.source = source;
        return { params: { name: 'conversation_browser', arguments: args } };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        // Deux locations × trois projets : la matrice exacte du diagnostic
        // c.573 qui produisait detect×2 + listProjects×2 + analyze('dummy')×6.
        mockClaudeDetect.mockResolvedValue([
            { projectName: 'c--dev-Cov', projectPath: 'X:/mock/proj', path: 'X:/mock' },
            { projectName: 'c--dev-Autre', projectPath: 'X:/mock/proj2', path: 'X:/mock' }
        ]);
        mockClaudeAnalyze.mockImplementation(async (taskId: string) =>
            taskId === CLAUDE_ID ? makeRoot() : null
        );
        mockListProjects.mockResolvedValue(['c--dev-Cov', 'c--dev-Autre', 'c--dev-Troisieme']);
        mockRooDetect.mockResolvedValue([]);
        mockFindConversationById.mockResolvedValue(null);
        mockHydrateTier3.mockResolvedValue(null);

        mockServer = { setRequestHandler: vi.fn() };
        mockState = {
            conversationCache: new Map<string, ConversationSkeleton>(),
            qdrantIndexQueue: new Set<string>(),
            isQdrantIndexingEnabled: false
        };
        registerCallToolHandler(
            mockServer,
            mockState,
            vi.fn(async () => ({ content: [{ type: 'text', text: 'x' }] })),
            vi.fn(async () => {}),
            vi.fn(async () => {})
        );
        handler = mockServer.setRequestHandler.mock.calls[0][1];
    });

    test('cluster source=claude: résultat rendu, AUCUN scan projet (finder mort retiré)', async () => {
        const result = await handler(clusterRequest('claude'));

        // Le cluster rend — root résolu par le getter, enfants = [] (contrat
        // d'avant le fix : allTasks n'était jamais remplie).
        expect(result).toBeDefined();
        expect(result.isError).not.toBe(true);
        const text: string = result.content?.[0]?.text ?? '';
        expect(text).toContain(CLAUDE_ID);

        // Le cœur du fix : le finder ne touche plus le disque projet.
        expect(mockListProjects).not.toHaveBeenCalled();
        expect(mockClaudeAnalyze.mock.calls.filter(c => c[0] === 'dummy')).toHaveLength(0);
        // Le getter résout le root : UN detect (pas deux) et UN analyze utile.
        expect(mockClaudeDetect).toHaveBeenCalledTimes(1);
        expect(mockClaudeAnalyze).toHaveBeenCalledTimes(1);
    }, 60_000);

    test('source=all sur id claude-* (auto-détection claude, conversation-browser:596): même zéro scan projet', async () => {
        const result = await handler(clusterRequest('all'));

        expect(result).toBeDefined();
        expect(result.isError).not.toBe(true);
        expect(mockListProjects).not.toHaveBeenCalled();
        expect(mockClaudeAnalyze.mock.calls.filter(c => c[0] === 'dummy')).toHaveLength(0);
    }, 60_000);
});