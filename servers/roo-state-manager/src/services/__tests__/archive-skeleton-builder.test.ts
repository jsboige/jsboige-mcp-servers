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

import { ConversationSkeleton } from '../../types/conversation.js';

describe('archive-skeleton-builder (additional coverage)', () => {
  const createMockArchive = (): ArchivedTask => ({
    taskId: 'test-task-123',
    machineId: 'myia-ai-01',
    archivedAt: '2026-04-16T09:00:00.000Z',
    messages: [
      {
        role: 'user',
        content: 'Hello, world!',
        timestamp: '2026-04-16T08:00:00.000Z'
      },
      {
        role: 'assistant',
        content: 'Hi! How can I help you today?',
        timestamp: '2026-04-16T08:00:01.000Z'
      },
      {
        role: 'user',
        content: 'Can you help me write a test?',
        timestamp: '2026-04-16T08:00:02.000Z'
      }
    ],
    metadata: {
      title: 'Test Conversation',
      workspace: 'roo-extensions',
      mode: 'code-complex',
      createdAt: '2026-04-16T07:00:00.000Z',
      lastActivity: '2026-04-16T08:00:02.000Z',
      messageCount: 3,
      parentTaskId: 'parent-task-456',
      isCompleted: true,
      source: 'claude-code'
    }
  });

  describe('archiveToSkeleton', () => {
    it('should convert a valid ArchivedTask to ConversationSkeleton', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton).toBeDefined();
      expect(skeleton.taskId).toBe('test-task-123');
      expect(skeleton.sequence).toHaveLength(3);
    });

    it('should preserve task metadata', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata).toBeDefined();
      expect(skeleton.metadata.title).toBe('Test Conversation');
      expect(skeleton.metadata.workspace).toBe('roo-extensions');
      expect(skeleton.metadata.mode).toBe('code-complex');
      expect(skeleton.metadata.machineId).toBe('myia-ai-01');
      expect(skeleton.metadata.source).toBe('claude-code');
    });

    it('should mark dataSource as archive', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.dataSource).toBe('archive');
    });

    it('should preserve parentTaskId', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.parentTaskId).toBe('parent-task-456');
      expect(skeleton.metadata.parentTaskId).toBe('parent-task-456');
    });

    it('should preserve isCompleted status', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.isCompleted).toBe(true);
    });

    it('should set actionCount and totalSize to 0', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.actionCount).toBe(0);
      expect(skeleton.metadata.totalSize).toBe(0);
    });

    it('should convert messages correctly', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.sequence).toHaveLength(3);

      expect(skeleton.sequence[0].role).toBe('user');
      expect(skeleton.sequence[0].content).toBe('Hello, world!');
      expect(skeleton.sequence[0].timestamp).toBe('2026-04-16T08:00:00.000Z');
      expect(skeleton.sequence[0].isTruncated).toBe(false);

      expect(skeleton.sequence[1].role).toBe('assistant');
      expect(skeleton.sequence[1].content).toBe('Hi! How can I help you today?');
      expect(skeleton.sequence[1].timestamp).toBe('2026-04-16T08:00:01.000Z');
      expect(skeleton.sequence[1].isTruncated).toBe(false);

      expect(skeleton.sequence[2].role).toBe('user');
      expect(skeleton.sequence[2].content).toBe('Can you help me write a test?');
      expect(skeleton.sequence[2].timestamp).toBe('2026-04-16T08:00:02.000Z');
      expect(skeleton.sequence[2].isTruncated).toBe(false);
    });

    it('should handle empty messages array', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-456',
        machineId: 'myia-ai-01',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: [],
        metadata: {
          title: 'Empty Archive',
          workspace: 'test-workspace',
          mode: 'debug-simple',
          createdAt: '2026-04-16T07:00:00.000Z',
          lastActivity: '2026-04-16T08:00:00.000Z',
          messageCount: 0,
          isCompleted: false,
          source: 'roo'
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.sequence).toHaveLength(0);
      expect(skeleton.metadata.messageCount).toBe(0);
    });

    it('should handle missing optional metadata fields', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-789',
        machineId: 'myia-po-2026',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: [
          {
            role: 'user',
            content: 'Test message'
          }
        ],
        metadata: {}
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.title).toBeUndefined();
      expect(skeleton.metadata.workspace).toBeUndefined();
      expect(skeleton.metadata.mode).toBeUndefined();
      expect(skeleton.metadata.parentTaskId).toBeUndefined();
      expect(skeleton.isCompleted).toBe(false);
      expect(skeleton.metadata.createdAt).toBe('2026-04-16T09:00:00.000Z');
      expect(skeleton.metadata.lastActivity).toBe('2026-04-16T09:00:00.000Z');
      expect(skeleton.metadata.messageCount).toBe(1);
    });

    it('should handle messages without timestamps', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-999',
        machineId: 'myia-web1',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: [
          {
            role: 'user',
            content: 'No timestamp message'
            // timestamp is missing
          }
        ],
        metadata: {
          title: 'No Timestamp Test',
          workspace: 'test',
          mode: 'code-simple',
          createdAt: '2026-04-16T07:00:00.000Z',
          lastActivity: '2026-04-16T08:00:00.000Z',
          messageCount: 1,
          isCompleted: true,
          source: 'claude-code'
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.sequence[0].timestamp).toBe('2026-04-16T09:00:00.000Z');
    });

    it('should use archivedAt as fallback for missing timestamps', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-fallback',
        machineId: 'myia-ai-01',
        archivedAt: '2026-04-16T10:00:00.000Z',
        messages: [
          {
            role: 'user',
            content: 'Message with fallback timestamp'
          }
        ],
        metadata: {
          title: 'Fallback Test',
          workspace: 'test-workspace',
          mode: 'orchestrator-complex',
          messageCount: 1,
          isCompleted: false,
          source: 'roo'
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.createdAt).toBe('2026-04-16T10:00:00.000Z');
      expect(skeleton.metadata.lastActivity).toBe('2026-04-16T10:00:00.000Z');
      expect(skeleton.sequence[0].timestamp).toBe('2026-04-16T10:00:00.000Z');
    });

    it('should preserve machineId from archive', () => {
      const archive = createMockArchive();
      archive.machineId = 'myia-po-2024';

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.machineId).toBe('myia-po-2024');
    });

    it('should default source to roo when not specified', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-source',
        machineId: 'myia-ai-01',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: [
          {
            role: 'user',
            content: 'Test'
          }
        ],
        metadata: {
          // source is not specified
          title: 'Source Test',
          workspace: 'test',
          mode: 'code-complex',
          messageCount: 1,
          isCompleted: false
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.source).toBe('roo');
    });

    it('should handle messages array being undefined', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-undefined',
        machineId: 'myia-ai-01',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: undefined as any,
        metadata: {
          title: 'Undefined Messages Test',
          workspace: 'test',
          mode: 'debug-complex',
          messageCount: 0,
          isCompleted: false,
          source: 'claude-code'
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.sequence).toHaveLength(0);
    });
  });

  describe('metadata handling', () => {
    it('should preserve all metadata fields when present', () => {
      const archive = createMockArchive();
      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata).toEqual({
        title: 'Test Conversation',
        workspace: 'roo-extensions',
        mode: 'code-complex',
        createdAt: '2026-04-16T07:00:00.000Z',
        lastActivity: '2026-04-16T08:00:02.000Z',
        messageCount: 3,
        actionCount: 0,
        totalSize: 0,
        machineId: 'myia-ai-01',
        source: 'claude-code',
        parentTaskId: 'parent-task-456',
        dataSource: 'archive'
      });
    });

    it('should correctly set messageCount from metadata or actual sequence length', () => {
      const archive = createMockArchive();
      archive.metadata!.messageCount = 5; // Different from actual message count

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.messageCount).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('should handle archive with null metadata', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-null-meta',
        machineId: 'myia-ai-01',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: [
          {
            role: 'user',
            content: 'Test'
          }
        ],
        metadata: null as any
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.metadata.title).toBeUndefined();
      expect(skeleton.metadata.workspace).toBeUndefined();
      expect(skeleton.isCompleted).toBe(false);
    });

    it('should handle single message archive', () => {
      const archive: ArchivedTask = {
        taskId: 'test-task-single',
        machineId: 'myia-web1',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages: [
          {
            role: 'user',
            content: 'Single message',
            timestamp: '2026-04-16T08:00:00.000Z'
          }
        ],
        metadata: {
          title: 'Single Message',
          workspace: 'test',
          mode: 'code-simple',
          messageCount: 1,
          isCompleted: true,
          source: 'claude-code'
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.sequence).toHaveLength(1);
      expect(skeleton.sequence[0].role).toBe('user');
      expect(skeleton.sequence[0].content).toBe('Single message');
      expect(skeleton.sequence[0].isTruncated).toBe(false);
    });

    it('should handle archive with large number of messages', () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString()
      }));

      const archive: ArchivedTask = {
        taskId: 'test-task-large',
        machineId: 'myia-ai-01',
        archivedAt: '2026-04-16T09:00:00.000Z',
        messages,
        metadata: {
          title: 'Large Archive',
          workspace: 'test',
          mode: 'orchestrator-complex',
          messageCount: 100,
          isCompleted: false,
          source: 'roo'
        }
      };

      const skeleton = archiveToSkeleton(archive);

      expect(skeleton.sequence).toHaveLength(100);
      expect(skeleton.metadata.messageCount).toBe(100);
    });
  });
});
