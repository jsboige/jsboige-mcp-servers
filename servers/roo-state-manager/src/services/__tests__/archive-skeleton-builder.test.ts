/**
 * Tests pour archiveToSkeleton (issue #1244 - Multi-tier skeleton cache)
 */

import { describe, it, expect } from 'vitest';
import { archiveToSkeleton, archiveToStub } from '../archive-skeleton-builder.js';
import { ArchivedTask } from '../task-archiver/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { matchesWorkspace } from '../../utils/workspace-match.js';
import { deriveWorkspaceFromClaudeProjectSlug } from '../../utils/claude-project-workspace.js';

describe('archiveToSkeleton', () => {
    it('devrait convertir une archive minimale en skeleton valide', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-123',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Test Task',
                messageCount: 2,
                isCompleted: true,
            },
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there!' },
            ],
        };

        const result = archiveToSkeleton(archive);

        expect(result.taskId).toBe('task-123');
        expect(result.parentTaskId).toBeUndefined();
        expect(result.isCompleted).toBe(true);
        expect(result.metadata.dataSource).toBe('archive');
        expect(result.metadata.machineId).toBe('myia-ai-01');
        expect(result.metadata.actionCount).toBe(0);
        expect(result.metadata.totalSize).toBe(0);
        expect(result.sequence).toHaveLength(2);
        expect(result.sequence[0]).toEqual({
            role: 'user',
            content: 'Hello',
            timestamp: '2026-04-18T12:00:00Z',
            isTruncated: false,
        });
    });

    it('devrait utiliser les timestamps des messages quand disponibles', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-456',
            machineId: 'myia-po-2026',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Timestamp Test',
                messageCount: 1,
                isCompleted: false,
            },
            messages: [
                {
                    role: 'user',
                    content: 'With timestamp',
                    timestamp: '2026-04-18T10:00:00Z',
                },
            ],
        };

        const result = archiveToSkeleton(archive);

        expect(result.sequence[0].timestamp).toBe('2026-04-18T10:00:00Z');
    });

    it('devrait fallback vers archivedAt pour timestamps manquants', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-789',
            machineId: 'myia-web1',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Fallback Test',
                messageCount: 1,
                isCompleted: false,
                createdAt: '2026-04-18T08:00:00Z',
                lastActivity: '2026-04-18T11:00:00Z',
            },
            messages: [{ role: 'user', content: 'No timestamp' }],
        };

        const result = archiveToSkeleton(archive);

        expect(result.sequence[0].timestamp).toBe('2026-04-18T12:00:00Z');
    });

    it('devrait préserver tous les métadonnées optionnelles', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-full',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Full Metadata',
                workspace: 'roo-extensions',
                mode: 'code-complex',
                createdAt: '2026-04-18T08:00:00Z',
                lastActivity: '2026-04-18T11:00:00Z',
                messageCount: 1,
                isCompleted: true,
                parentTaskId: 'parent-123',
                source: 'claude-code',
            },
            messages: [{ role: 'assistant', content: 'Response' }],
        };

        const result = archiveToSkeleton(archive);

        expect(result.metadata.title).toBe('Full Metadata');
        expect(result.metadata.workspace).toBe('roo-extensions');
        expect(result.metadata.mode).toBe('code-complex');
        expect(result.metadata.createdAt).toBe('2026-04-18T08:00:00Z');
        expect(result.metadata.lastActivity).toBe('2026-04-18T11:00:00Z');
        expect(result.metadata.parentTaskId).toBe('parent-123');
        expect(result.metadata.source).toBe('claude-code');
        expect(result.parentTaskId).toBe('parent-123');
    });

    it('devrait gérer les archives sans messages', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-empty',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Empty Task',
                messageCount: 0,
                isCompleted: false,
            },
            messages: [],
        };

        const result = archiveToSkeleton(archive);

        expect(result.sequence).toHaveLength(0);
        expect(result.metadata.messageCount).toBe(0);
    });

    it('devrait utiliser la source roo par défaut si non spécifiée', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-default',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Default Source',
                messageCount: 0,
                isCompleted: false,
            },
            messages: [],
        };

        const result = archiveToSkeleton(archive);

        expect(result.metadata.source).toBe('roo');
    });

    it('devrait calculer messageCount depuis la sequence si non fourni', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-calc',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Calculated Count',
                isCompleted: false,
            },
            messages: [
                { role: 'user', content: 'Msg 1' },
                { role: 'assistant', content: 'Msg 2' },
                { role: 'user', content: 'Msg 3' },
            ],
        };

        const result = archiveToSkeleton(archive);

        expect(result.metadata.messageCount).toBe(3);
    });

    it('devrait utiliser archivedAt comme fallback pour createdAt et lastActivity', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-fallback',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Fallback Dates',
                messageCount: 0,
                isCompleted: false,
            },
            messages: [],
        };

        const result = archiveToSkeleton(archive);

        expect(result.metadata.createdAt).toBe('2026-04-18T12:00:00Z');
        expect(result.metadata.lastActivity).toBe('2026-04-18T12:00:00Z');
    });

    it('devrait marquer isCompleted comme false par défaut', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-incomplete',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Incomplete',
                messageCount: 0,
            },
            messages: [],
        };

        const result = archiveToSkeleton(archive);

        expect(result.isCompleted).toBe(false);
    });

    it('devrait gérer les messages avec contenu vide', () => {
        const archive: ArchivedTask = {
            version: 2,
            taskId: 'task-empty-content',
            machineId: 'myia-ai-01',
            hostIdentifier: 'test-host',
            archivedAt: '2026-04-18T12:00:00Z',
            metadata: {
                title: 'Empty Content',
                messageCount: 2,
                isCompleted: true,
            },
            messages: [
                { role: 'user', content: '' },
                { role: 'assistant', content: '' },
            ],
        };

        const result = archiveToSkeleton(archive);

        expect(result.sequence).toHaveLength(2);
        expect(result.sequence[0].content).toBe('');
        expect(result.sequence[1].content).toBe('');
    });
});

/**
 * Origine du workspace pour les archives Claude — friction ai-01 du 04/10
 * (#1244, point 2) : les en-têtes d'archives `source="claude"` ne portent PAS
 * de champ `workspace` (contrairement aux archives `source="roo"`), donc
 * `matchesWorkspace(undefined, q)` rend `false` par construction et le filtre
 * `workspace` ne peut matcher aucune session Claude archivée.
 *
 * Le slug de projet est la seule information de chemin restante :
 * `d--Dev-CoursIA` → `d:/Dev-CoursIA` (la regex `^([a-zA-Z])--(.*)`).
 */
describe('archive workspace origin — Claude archives (friction 04/10)', () => {
    const claudeArchive: ArchivedTask = {
        version: 2,
        taskId: 'claude-d--Dev-CoursIA--3650f974-4379-4001-b0a0-3cf02ee8a82',
        machineId: 'myia-po-2024',
        hostIdentifier: 'test-host',
        archivedAt: '2026-04-18T12:00:00Z',
        metadata: {
            title: 'Claude CoursIA — 3650f974',
            messageCount: 1,
            isCompleted: true,
            source: 'claude',
        },
        messages: [{ role: 'user', content: 'Hello' }],
    };

    const rooArchive: ArchivedTask = {
        version: 2,
        taskId: 'task-123',
        machineId: 'myia-ai-01',
        hostIdentifier: 'test-host',
        archivedAt: '2026-04-18T12:00:00Z',
        metadata: {
            title: 'Roo Task',
            messageCount: 1,
            isCompleted: true,
            source: 'roo',
            workspace: 'd:/dev/roo-extensions',
        },
        messages: [{ role: 'user', content: 'Hello' }],
    };

    it('archiveToSkeleton: dérive le workspace du taskId quand le champ est absent', () => {
        const result = archiveToSkeleton(claudeArchive);
        expect(result.metadata.workspace).toBe('d:/Dev-CoursIA');
    });

    it('archiveToSkeleton: le filtre workspace retrouve une archive Claude (le symptôme exact)', () => {
        const result = archiveToSkeleton(claudeArchive);
        // Requête par la valeur canonique du workspace, stratégie par défaut.
        expect(matchesWorkspace(result.metadata.workspace, 'd:/Dev-CoursIA')).toBe(true);
        // Avant le fix : champ absent → `false` quelle que soit la requête.
        expect(matchesWorkspace(undefined, 'd:/Dev-CoursIA')).toBe(false);
        // Recherche exploratoire par basename.
        expect(matchesWorkspace(result.metadata.workspace, 'CoursIA', 'substring')).toBe(true);
    });

    it('archiveToSkeleton: un workspace explicite (archive roo) n’est jamais écrasé', () => {
        const result = archiveToSkeleton(rooArchive);
        expect(result.metadata.workspace).toBe('d:/dev/roo-extensions');
    });

    it('archiveToSkeleton: taskId claude sans slug de lecteur → pas de dérivation', () => {
        const odd = { ...claudeArchive, taskId: 'claude-myproject--deadbeef' };
        const result = archiveToSkeleton(odd);
        expect(result.metadata.workspace).toBeUndefined();
    });

    /**
     * Format RÉEL des archives écrites par l'archiver (review #1353, bloquant 1) :
     * le `taskId` du CORPS est le safeSessionId SANS préfixe `claude-`, et le `/`
     * du chemin projet est sanitizer en `__` (TaskArchiver.ts:38-40, :378) —
     * fixture copiée de `task-archive/myia-ai-01/claude-C--dev-roo-extensions__0f2d4e16-….json.gz`.
     * Le préfixe ne vit que dans le NOM DE FICHIER (`:348`).
     */
    const archivedClaudeArchive: ArchivedTask = {
        ...claudeArchive,
        taskId: 'C--dev-roo-extensions__0f2d4e16-4b81-4a12-af93-b8524d28f8d2',
    };

    it('archiveToSkeleton: dérive le workspace du taskId de corps d’archive (sans préfixe, séparateur __)', () => {
        const result = archiveToSkeleton(archivedClaudeArchive);
        // Limite de structure : le `\` interne du chemin est slugifié en `-`
        // simple, indistinguable d'un tiret littéral — la valeur dérivée garde
        // les tirets (cf. deriveWorkspaceFromClaudeProjectSlug).
        expect(result.metadata.workspace).toBe('c:/dev-roo-extensions');
        // Le filtre retrouve l'archive sur la valeur dérivée (exact)…
        expect(matchesWorkspace(result.metadata.workspace, 'c:/dev-roo-extensions')).toBe(true);
        // …et par recherche exploratoire de composant (substring).
        expect(matchesWorkspace(result.metadata.workspace, 'roo-extensions', 'substring')).toBe(true);
    });

    it('archiveToSkeleton: id dérivé du nom de fichier (préfixe claude- + __) — même dérivation', () => {
        const result = archiveToSkeleton({
            ...archivedClaudeArchive,
            taskId: 'claude-C--dev-roo-extensions__0f2d4e16-4b81-4a12-af93-b8524d28f8d2',
        });
        expect(result.metadata.workspace).toBe('c:/dev-roo-extensions');
    });

    it('archiveToSkeleton: slug à -- interne (lecteur) — coupe au __ de l’uuid, pas au -- du lecteur', () => {
        // `g--Mon-Drive-Suzon` : le `--` du lecteur doit survivre à la coupe.
        const result = archiveToSkeleton({
            ...claudeArchive,
            taskId: 'g--Mon-Drive-Suzon__3650f974-4379-4001-b0a0-3cf02ee8a82',
        });
        expect(result.metadata.workspace).toBe('g:/Mon-Drive-Suzon');
    });

    it('archiveToSkeleton: composite agent <slug>__<uuid>__agent-<id> — coupe au PREMIER __', () => {
        // Forme DOMINANTE des sessions Claude agents (mesure 04/10 : 8 638/11 108
        // ≈ 78 % du corpus) : le suffixe `__agent-<id>` suit l'uuid. La coupe au
        // DERNIER `__` atterrit sur ce suffixe et pollue le slug avec l'uuid ;
        // le PREMIER `__` est la frontière slug/uuid (c.5981499467).
        const result = archiveToSkeleton({
            ...claudeArchive,
            taskId: 'd--Dev-CoursIA__a8c96915-e4ed-4a20-a4ec-1de5d8094f9a__agent-1a2b3c4d',
        });
        expect(result.metadata.workspace).toBe('d:/Dev-CoursIA');
    });

    it('archiveToSkeleton: forme live sans __ (claude-<slug>--<uuid>) — repli au dernier --', () => {
        // Scan live / nom de fichier : aucun `__` → la coupe retombe sur le
        // DERNIER `--` (celui qui précède l'uuid, pas le `--` du lecteur).
        const result = archiveToSkeleton({
            ...claudeArchive,
            taskId: 'claude-d--Dev-CoursIA--a8c96915-e4ed-4a20-a4ec-1de5d8094f9a',
        });
        expect(result.metadata.workspace).toBe('d:/Dev-CoursIA');
    });

    it('archiveToStub: dérive le workspace du taskId quand le champ est absent', () => {
        const result = archiveToStub(claudeArchive, 'G:/archive/claude-x.json');
        expect(result.metadata.workspace).toBe('d:/Dev-CoursIA');
    });

    it('archiveToStub: le filtre workspace retrouve une archive Claude (le symptôme exact)', () => {
        const result = archiveToStub(claudeArchive, 'G:/archive/claude-x.json');
        expect(matchesWorkspace(result.metadata.workspace, 'd:/Dev-CoursIA')).toBe(true);
        expect(matchesWorkspace(undefined, 'd:/Dev-CoursIA')).toBe(false);
    });

    it('archiveToStub: un workspace explicite (archive roo) n’est jamais écrasé', () => {
        const result = archiveToStub(rooArchive, 'G:/archive/roo-x.json');
        expect(result.metadata.workspace).toBe('d:/dev/roo-extensions');
    });

    // Dérivation partagée par le scan live (list-conversations.tool.ts) — la même
    // regex y était inline avant ce fix ; une seule définition désormais.
    it('deriveWorkspaceFromClaudeProjectSlug: forme canonique et cas non dérivables', () => {
        expect(deriveWorkspaceFromClaudeProjectSlug('d--Dev-CoursIA')).toBe('d:/Dev-CoursIA');
        // Lecteur en majuscule → normalisé en minuscule, tirets conservés.
        expect(deriveWorkspaceFromClaudeProjectSlug('G--Mon-Drive-Suzon')).toBe('g:/Mon-Drive-Suzon');
        expect(deriveWorkspaceFromClaudeProjectSlug('myproject')).toBeUndefined();
        expect(deriveWorkspaceFromClaudeProjectSlug('d--')).toBeUndefined();
        expect(deriveWorkspaceFromClaudeProjectSlug(undefined)).toBeUndefined();
    });
});
