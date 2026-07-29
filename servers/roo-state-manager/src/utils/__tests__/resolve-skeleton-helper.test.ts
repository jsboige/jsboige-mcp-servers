/**
 * Tests pour resolveFullConversationSkeleton (helper #3007).
 *
 * Le bug initial : `registry.ts` passait `cache.get(id) || null` comme callback
 * `getConversationSkeleton` pour `export_data` et `task_export`. Le cache ne contient
 * que des `SkeletonHeader` (sans `sequence`), donc l'export XML sortait avec
 * `<sequence/>` vide peu importe `includeContent`. Ce helper est la résolution
 * correcte : Tier 2/3 (cache hit avec sequence complète) → disk fallback Tier 1
 * (loadFullSkeleton) → RooStorageDetector.analyzeConversation → null.
 *
 * Framework: Vitest
 *
 * @module utils/resolve-skeleton-helper.test
 * @version 1.0.0 (#3007)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { resolveFullConversationSkeleton } from '../server-helpers.js';
import { ConversationSkeleton, SkeletonHeader } from '../../types/conversation.js';

// Mock RooStorageDetector via vi.mock pour éviter l'I/O disque réel.
const { mockDetectStorageLocations, mockAnalyzeConversation } = vi.hoisted(() => ({
    mockDetectStorageLocations: vi.fn(),
    mockAnalyzeConversation: vi.fn()
}));

vi.mock('../roo-storage-detector.js', () => ({
    RooStorageDetector: class {
        static detectStorageLocations = mockDetectStorageLocations;
        static analyzeConversation = mockAnalyzeConversation;
    }
}));

// Mock background-services pour éviter la dépendance au storage réel.
const { mockLoadFullSkeleton } = vi.hoisted(() => ({
    mockLoadFullSkeleton: vi.fn()
}));

vi.mock('../../services/background-services.js', () => ({
    loadFullSkeleton: mockLoadFullSkeleton
}));

// Mock ClaudeStorageDetector pour la branche claude-* (#3007 ai-01 review).
// findConversationById lit le store JSONL Claude ; on l'isole pour tester la
// branche claude- sans I/O réel.
const { mockFindConversationById } = vi.hoisted(() => ({
    mockFindConversationById: vi.fn()
}));

vi.mock('../claude-storage-detector.js', () => ({
    ClaudeStorageDetector: class {
        static findConversationById = mockFindConversationById;
    }
}));

describe('resolveFullConversationSkeleton — #3007 helper', () => {
    let cache: Map<string, SkeletonHeader>;

    beforeEach(() => {
        cache = new Map();
        vi.clearAllMocks();
        mockDetectStorageLocations.mockResolvedValue([]);
        mockAnalyzeConversation.mockResolvedValue(null);
        mockLoadFullSkeleton.mockResolvedValue(null);
        mockFindConversationById.mockResolvedValue(null);
    });

    test('returns null when cache is empty and disk has nothing', async () => {
        const result = await resolveFullConversationSkeleton('absent-task', cache);
        expect(result).toBeNull();
    });

    // #3007 ai-01 review — la branche claude-. Le bug mesuré couvrait 2 tâches :
    // une Roo (61 msgs) ET une Claude (17 msgs), toutes deux <sequence/> vide.
    // loadFullSkeleton lit Roo .skeletons/ et ne peut servir une session Claude.
    // Sans la branche claude-, ces tests échouent (findConversationById jamais
    // appelé → null au lieu d'une séquence non vide).
    test('claude-* cache MISS: findConversationById resolves non-empty sequence', async () => {
        const claudeFull: ConversationSkeleton = {
            taskId: 'claude-test-project',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T09:00:00Z',
                messageCount: 17,
                actionCount: 0,
                totalSize: 4000
            },
            sequence: [
                { role: 'user', content: 'claude msg 1', timestamp: '2026-07-29T10:00:00Z', isTruncated: false },
                { role: 'assistant', content: 'claude reply 1', timestamp: '2026-07-29T10:00:01Z', isTruncated: false }
            ]
        };
        mockFindConversationById.mockResolvedValueOnce(claudeFull);

        // Cache complètement vide — la tâche Claude n'a jamais été vue.
        const result = await resolveFullConversationSkeleton('claude-test-project', cache);

        expect(result).toBeTruthy();
        expect((result!.sequence ?? []).length).toBe(2);
        expect(mockFindConversationById).toHaveBeenCalledWith('claude-test-project');
        // loadFullSkeleton (Roo) ne doit JAMAIS être appelé pour une tâche claude-*.
        expect(mockLoadFullSkeleton).not.toHaveBeenCalled();
        // Cache populated pour les prochaines résolutions.
        expect(cache.has('claude-test-project')).toBe(true);
    });

    test('claude-* header-only in cache: routes to ClaudeStorageDetector, not Roo loadFullSkeleton', async () => {
        // Le cas exact de l'issue #3007 : header Claude en cache (sans sequence),
        // messageCount > 0. Sans la branche claude-, loadFullSkeleton (Roo) serait
        // appelé et échouerait → null.
        const headerOnly: SkeletonHeader = {
            taskId: 'claude-measured-task',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T09:00:00Z',
                messageCount: 17,
                actionCount: 0,
                totalSize: 4000
            }
        };
        cache.set('claude-measured-task', headerOnly);

        const claudeFull: ConversationSkeleton = {
            ...headerOnly,
            sequence: [
                { role: 'user', content: 'first', timestamp: '2026-07-29T10:00:00Z', isTruncated: false },
                { role: 'assistant', content: 'second', timestamp: '2026-07-29T10:00:01Z', isTruncated: false },
                { role: 'user', content: 'third', timestamp: '2026-07-29T10:00:02Z', isTruncated: false }
            ]
        };
        mockFindConversationById.mockResolvedValueOnce(claudeFull);

        const result = await resolveFullConversationSkeleton('claude-measured-task', cache);

        expect(result).toBe(claudeFull);
        expect((result!.sequence ?? []).length).toBe(3);
        expect(mockFindConversationById).toHaveBeenCalledWith('claude-measured-task');
        // Roo path must NOT run for a claude-* task it cannot serve.
        expect(mockLoadFullSkeleton).not.toHaveBeenCalled();
    });

    test('claude-* not found in Claude store falls through to Roo disk scan (graceful)', async () => {
        // claude-* prefix mais introuvable dans le store Claude (rare) → ne doit pas
        // crasher, peut retomber sur le scan Roo (qui retourne null ici).
        mockFindConversationById.mockResolvedValueOnce(null);

        const result = await resolveFullConversationSkeleton('claude-phantom', cache);

        expect(result).toBeNull();
        expect(mockFindConversationById).toHaveBeenCalledWith('claude-phantom');
    });

    test('Tier 2/3: returns full skeleton from cache when sequence is non-empty', async () => {
        const fullInCache: ConversationSkeleton = {
            taskId: 'tier2-task',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T09:00:00Z',
                messageCount: 3,
                actionCount: 0,
                totalSize: 500
            },
            sequence: [
                { role: 'user', content: 'hello', timestamp: '2026-07-29T10:00:00Z', isTruncated: false },
                { role: 'assistant', content: 'world', timestamp: '2026-07-29T10:00:01Z', isTruncated: false }
            ]
        };
        cache.set('tier2-task', fullInCache as any);

        const result = await resolveFullConversationSkeleton('tier2-task', cache);

        expect(result).toBe(fullInCache);
        // Pas de hit disk sur Tier 2/3.
        expect(mockLoadFullSkeleton).not.toHaveBeenCalled();
    });

    test('Tier 1 (Roo header-only in cache): loadFullSkeleton resolves the sequence', async () => {
        // Cache : SkeletonHeader (pas de sequence). C'est le cas de l'issue #3007.
        const headerOnly: SkeletonHeader = {
            taskId: 'tier1-task',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T09:00:00Z',
                messageCount: 5,
                actionCount: 0,
                totalSize: 800
            }
        };
        cache.set('tier1-task', headerOnly);

        const fullDisk: ConversationSkeleton = {
            ...headerOnly,
            sequence: [
                { role: 'user', content: 'first', timestamp: '2026-07-29T10:00:00Z', isTruncated: false },
                { role: 'assistant', content: 'second', timestamp: '2026-07-29T10:00:01Z', isTruncated: false },
                { role: 'user', content: 'third', timestamp: '2026-07-29T10:00:02Z', isTruncated: false }
            ]
        };
        mockLoadFullSkeleton.mockResolvedValueOnce(fullDisk);

        const result = await resolveFullConversationSkeleton('tier1-task', cache);

        expect(result).toBe(fullDisk);
        expect(mockLoadFullSkeleton).toHaveBeenCalledWith('tier1-task', cache);
    });

    test('Empty cache header (messageCount=0): returns header with empty sequence, no disk read', async () => {
        // Conversation vide — pas de raison d'aller au disque.
        const emptyHeader: SkeletonHeader = {
            taskId: 'empty-task',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T10:00:00Z',
                messageCount: 0,
                actionCount: 0,
                totalSize: 0
            }
        };
        cache.set('empty-task', emptyHeader);

        const result = await resolveFullConversationSkeleton('empty-task', cache);

        expect(result).toBeTruthy();
        expect(result!.sequence).toEqual([]);
        expect(mockLoadFullSkeleton).not.toHaveBeenCalled();
    });

    test('Fallback to disk scan when loadFullSkeleton fails (corrupt disk file)', async () => {
        const headerOnly: SkeletonHeader = {
            taskId: 'corrupt-task',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T10:00:00Z',
                messageCount: 2,
                actionCount: 0,
                totalSize: 100
            }
        };
        cache.set('corrupt-task', headerOnly);

        // Crée un vrai dossier pour que existsSync() retourne true.
        const os = await import('os');
        const fs = await import('fs/promises');
        const path = await import('path');
        const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-test-corrupt-'));
        const taskDir = path.join(tmpBase, 'tasks', 'corrupt-task');
        await fs.mkdir(taskDir, { recursive: true });
        try {
            mockLoadFullSkeleton.mockResolvedValueOnce(null);
            mockDetectStorageLocations.mockResolvedValueOnce([tmpBase]);
            mockAnalyzeConversation.mockResolvedValueOnce({
                ...headerOnly,
                sequence: [
                    { role: 'user', content: 'rebuilt from disk', timestamp: '2026-07-29T10:00:00Z', isTruncated: false }
                ]
            });

            const result = await resolveFullConversationSkeleton('corrupt-task', cache);

            expect(result).toBeTruthy();
            expect(result!.sequence.length).toBe(1);
            expect(result!.sequence[0].content).toBe('rebuilt from disk');
        } finally {
            await fs.rm(tmpBase, { recursive: true, force: true });
        }
    });

    test('Never throws — wraps all errors and returns null on unexpected failures', async () => {
        mockLoadFullSkeleton.mockRejectedValueOnce(new Error('disk on fire'));
        mockDetectStorageLocations.mockRejectedValueOnce(new Error('storage unreachable'));

        // Doit retourner null (graceful degradation), pas throw.
        const result = await resolveFullConversationSkeleton('whatever', cache);
        expect(result).toBeNull();
    });

    test('Cache miss + disk fallback: RooStorageDetector.analyzeConversation populates cache', async () => {
        // Cache complètement vide — la tâche n'a jamais été vue.
        const expected: ConversationSkeleton = {
            taskId: 'disk-only-task',
            metadata: {
                lastActivity: '2026-07-29T10:00:00Z',
                createdAt: '2026-07-29T10:00:00Z',
                messageCount: 1,
                actionCount: 0,
                totalSize: 50
            },
            sequence: [
                { role: 'user', content: 'only on disk', timestamp: '2026-07-29T10:00:00Z', isTruncated: false }
            ]
        };

        // Crée un vrai dossier pour que existsSync() retourne true.
        const os = await import('os');
        const fs = await import('fs/promises');
        const path = await import('path');
        const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-test-'));
        const tasksDir = path.join(tmpBase, 'tasks');
        await fs.mkdir(tasksDir, { recursive: true });
        const taskDir = path.join(tasksDir, 'disk-only-task');
        await fs.mkdir(taskDir, { recursive: true });
        try {
            // Set impls directement (pas mockResolvedValueOnce pour éviter les races avec beforeEach).
            mockDetectStorageLocations.mockResolvedValue([tmpBase]);
            mockAnalyzeConversation.mockResolvedValue(expected);

            const result = await resolveFullConversationSkeleton('disk-only-task', cache);

            expect(result).toBeTruthy();
            expect(result!.sequence[0].content).toBe('only on disk');
            // Cache doit avoir été peuplé pour les prochaines résolutions.
            expect(cache.has('disk-only-task')).toBe(true);
        } finally {
            await fs.rm(tmpBase, { recursive: true, force: true });
        }
    });
});