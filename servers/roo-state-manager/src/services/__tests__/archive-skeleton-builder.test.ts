/**
 * Tests pour archiveToSkeleton (issue #1244 - Multi-tier skeleton cache)
 */

import { describe, it, expect } from 'vitest';
import { archiveToSkeleton } from '../archive-skeleton-builder.js';
import { ArchivedTask } from '../task-archiver/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

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
