/**
 * Tests for archive-skeleton-builder
 *
 * Issue #1244 - Multi-tier skeleton cache
 */

import { describe, it, expect } from 'vitest';
import { archiveToSkeleton } from '../archive-skeleton-builder.js';
import type { ArchivedTask } from '../task-archiver/types.js';

describe('archive-skeleton-builder', () => {
    const mockTimestamp = '2026-04-14T10:00:00.000Z';
    const baseArchive: ArchivedTask = {
        taskId: 'task-123',
        machineId: 'myia-po-2024',
        archivedAt: mockTimestamp,
        metadata: {
            parentTaskId: 'parent-456',
            title: 'Test Task',
            workspace: 'C:/dev/roo-extensions',
            mode: 'code-complex',
            createdAt: '2026-04-14T09:00:00.000Z',
            lastActivity: mockTimestamp,
            messageCount: 5,
            source: 'claude-interactive',
            isCompleted: true,
        },
        messages: [
            {
                role: 'user',
                content: 'Hello, world!',
                timestamp: mockTimestamp,
            },
            {
                role: 'assistant',
                content: 'Hi there!',
                timestamp: mockTimestamp,
            },
        ],
    };

    describe('archiveToSkeleton', () => {
        it('should convert a basic archive to skeleton', () => {
            const result = archiveToSkeleton(baseArchive);

            expect(result.taskId).toBe('task-123');
            expect(result.metadata?.dataSource).toBe('archive');
            expect(result.metadata?.machineId).toBe('myia-po-2024');
        });

        it('should preserve message role, content, and timestamp', () => {
            const result = archiveToSkeleton(baseArchive);

            expect(result.sequence).toHaveLength(2);
            expect(result.sequence[0]).toMatchObject({
                role: 'user',
                content: 'Hello, world!',
                timestamp: mockTimestamp,
                isTruncated: false,
            });
            expect(result.sequence[1]).toMatchObject({
                role: 'assistant',
                content: 'Hi there!',
                timestamp: mockTimestamp,
                isTruncated: false,
            });
        });

        it('should use archivedAt as fallback timestamp when message timestamp missing', () => {
            const archiveWithoutTimestamps: ArchivedTask = {
                ...baseArchive,
                messages: [
                    {
                        role: 'user',
                        content: 'No timestamp',
                    },
                ],
            };

            const result = archiveToSkeleton(archiveWithoutTimestamps);

            expect(result.sequence[0].timestamp).toBe(mockTimestamp);
        });

        it('should preserve metadata fields from archive', () => {
            const result = archiveToSkeleton(baseArchive);

            expect(result.metadata).toMatchObject({
                title: 'Test Task',
                workspace: 'C:/dev/roo-extensions',
                mode: 'code-complex',
                createdAt: '2026-04-14T09:00:00.000Z',
                lastActivity: mockTimestamp,
                messageCount: 5,
                source: 'claude-interactive',
                parentTaskId: 'parent-456',
                dataSource: 'archive',
            });
        });

        it('should set actionCount and totalSize to 0 (archive does not contain tool metadata)', () => {
            const result = archiveToSkeleton(baseArchive);

            expect(result.metadata?.actionCount).toBe(0);
            expect(result.metadata?.totalSize).toBe(0);
        });

        it('should use fallback timestamps when metadata fields missing', () => {
            const minimalArchive: ArchivedTask = {
                taskId: 'task-456',
                machineId: 'myia-ai-01',
                archivedAt: mockTimestamp,
            };

            const result = archiveToSkeleton(minimalArchive);

            expect(result.metadata?.createdAt).toBe(mockTimestamp);
            expect(result.metadata?.lastActivity).toBe(mockTimestamp);
            expect(result.metadata?.messageCount).toBe(0);
        });

        it('should default isCompleted to false when not specified', () => {
            const archiveWithoutCompletion: ArchivedTask = {
                ...baseArchive,
                metadata: {
                    ...baseArchive.metadata,
                    isCompleted: undefined,
                },
            };

            const result = archiveToSkeleton(archiveWithoutCompletion);

            expect(result.isCompleted).toBe(false);
        });

        it('should default source to "roo" when not specified', () => {
            const minimalArchive: ArchivedTask = {
                taskId: 'task-789',
                machineId: 'myia-web1',
                archivedAt: mockTimestamp,
                metadata: {},
            };

            const result = archiveToSkeleton(minimalArchive);

            expect(result.metadata?.source).toBe('roo');
        });

        it('should use messageCount from sequence length when metadata missing', () => {
            const archiveWithoutMessageCount: ArchivedTask = {
                ...baseArchive,
                metadata: {
                    ...baseArchive.metadata,
                    messageCount: undefined,
                },
            };

            const result = archiveToSkeleton(archiveWithoutMessageCount);

            expect(result.metadata?.messageCount).toBe(2);
        });

        it('should handle empty messages array', () => {
            const emptyArchive: ArchivedTask = {
                taskId: 'task-empty',
                machineId: 'myia-po-2024',
                archivedAt: mockTimestamp,
                messages: [],
            };

            const result = archiveToSkeleton(emptyArchive);

            expect(result.sequence).toEqual([]);
            expect(result.metadata?.messageCount).toBe(0);
        });

        it('should handle missing messages (undefined)', () => {
            const noMessagesArchive: ArchivedTask = {
                taskId: 'task-no-msgs',
                machineId: 'myia-po-2024',
                archivedAt: mockTimestamp,
            };

            const result = archiveToSkeleton(noMessagesArchive);

            expect(result.sequence).toEqual([]);
        });

        it('should handle undefined metadata gracefully', () => {
            const bareArchive: ArchivedTask = {
                taskId: 'task-bare',
                machineId: 'myia-po-2024',
                archivedAt: mockTimestamp,
            };

            const result = archiveToSkeleton(bareArchive);

            expect(result.metadata).toBeDefined();
            expect(result.metadata?.dataSource).toBe('archive');
            expect(result.metadata?.machineId).toBe('myia-po-2024');
        });
    });
});
