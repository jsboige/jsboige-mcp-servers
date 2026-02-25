/**
 * Tests pour get_message.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockGetMessage, mockMarkAsRead } = vi.hoisted(() => ({
	mockGetMessage: vi.fn(),
	mockMarkAsRead: vi.fn()
}));

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

vi.mock('../../../services/MessageManager.js', () => ({
	MessageManager: class {
		constructor() {}
		getMessage(...args: any[]) { return mockGetMessage(...args); }
		markAsRead(...args: any[]) { return mockMarkAsRead(...args); }
	}
}));

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: mockGetSharedStatePath
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	Logger: class {}
}));

vi.mock('../../../types/errors.js', () => ({
	MessageManagerError: class extends Error {
		code: string;
		details: any;
		constructor(message: string, code: string, details?: any) {
			super(message);
			this.name = 'MessageManagerError';
			this.code = code;
			this.details = details;
		}
	},
	MessageManagerErrorCode: {
		INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT'
	}
}));

describe('get_message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
	});

	describe('parameter validation', () => {
		test('rejects missing message_id', async () => {
			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: '' });
			expect(result.content[0].text).toContain('Erreur');
		});
	});

	describe('message not found', () => {
		test('returns not found message', async () => {
			mockGetMessage.mockResolvedValue(null);

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'nonexistent' });

			expect(result.content[0].text).toContain('Message introuvable');
			expect(result.content[0].text).toContain('nonexistent');
		});
	});

	describe('successful retrieval', () => {
		const mockMsg = {
			id: 'msg-100',
			from: 'ai-01',
			to: 'po-2023',
			subject: 'Test Message',
			body: 'Hello world',
			priority: 'MEDIUM',
			timestamp: '2026-01-01T00:00:00Z',
			status: 'unread',
			tags: ['info', 'sync'],
			thread_id: 'thread-1',
			reply_to: 'msg-99'
		};

		test('returns formatted message details', async () => {
			mockGetMessage.mockResolvedValue(mockMsg);

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'msg-100' });

			expect(result.content[0].text).toContain('Test Message');
			expect(result.content[0].text).toContain('ai-01');
			expect(result.content[0].text).toContain('po-2023');
			expect(result.content[0].text).toContain('Hello world');
		});

		test('shows tags when present', async () => {
			mockGetMessage.mockResolvedValue(mockMsg);

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'msg-100' });

			expect(result.content[0].text).toContain('info');
			expect(result.content[0].text).toContain('sync');
		});

		test('shows thread_id when present', async () => {
			mockGetMessage.mockResolvedValue(mockMsg);

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'msg-100' });

			expect(result.content[0].text).toContain('thread-1');
		});

		test('shows reply_to when present', async () => {
			mockGetMessage.mockResolvedValue(mockMsg);

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'msg-100' });

			expect(result.content[0].text).toContain('msg-99');
		});

		test('marks as read when requested', async () => {
			mockGetMessage.mockResolvedValue({ ...mockMsg });
			mockMarkAsRead.mockResolvedValue(undefined);

			const { getMessage } = await import('../get_message.js');
			await getMessage({ message_id: 'msg-100', mark_as_read: true });

			expect(mockMarkAsRead).toHaveBeenCalledWith('msg-100');
		});

		test('does not mark as read when not requested', async () => {
			mockGetMessage.mockResolvedValue({ ...mockMsg, status: 'unread' });

			const { getMessage } = await import('../get_message.js');
			await getMessage({ message_id: 'msg-100' });

			expect(mockMarkAsRead).not.toHaveBeenCalled();
		});

		test('does not mark already-read messages', async () => {
			mockGetMessage.mockResolvedValue({ ...mockMsg, status: 'read' });

			const { getMessage } = await import('../get_message.js');
			await getMessage({ message_id: 'msg-100', mark_as_read: true });

			expect(mockMarkAsRead).not.toHaveBeenCalled();
		});

		test('suggests mark as read for unread messages', async () => {
			mockGetMessage.mockResolvedValue({ ...mockMsg, status: 'unread' });

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'msg-100' });

			expect(result.content[0].text).toContain('Marquer comme lu');
		});
	});

	describe('error handling', () => {
		test('returns error on failure', async () => {
			mockGetMessage.mockRejectedValue(new Error('File read error'));

			const { getMessage } = await import('../get_message.js');
			const result = await getMessage({ message_id: 'msg-err' });

			expect(result.content[0].text).toContain('Erreur');
			expect(result.content[0].text).toContain('File read error');
		});
	});
});
