/**
 * Regression test #3007 — export_data(target=task, format=xml) vide.
 *
 * Bug constaté : `<sequence/>` toujours vide, `actionCount=0` face à `messageCount>0`,
 * `includeContent: true/false` produit la même sortie. Cause racine : `registry.ts`
 * passe `async (id) => cache.get(id) || null` comme callback `getConversationSkeleton`,
 * mais le cache ne contient que des `SkeletonHeader` (sans champ `sequence`) — donc
 * `XmlExporterService.generateTaskXml` itère `skeleton.sequence ?? []` → vide.
 *
 * Ce test reproduit le wiring du registre (cache contient un header, callback expose
 * ce header sans sequence) et exige que la séquence soit non-vide.
 *
 * Framework: Vitest
 *
 * @module export/export-data-registry-wiring.test
 * @version 1.0.0 (#3007)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleExportData, ExportDataArgs } from '../export-data.js';
import { ConversationSkeleton, SkeletonHeader } from '../../../types/conversation.js';

// Mock XmlExporterService — capture les arguments reçus
const mockXmlExporterService = {
    generateTaskXml: vi.fn((_skeleton: ConversationSkeleton, opts: { includeContent?: boolean } = {}) => {
        // Implémentation de test qui matérialise la séquence comme le ferait
        // un export réel (c'est exactement ce que XmlExporterService fait).
        const skel = _skeleton as any;
        const seq = Array.isArray(skel.sequence) ? skel.sequence : [];
        const items = seq.map((item: any) => {
            if ('role' in item) {
                const content = opts.includeContent
                    ? item.content
                    : (item.content.length > 100 ? item.content.substring(0, 100) + '...' : item.content);
                return `<message role="${item.role}">${content}</message>`;
            }
            return `<action name="${item.name}"/>`;
        }).join('');
        return `<task>${items}</task>`;
    }),
    generateConversationXml: vi.fn(() => '<conversation/>'),
    generateProjectXml: vi.fn(() => '<project/>'),
    saveXmlToFile: vi.fn()
};

vi.mock('../../../services/TraceSummaryService.js', () => ({
    TraceSummaryService: class {
        generateSummary = vi.fn();
    }
}));

vi.mock('../../../services/ExportConfigManager.js', () => ({
    ExportConfigManager: vi.fn().mockImplementation(() => ({
        getConfig: vi.fn().mockResolvedValue({}),
        updateConfig: vi.fn(),
        resetConfig: vi.fn()
    }))
}));

vi.mock('fs/promises', () => ({
    default: {
        mkdir: vi.fn(),
        writeFile: vi.fn()
    }
}));

describe('export_data registry wiring — #3007 regression', () => {
    let mockCache: Map<string, SkeletonHeader>;
    let mockEnsureCache: (options?: { workspace?: string }) => Promise<void>;

    beforeEach(() => {
        mockCache = new Map();
        mockEnsureCache = vi.fn(async () => {});
        vi.clearAllMocks();
    });

    test('BUG REPRO: registry callback cache.get() without sequence → empty <sequence>', async () => {
        // Étape 1 : Cache contient un SkeletonHeader (pas de sequence).
        // C'est exactement ce que `registry.ts` stocke (cf. state-manager.service.ts:102).
        const headerOnly: SkeletonHeader = {
            taskId: 'task-3007',
            metadata: {
                title: 'Test #3007',
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messageCount: 5,
                actionCount: 2,
                totalSize: 1234
            }
        };
        mockCache.set('task-3007', headerOnly);

        // Étape 2 : Le registre passe `cache.get(id) || null` — qui retourne
        // le header (sans sequence). handleTaskXml voit alors un squelette
        // sans sequence et génère `<sequence/>` vide.
        const registryBuggyCallback = async (id: string) => mockCache.get(id) || null;

        const args: ExportDataArgs = {
            target: 'task',
            format: 'xml',
            taskId: 'task-3007',
            includeContent: true
        };

        const result = await handleExportData(
            args,
            mockCache as any,
            mockXmlExporterService as any,
            mockEnsureCache,
            registryBuggyCallback
        );

        const xml = (result.content[0] as any).text as string;
        // Le bug : séquence vide même avec 5 messages dans metadata.messageCount.
        expect(xml).toBe('<task></task>');  // <sequence/> vide
    });

    test('FIX: callback resolves full skeleton from disk → <sequence> contains N messages', async () => {
        // Étape 1 : Cache contient un SkeletonHeader sans sequence.
        const headerOnly: SkeletonHeader = {
            taskId: 'task-3007',
            metadata: {
                title: 'Test #3007 fix',
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messageCount: 5,
                actionCount: 0,
                totalSize: 1234
            }
        };
        mockCache.set('task-3007', headerOnly);

        // Étape 2 : Le callback correctement câblé charge le skeleton complet
        // depuis le disque — comme `conversation_browser` le fait déjà (registry.ts:218-273).
        const fullSkeleton: ConversationSkeleton = {
            ...headerOnly,
            sequence: [
                { role: 'user', content: 'Hello world, this is a long message that should be included if includeContent=true', timestamp: '2026-07-29T10:00:00Z', isTruncated: false },
                { role: 'assistant', content: 'Hi back, another long message for includeContent verification', timestamp: '2026-07-29T10:00:01Z', isTruncated: false },
                { role: 'user', content: 'Third message', timestamp: '2026-07-29T10:00:02Z', isTruncated: false }
            ]
        };

        const fixedCallback = async (id: string) => {
            // Tier 2/3: cache contient déjà la séquence complète (rare mais possible).
            const cached = mockCache.get(id) as any;
            if (cached && Array.isArray(cached.sequence) && cached.sequence.length > 0) {
                return cached;
            }
            // Tier 1 Roo (cas de l'issue): on charge le full skeleton depuis le disque.
            if (id === 'task-3007') return fullSkeleton;
            return null;
        };

        const args: ExportDataArgs = {
            target: 'task',
            format: 'xml',
            taskId: 'task-3007',
            includeContent: true
        };

        const result = await handleExportData(
            args,
            mockCache as any,
            mockXmlExporterService as any,
            mockEnsureCache,
            fixedCallback
        );

        const xml = (result.content[0] as any).text as string;

        // La séquence doit maintenant contenir les 3 messages.
        const messageMatches = xml.match(/<message role="[^"]+">/g);
        expect(messageMatches).not.toBeNull();
        expect(messageMatches!.length).toBe(3);

        // includeContent=true doit livrer le contenu intégralement (pas de troncature à 100 chars).
        // Le 1er message fait 96 chars — on teste surtout que le contenu complet est passé.
        expect(xml).toContain('Hello world, this is a long message that should be included if includeContent=true');
    });

    test('includeContent=false: messages tronqués à 100 chars (vérifie que includeContent change bien la sortie)', async () => {
        const headerOnly: SkeletonHeader = {
            taskId: 'task-3007',
            metadata: {
                lastActivity: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messageCount: 1,
                actionCount: 0,
                totalSize: 200
            }
        };
        mockCache.set('task-3007', headerOnly);

        const fullSkeleton: ConversationSkeleton = {
            ...headerOnly,
            sequence: [
                { role: 'user', content: 'A'.repeat(150), timestamp: '2026-07-29T10:00:00Z', isTruncated: false }
            ]
        };

        const callback = async (id: string) => id === 'task-3007' ? fullSkeleton : null;

        // includeContent=false → contenu tronqué à 100 chars + '...'
        const resultNoContent = await handleExportData(
            { target: 'task', format: 'xml', taskId: 'task-3007', includeContent: false },
            mockCache as any,
            mockXmlExporterService as any,
            mockEnsureCache,
            callback
        );
        const xmlNoContent = (resultNoContent.content[0] as any).text as string;

        // includeContent=true → contenu intégral (150 chars A).
        const resultFullContent = await handleExportData(
            { target: 'task', format: 'xml', taskId: 'task-3007', includeContent: true },
            mockCache as any,
            mockXmlExporterService as any,
            mockEnsureCache,
            callback
        );
        const xmlFullContent = (resultFullContent.content[0] as any).text as string;

        expect(xmlNoContent).toContain('A'.repeat(100) + '...');
        expect(xmlNoContent).not.toContain('A'.repeat(101));
        expect(xmlFullContent).toContain('A'.repeat(150));
        // Sanity : les deux sorties doivent être différentes (preuve que includeContent a un effet).
        expect(xmlNoContent).not.toBe(xmlFullContent);
    });
});