/**
 * Tests for roosync_cleanup_messages tool
 *
 * Covers: operation=mark_read/archive, filter combinations,
 * verbose mode, formatCleanupResult, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanupMessages, cleanupToolMetadata } from '../../../../src/tools/roosync/cleanup.js';

const {
    mockGetMessageManager,
    mockGetLocalMachineId,
    mockBulkOperation,
} = vi.hoisted(() => ({
    mockGetMessageManager: vi.fn(),
    mockGetLocalMachineId: vi.fn(() => 'test-machine'),
    mockBulkOperation: vi.fn(),
}));

vi.mock('../../../../src/services/MessageManager.js', () => ({
    getMessageManager: mockGetMessageManager,
}));

vi.mock('../../../../src/utils/message-helpers.js', () => ({
    getLocalMachineId: mockGetLocalMachineId,
}));

vi.mock('../../../../src/utils/logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    }),
}));

describe('roosync_cleanup_messages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMessageManager.mockReturnValue({
            bulkOperation: mockBulkOperation,
        });
    });

    describe('operation=mark_read', () => {
        it('marks messages as read with priority filter', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read',
                matched: 5,
                processed: 5,
                errors: 0,
                message_ids: ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'],
            });
            const result = await cleanupMessages({ operation: 'mark_read', priority: 'LOW' });
            const text = result.content[0].text;
            expect(text).toContain('mark_read');
            expect(text).toContain('5');
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { priority: 'LOW' }
            );
        });

        it('passes from filter', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 2, processed: 2, errors: 0, message_ids: ['a', 'b'],
            });
            await cleanupMessages({ operation: 'mark_read', from: 'test-machine' });
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { from: 'test-machine' }
            );
        });

        it('passes before_date filter', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 0, processed: 0, errors: 0, message_ids: [],
            });
            await cleanupMessages({ operation: 'mark_read', before_date: '2026-02-01T00:00:00Z' });
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { before_date: '2026-02-01T00:00:00Z' }
            );
        });

        it('passes subject_contains filter', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 0, processed: 0, errors: 0, message_ids: [],
            });
            await cleanupMessages({ operation: 'mark_read', subject_contains: 'test' });
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { subject_contains: 'test' }
            );
        });

        it('passes tag filter', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 0, processed: 0, errors: 0, message_ids: [],
            });
            await cleanupMessages({ operation: 'mark_read', tag: 'DONE' });
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { tag: 'DONE' }
            );
        });

        it('passes status filter', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 0, processed: 0, errors: 0, message_ids: [],
            });
            await cleanupMessages({ operation: 'mark_read', status: 'unread' });
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { status: 'unread' }
            );
        });

        it('combines multiple filters', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read', matched: 1, processed: 1, errors: 0, message_ids: ['x'],
            });
            await cleanupMessages({
                operation: 'mark_read',
                priority: 'LOW',
                from: 'test-machine',
                status: 'unread',
            });
            expect(mockBulkOperation).toHaveBeenCalledWith(
                'test-machine',
                'mark_read',
                { priority: 'LOW', from: 'test-machine', status: 'unread' }
            );
        });
    });

    describe('operation=archive', () => {
        it('archives messages with filters', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'archive', matched: 3, processed: 3, errors: 0, message_ids: ['a', 'b', 'c'],
            });
            const result = await cleanupMessages({ operation: 'archive', before_date: '2026-01-01T00:00:00Z' });
            const text = result.content[0].text;
            expect(text).toContain('archive');
            expect(text).toContain('3');
        });
    });

    describe('verbose mode', () => {
        it('shows message IDs when verbose=true (default)', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read',
                matched: 2,
                processed: 2,
                errors: 0,
                message_ids: ['msg-alpha', 'msg-beta'],
            });
            const result = await cleanupMessages({ operation: 'mark_read' });
            const text = result.content[0].text;
            expect(text).toContain('msg-alpha');
            expect(text).toContain('msg-beta');
        });

        it('hides message IDs when verbose=false', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read',
                matched: 2,
                processed: 2,
                errors: 0,
                message_ids: ['msg-alpha', 'msg-beta'],
            });
            const result = await cleanupMessages({ operation: 'mark_read', verbose: false });
            const text = result.content[0].text;
            expect(text).not.toContain('msg-alpha');
        });

        it('truncates IDs when more than 20', async () => {
            const ids = Array.from({ length: 25 }, (_, i) => `msg-${i}`);
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read',
                matched: 25,
                processed: 25,
                errors: 0,
                message_ids: ids,
            });
            const result = await cleanupMessages({ operation: 'mark_read' });
            const text = result.content[0].text;
            expect(text).toContain('et 5 autres');
        });

        it('shows failed IDs when errors > 0', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read',
                matched: 3,
                processed: 2,
                errors: 1,
                message_ids: ['ok-1', 'ok-2'],
                failed_ids: ['fail-1'],
            });
            const result = await cleanupMessages({ operation: 'mark_read' });
            const text = result.content[0].text;
            expect(text).toContain('fail-1');
            expect(text).toContain('IDs en échec');
        });

        it('handles null failed_ids as empty', async () => {
            mockBulkOperation.mockResolvedValue({
                operation: 'mark_read',
                matched: 1,
                processed: 1,
                errors: 0,
                message_ids: ['ok-1'],
                failed_ids: undefined as any,
            });
            const result = await cleanupMessages({ operation: 'mark_read' });
            const text = result.content[0].text;
            expect(text).not.toContain('IDs en échec');
        });
    });

    describe('error handling', () => {
        it('returns error message on exception', async () => {
            mockBulkOperation.mockRejectedValue(new Error('Disk full'));
            const result = await cleanupMessages({ operation: 'mark_read' });
            const text = result.content[0].text;
            expect(text).toContain('Erreur');
            expect(text).toContain('Disk full');
        });

        it('returns error on non-Error exception', async () => {
            mockBulkOperation.mockRejectedValue('string error');
            const result = await cleanupMessages({ operation: 'archive' });
            const text = result.content[0].text;
            expect(text).toContain('Erreur');
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(cleanupToolMetadata.name).toBe('roosync_cleanup_messages');
            expect(cleanupToolMetadata.inputSchema.required).toContain('operation');
            expect(cleanupToolMetadata.inputSchema.properties.operation.enum).toContain('mark_read');
            expect(cleanupToolMetadata.inputSchema.properties.operation.enum).toContain('archive');
        });
    });
});
