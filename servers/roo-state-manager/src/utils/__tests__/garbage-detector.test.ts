/**
 * Tests for garbage-detector.ts
 * #1786 — Detect exploded/garbage tasks in skeleton cache
 *
 * @module utils/__tests__/garbage-detector
 */

import { describe, test, expect } from 'vitest';
import { detectGarbage, scanForGarbage } from '../garbage-detector.js';
import { ConversationSkeleton } from '../../types/conversation.js';

function makeSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
    return {
        taskId: 'test-task',
        metadata: {
            title: 'Test',
            lastActivity: '2026-04-28T10:00:00Z',
            createdAt: '2026-04-28T10:00:00Z',
            messageCount: 0,
            actionCount: 0,
            totalSize: 1000,
            ...overrides.metadata,
        },
        sequence: [],
        ...overrides,
    };
}

describe('detectGarbage', () => {
    test('clean task with real content is not garbage', () => {
        const skeleton = makeSkeleton({
            metadata: { messageCount: 10, actionCount: 5, totalSize: 5000, lastActivity: '', createdAt: '' },
            sequence: [
                { role: 'user', content: 'Read the file src/main.ts', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'I have read the file. It contains the main entry point with Express setup and route definitions.', timestamp: '', isTruncated: false },
                { role: 'user', content: 'Add error handling', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'Added try-catch blocks around the database connection and route handlers.', timestamp: '', isTruncated: false },
                { role: 'user', content: 'Run the tests', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'All 42 tests pass. The changes are working correctly.', timestamp: '', isTruncated: false },
            ],
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(false);
    });

    test('task with only 502 errors is garbage (high confidence)', () => {
        const skeleton = makeSkeleton({
            metadata: { messageCount: 20, actionCount: 0, totalSize: 200_000, lastActivity: '', createdAt: '' },
            sequence: Array.from({ length: 20 }, (_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: '502 Bad Gateway - API request failed. Retrying in 5 seconds...',
                timestamp: '',
                isTruncated: false,
            })),
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(true);
        expect(result.confidence).toBe('high');
        expect(result.errorMessages).toBe(20);
    });

    test('large task with zero assistant output is garbage', () => {
        const skeleton = makeSkeleton({
            metadata: { messageCount: 15, actionCount: 0, totalSize: 600_000, lastActivity: '', createdAt: '' },
            sequence: [
                { role: 'user', content: 'Do something', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'MCP connection timeout error. Failed to connect to server.', timestamp: '', isTruncated: false },
                ...Array.from({ length: 13 }, (_, i) => ({
                    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: `Error: 502 Bad Gateway - retry attempt ${Math.floor(i / 2) + 1}`,
                    timestamp: '',
                    isTruncated: false,
                })),
            ],
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(true);
        expect(result.confidence).toBe('high');
    });

    test('short task with few errors is not garbage', () => {
        const skeleton = makeSkeleton({
            metadata: { messageCount: 3, actionCount: 0, totalSize: 500, lastActivity: '', createdAt: '' },
            sequence: [
                { role: 'user', content: 'Hello', timestamp: '', isTruncated: false },
                { role: 'assistant', content: '502 Bad Gateway', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'Sorry about that. How can I help?', timestamp: '', isTruncated: false },
            ],
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(false);
    });

    test('mixed task with some errors but real output is not garbage', () => {
        const skeleton = makeSkeleton({
            metadata: { messageCount: 12, actionCount: 3, totalSize: 15_000, lastActivity: '', createdAt: '' },
            sequence: [
                { role: 'user', content: 'Fix the build error', timestamp: '', isTruncated: false },
                { role: 'assistant', content: '502 Bad Gateway - API request failed', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'Retrying... Found the issue: missing import in module.ts. Adding the import statement now.', timestamp: '', isTruncated: false },
                { role: 'user', content: 'Run the tests again', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'Tests pass now. All 24 tests successful.', timestamp: '', isTruncated: false },
                { role: 'user', content: 'Commit the changes', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'Committed as abc123. The import fix resolves the build error.', timestamp: '', isTruncated: false },
            ],
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(false);
    });

    test('empty sequence is not garbage', () => {
        const skeleton = makeSkeleton({
            metadata: { messageCount: 0, actionCount: 0, totalSize: 100, lastActivity: '', createdAt: '' },
            sequence: [],
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(false);
    });

    test('task with all identical error messages gets high repetition score', () => {
        const errorMsg = 'Error: MCP connection timeout. Failed to connect.';
        const skeleton = makeSkeleton({
            metadata: { messageCount: 10, actionCount: 0, totalSize: 50_000, lastActivity: '', createdAt: '' },
            sequence: Array.from({ length: 10 }, () => ({
                role: 'assistant' as const,
                content: errorMsg,
                timestamp: '',
                isTruncated: false,
            })),
        });

        const result = detectGarbage(skeleton);
        expect(result.isGarbage).toBe(true);
        expect(result.scores.repetitionScore).toBeGreaterThan(0.8);
    });
});

describe('scanForGarbage', () => {
    test('returns only garbage tasks from cache', () => {
        const cache = new Map<string, ConversationSkeleton>();

        // Clean task
        cache.set('clean-1', makeSkeleton({
            taskId: 'clean-1',
            metadata: { messageCount: 10, actionCount: 5, totalSize: 5000, lastActivity: '', createdAt: '' },
            sequence: [
                { role: 'user', content: 'Read file', timestamp: '', isTruncated: false },
                { role: 'assistant', content: 'File content loaded. Here is the analysis of the code structure.', timestamp: '', isTruncated: false },
            ],
        }));

        // Garbage task
        cache.set('garbage-1', makeSkeleton({
            taskId: 'garbage-1',
            metadata: { messageCount: 20, actionCount: 0, totalSize: 200_000, lastActivity: '', createdAt: '' },
            sequence: Array.from({ length: 20 }, (_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: '502 Bad Gateway - API request failed. Retrying...',
                timestamp: '',
                isTruncated: false,
            })),
        }));

        const results = scanForGarbage(cache);
        expect(results.length).toBe(1);
        expect(results[0].taskId).toBe('garbage-1');
    });

    test('respects minConfidence filter', () => {
        const cache = new Map<string, ConversationSkeleton>();

        // Medium confidence garbage (error loop but some variation)
        cache.set('med-1', makeSkeleton({
            taskId: 'med-1',
            metadata: { messageCount: 8, actionCount: 0, totalSize: 30_000, lastActivity: '', createdAt: '' },
            sequence: [
                { role: 'user', content: 'Task instruction', timestamp: '', isTruncated: false },
                ...Array.from({ length: 7 }, (_, i) => ({
                    role: 'assistant' as const,
                    content: `Error: 502 Bad Gateway attempt ${i + 1}`,
                    timestamp: '',
                    isTruncated: false,
                })),
            ],
        }));

        const lowResults = scanForGarbage(cache, { minConfidence: 'low' });
        const highResults = scanForGarbage(cache, { minConfidence: 'high' });
        expect(lowResults.length).toBeGreaterThanOrEqual(highResults.length);
    });

    test('empty cache returns empty array', () => {
        const cache = new Map<string, ConversationSkeleton>();
        const results = scanForGarbage(cache);
        expect(results).toEqual([]);
    });
});
