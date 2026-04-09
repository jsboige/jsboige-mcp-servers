import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskArchiver } from '../../../../src/services/task-archiver/TaskArchiver.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// Mock fs
vi.mock('fs', () => ({
    promises: {
        access: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        readdir: vi.fn(),
    }
}));

// Mock zlib
vi.mock('zlib', () => ({
    gzip: vi.fn((input: Buffer, callback: (err: Error | null, result: Buffer) => void) => {
        callback(null, Buffer.from('compressed-' + input.toString()));
    }),
    gunzip: vi.fn((input: Buffer, callback: (err: Error | null, result: Buffer) => void) => {
        const str = input.toString();
        if (str.startsWith('compressed-')) {
            callback(null, Buffer.from(str.replace('compressed-', '')));
        } else {
            callback(null, input);
        }
    }),
}));

// Mock server-helpers
vi.mock('../../../../src/utils/server-helpers.js', () => ({
    getSharedStatePath: vi.fn(() => '/shared-state')
}));

// Mock os
vi.mock('os', () => ({
    default: {
        hostname: () => 'TestMachine',
        platform: () => 'win32',
        arch: () => 'x64',
    },
    hostname: () => 'TestMachine',
    platform: () => 'win32',
    arch: () => 'x64',
}));

import { promises as fs } from 'fs';

function createMockSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
    return {
        taskId: 'test-task-123',
        parentTaskId: undefined,
        truncatedInstruction: 'Test task instruction',
        isCompleted: false,
        sequence: [],
        metadata: {
            title: 'Test Task',
            workspace: '/test/workspace',
            mode: 'code',
            createdAt: '2026-02-13T10:00:00Z',
            lastActivity: '2026-02-13T11:00:00Z',
            messageCount: 5,
            totalSize: 1000,
        },
        ...overrides,
    } as any;
}

describe('TaskArchiver', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('archiveTask', () => {
        // Since the archive format bump v1 -> v2, existence check is done by
        // reading the archive (gunzip + JSON parse) and inspecting .version,
        // NOT fs.access. The hoisted gunzip mock strips the 'compressed-' prefix,
        // so a v2 archive is simulated as Buffer.from('compressed-' + JSON.stringify({version: 2, ...})).
        const missingArchive = () =>
            vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
        const existingV2Archive = () =>
            vi.mocked(fs.readFile).mockResolvedValueOnce(
                Buffer.from('compressed-' + JSON.stringify({ version: 2, taskId: 'x', messages: [] })) as any
            );

        it('should archive a task from ui_messages.json', async () => {
            const skeleton = createMockSkeleton();
            const uiMessages = [
                { author: 'user', text: 'Hello', timestamp: '2026-02-13T10:00:00Z' },
                { author: 'agent', text: 'Hi there!', timestamp: '2026-02-13T10:00:05Z' },
            ];

            missingArchive(); // version check fails -> no prior archive
            vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(uiMessages));
            vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
            vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            expect(fs.mkdir).toHaveBeenCalledWith(
                expect.stringContaining('testmachine'),
                { recursive: true }
            );
            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('test-task-123.json.gz'),
                expect.any(Buffer)
            );
        });

        it('should skip if already archived as v2', async () => {
            const skeleton = createMockSkeleton();
            existingV2Archive();

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            // Only the version-check read happens; no source read and no write.
            expect(vi.mocked(fs.readFile).mock.calls.length).toBe(1);
            expect(fs.writeFile).not.toHaveBeenCalled();
        });

        it('should upgrade existing v1 archive to v2', async () => {
            const skeleton = createMockSkeleton();
            const uiMessages = [
                { author: 'user', text: 'Hello', timestamp: '2026-02-13T10:00:00Z' },
            ];
            // Version check returns v1 -> triggers re-archive
            vi.mocked(fs.readFile).mockResolvedValueOnce(
                Buffer.from('compressed-' + JSON.stringify({ version: 1, taskId: 'x', messages: [] })) as any
            );
            vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(uiMessages));
            vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
            vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            expect(fs.writeFile).toHaveBeenCalled();
        });

        it('should fallback to api_conversation_history.json if ui_messages absent', async () => {
            const skeleton = createMockSkeleton();
            const apiMessages = [
                { role: 'user', content: 'Hello API', timestamp: '2026-02-13T10:00:00Z' },
                { role: 'assistant', content: 'Response', timestamp: '2026-02-13T10:00:05Z' },
            ];

            missingArchive();
            vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
            vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(apiMessages));
            vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
            vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            expect(fs.writeFile).toHaveBeenCalled();
        });

        it('should silently return if no message files exist', async () => {
            const skeleton = createMockSkeleton();

            missingArchive();
            vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
            vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            expect(fs.writeFile).not.toHaveBeenCalled();
        });

        it('should preserve full content without truncation (v2 format)', async () => {
            // Regression guard: commit 8af5dc6f silently introduced a 10KB
            // per-message truncation without user request. v2 removes it.
            const skeleton = createMockSkeleton();
            const longContent = 'x'.repeat(60 * 1024); // 60KB, well beyond the old 10KB cap
            const uiMessages = [
                { author: 'user', text: longContent, timestamp: '2026-02-13T10:00:00Z' },
            ];

            missingArchive();
            vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(uiMessages));
            vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
            vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
            expect(writeCall).toBeDefined();
            const compressedStr = (writeCall[1] as Buffer).toString();
            const jsonStr = compressedStr.replace('compressed-', '');
            const archived = JSON.parse(jsonStr);
            expect(archived.version).toBe(2);
            expect(archived.messages[0].content.length).toBe(longContent.length);
            expect(archived.messages[0].content).not.toContain('[... truncated ...]');
        });

        it('should map agent author to assistant role', async () => {
            const skeleton = createMockSkeleton();
            const uiMessages = [
                { author: 'agent', text: 'I am the assistant', timestamp: '2026-02-13T10:00:00Z' },
            ];

            missingArchive();
            vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(uiMessages));
            vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
            vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
            const compressedStr = (writeCall[1] as Buffer).toString();
            const jsonStr = compressedStr.replace('compressed-', '');
            const archived = JSON.parse(jsonStr);
            expect(archived.messages[0].role).toBe('assistant');
        });

        it('should skip empty messages', async () => {
            const skeleton = createMockSkeleton();
            const uiMessages = [
                { author: 'user', text: '', timestamp: '2026-02-13T10:00:00Z' },
                { author: 'agent', text: 'Valid message', timestamp: '2026-02-13T10:00:05Z' },
                { author: 'user', text: '  ', timestamp: '2026-02-13T10:00:10Z' },
            ];

            missingArchive();
            vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(uiMessages));
            vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
            vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

            await TaskArchiver.archiveTask('test-task-123', '/task/path', skeleton);

            const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
            const compressedStr = (writeCall[1] as Buffer).toString();
            const jsonStr = compressedStr.replace('compressed-', '');
            const archived = JSON.parse(jsonStr);
            expect(archived.messages).toHaveLength(1);
            expect(archived.messages[0].content).toBe('Valid message');
        });
    });

    describe('readArchivedTask', () => {
        it('should read an archived task from any machine directory', async () => {
            const archivedData = {
                version: 1,
                taskId: 'test-task-456',
                machineId: 'other-machine',
                hostIdentifier: 'other-machine-win32-x64',
                archivedAt: '2026-02-13T12:00:00Z',
                metadata: { title: 'Test', messageCount: 2, isCompleted: false },
                messages: [
                    { role: 'user', content: 'Hello', timestamp: '2026-02-13T10:00:00Z' },
                    { role: 'assistant', content: 'Hi', timestamp: '2026-02-13T10:00:05Z' },
                ],
            };

            // readdir returns machine directories
            vi.mocked(fs.readdir).mockResolvedValueOnce(['other-machine'] as any);
            // readFile returns compressed archive
            const jsonStr = JSON.stringify(archivedData);
            vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from('compressed-' + jsonStr) as any);

            const result = await TaskArchiver.readArchivedTask('test-task-456');

            expect(result).not.toBeNull();
            expect(result!.taskId).toBe('test-task-456');
            expect(result!.machineId).toBe('other-machine');
            expect(result!.messages).toHaveLength(2);
        });

        it('should return null if archive directory does not exist', async () => {
            vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('ENOENT'));

            const result = await TaskArchiver.readArchivedTask('nonexistent-task');

            expect(result).toBeNull();
        });

        it('should search across multiple machine directories', async () => {
            vi.mocked(fs.readdir).mockResolvedValueOnce(['machine-a', 'machine-b'] as any);
            // machine-a doesn't have the task
            vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
            // machine-b has it
            const archivedData = {
                version: 1,
                taskId: 'cross-machine-task',
                machineId: 'machine-b',
                hostIdentifier: 'machine-b-linux-x64',
                archivedAt: '2026-02-13T12:00:00Z',
                metadata: { title: 'Cross', messageCount: 1, isCompleted: true },
                messages: [{ role: 'user', content: 'Found it', timestamp: '2026-02-13T10:00:00Z' }],
            };
            vi.mocked(fs.readFile).mockResolvedValueOnce(
                Buffer.from('compressed-' + JSON.stringify(archivedData)) as any
            );

            const result = await TaskArchiver.readArchivedTask('cross-machine-task');

            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('machine-b');
        });
    });

    describe('listArchivedTasks', () => {
        it('should list task IDs from all machines', async () => {
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(['machine-a', 'machine-b'] as any) // top-level dirs
                .mockResolvedValueOnce(['task-1.json.gz', 'task-2.json.gz'] as any) // machine-a
                .mockResolvedValueOnce(['task-3.json.gz'] as any); // machine-b

            const result = await TaskArchiver.listArchivedTasks();

            expect(result).toEqual(['task-1', 'task-2', 'task-3']);
        });

        it('should filter by machine_id', async () => {
            vi.mocked(fs.readdir)
                .mockResolvedValueOnce(['task-1.json.gz', 'task-2.json.gz'] as any);

            const result = await TaskArchiver.listArchivedTasks('specific-machine');

            expect(result).toEqual(['task-1', 'task-2']);
        });

        it('should return empty array if no archives exist', async () => {
            vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('ENOENT'));

            const result = await TaskArchiver.listArchivedTasks();

            expect(result).toEqual([]);
        });
    });
});
