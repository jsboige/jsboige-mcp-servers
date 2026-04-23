import { describe, it, expect } from 'vitest';
import { handleSearchTasksSemanticFallback, type SearchFallbackArgs } from '../search-fallback.tool.js';

function makeSkeleton(taskId: string, sequence: Array<{ role: string; content: string }>) {
    return {
        taskId,
        parentTaskId: undefined,
        metadata: {
            title: `Task ${taskId}`,
            lastActivity: '2026-04-24T00:00:00Z',
            messageCount: sequence.length,
            totalSize: 100,
            actionCount: 0,
            createdAt: '2026-04-24T00:00:00Z',
        },
        sequence,
    };
}

describe('search-fallback.tool', () => {
    describe('global search (no conversation_id)', () => {
        it('should find matching conversations by exact content match', async () => {
            const cache = new Map([
                ['task-1', makeSkeleton('task-1', [
                    { role: 'user', content: 'Fix the bug in login.ts' },
                    { role: 'assistant', content: 'Looking at the login module.' },
                ])],
                ['task-2', makeSkeleton('task-2', [
                    { role: 'user', content: 'Update the README documentation' },
                    { role: 'assistant', content: 'Updating docs now.' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { search_query: 'login.ts' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(1);
            expect((result.content[0] as any).taskId).toBe('task-1');
        });

        it('should return empty results when no match', async () => {
            const cache = new Map([
                ['task-1', makeSkeleton('task-1', [
                    { role: 'user', content: 'Fix the bug' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { search_query: 'quantum computing' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(0);
        });

        it('should return empty results for empty cache', async () => {
            const cache = new Map();

            const result = await handleSearchTasksSemanticFallback(
                { search_query: 'anything' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(0);
        });

        it('should respect max_results limit', async () => {
            const cache = new Map();
            for (let i = 0; i < 5; i++) {
                cache.set(`task-${i}`, makeSkeleton(`task-${i}`, [
                    { role: 'user', content: `Test query matching item ${i}` },
                ]));
            }

            const result = await handleSearchTasksSemanticFallback(
                { search_query: 'query', max_results: 2 } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(2);
        });

        it('should treat "undefined" string as no conversation_id', async () => {
            const cache = new Map([
                ['task-1', makeSkeleton('task-1', [
                    { role: 'user', content: 'Find this content' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { conversation_id: 'undefined', search_query: 'Find' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(1);
        });

        it('should do word-level matching for queries >= 3 chars', async () => {
            const cache = new Map([
                ['task-1', makeSkeleton('task-1', [
                    { role: 'user', content: 'User message 1 with extra words' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { search_query: 'User message' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(1);
        });
    });

    describe('specific conversation search', () => {
        it('should search within a specific conversation', async () => {
            const cache = new Map([
                ['conv-1', makeSkeleton('conv-1', [
                    { role: 'user', content: 'Fix login authentication' },
                    { role: 'assistant', content: 'Looking at auth module' },
                    { role: 'user', content: 'Also check the registration page' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { conversation_id: 'conv-1', search_query: 'login' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(1);
            expect((result.content[0] as any).taskId).toBe('conv-1');
        });

        it('should throw when conversation not found in cache', async () => {
            const cache = new Map();

            await expect(
                handleSearchTasksSemanticFallback(
                    { conversation_id: 'nonexistent', search_query: 'test' } as SearchFallbackArgs,
                    cache,
                ),
            ).rejects.toThrow("not found in cache");
        });

        it('should return empty when query does not match any content', async () => {
            const cache = new Map([
                ['conv-1', makeSkeleton('conv-1', [
                    { role: 'user', content: 'Fix the bug in parser' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { conversation_id: 'conv-1', search_query: 'unrelated' } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(0);
        });

        it('should respect max_results in specific conversation search', async () => {
            const cache = new Map([
                ['conv-1', makeSkeleton('conv-1', [
                    { role: 'user', content: 'test query alpha' },
                    { role: 'assistant', content: 'test query beta' },
                    { role: 'user', content: 'test query gamma' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { conversation_id: 'conv-1', search_query: 'test query', max_results: 2 } as SearchFallbackArgs,
                cache,
            );

            expect(result.isError).toBe(false);
            expect(result.content).toHaveLength(2);
        });
    });

    describe('result metadata', () => {
        it('should include task metadata in global search results', async () => {
            const cache = new Map([
                ['task-1', makeSkeleton('task-1', [
                    { role: 'user', content: 'Deploy to production' },
                ])],
            ]);

            const result = await handleSearchTasksSemanticFallback(
                { search_query: 'Deploy' } as SearchFallbackArgs,
                cache,
            );

            const item = result.content[0] as any;
            expect(item.score).toBe(1.0);
            expect(item.metadata.task_title).toBe('Task task-1');
            expect(item.metadata.message_count).toBe(1);
            expect(item.match).toContain('user');
        });
    });
});
