/**
 * Tests pour reply_message.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockGetMessage, mockSendMessage } = vi.hoisted(() => ({
	mockGetMessage: vi.fn(),
	mockSendMessage: vi.fn()
}));

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

vi.mock('../../../services/MessageManager.js', () => ({
	MessageManager: class {
		constructor() {}
		getMessage(...args: any[]) { return mockGetMessage(...args); }
		sendMessage(...args: any[]) { return mockSendMessage(...args); }
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

vi.mock('../../../utils/message-helpers.js', () => ({
	getLocalFullId: vi.fn(() => 'myia-ai-01:roo-extensions')  // Mock local machine ID
}));

// Fix #636 timeout: Use static import instead of dynamic imports
import { replyMessage } from '../reply_message.js';

describe('reply_message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
	});

	describe('parameter validation', () => {
		test('rejects missing message_id', async () => {
			const result = await replyMessage({ message_id: '', body: 'Reply text' });
			expect(result.content[0].text).toContain('Erreur');
		});

		test('rejects missing body', async () => {
			const result = await replyMessage({ message_id: 'msg-1', body: '' });
			expect(result.content[0].text).toContain('Erreur');
		});
	});

	describe('original message not found', () => {
		test('returns not found message', async () => {
			mockGetMessage.mockResolvedValue(null);

			const result = await replyMessage({ message_id: 'nonexistent', body: 'Reply' });

			expect(result.content[0].text).toContain('Message original introuvable');
			expect(result.content[0].text).toContain('nonexistent');
		});
	});

	describe('successful reply', () => {
		const mockOriginal = {
			id: 'msg-original',
			from: 'ai-01',
			to: 'po-2023',
			subject: 'Test Subject',
			body: 'Original body',
			priority: 'MEDIUM',
			timestamp: '2026-01-01T00:00:00Z',
			tags: ['info'],
			thread_id: null,
			reply_to: null,
			status: 'unread'
		};

		test('inverts from/to for reply', async () => {
			mockGetMessage.mockResolvedValue(mockOriginal);
			mockSendMessage.mockResolvedValue({
				id: 'msg-reply',
				timestamp: '2026-01-02T00:00:00Z'
			});

			await replyMessage({ message_id: 'msg-original', body: 'My reply' });

			// from should be replier's machine, to should be original.from
			expect(mockSendMessage).toHaveBeenCalledWith(
				'myia-ai-01:roo-extensions',      // from = replier's machine
				'ai-01',        // to = original.from
				'Re: Test Subject',
				'My reply',
				'MEDIUM',
				['reply'],
				'msg-original', // thread_id = original.id when no thread
				'msg-original'  // reply_to = original message id
			);
		});

		test('adds Re: prefix to subject', async () => {
			mockGetMessage.mockResolvedValue(mockOriginal);
			mockSendMessage.mockResolvedValue({ id: 'msg-reply', timestamp: '2026-01-02T00:00:00Z' });

			const result = await replyMessage({ message_id: 'msg-original', body: 'Reply' });

			expect(result.content[0].text).toContain('Re: Test Subject');
		});

		test('does not double Re: prefix', async () => {
			mockGetMessage.mockResolvedValue({ ...mockOriginal, subject: 'Re: Already replied' });
			mockSendMessage.mockResolvedValue({ id: 'msg-reply2', timestamp: '2026-01-02T00:00:00Z' });

			await replyMessage({ message_id: 'msg-original', body: 'Reply again' });

			// Should NOT become "Re: Re: Already replied"
			expect(mockSendMessage.mock.calls[0][2]).toBe('Re: Already replied');
		});

		test('uses existing thread_id when present', async () => {
			mockGetMessage.mockResolvedValue({ ...mockOriginal, thread_id: 'existing-thread' });
			mockSendMessage.mockResolvedValue({ id: 'msg-reply3', timestamp: '2026-01-02T00:00:00Z' });

			await replyMessage({ message_id: 'msg-original', body: 'Reply' });

			expect(mockSendMessage.mock.calls[0][6]).toBe('existing-thread');
		});

		test('overrides priority when specified', async () => {
			mockGetMessage.mockResolvedValue(mockOriginal);
			mockSendMessage.mockResolvedValue({ id: 'msg-reply4', timestamp: '2026-01-02T00:00:00Z' });

			await replyMessage({ message_id: 'msg-original', body: 'Urgent reply', priority: 'HIGH' });

			expect(mockSendMessage.mock.calls[0][4]).toBe('HIGH');
		});

		test('includes reply tag plus custom tags', async () => {
			mockGetMessage.mockResolvedValue(mockOriginal);
			mockSendMessage.mockResolvedValue({ id: 'msg-reply5', timestamp: '2026-01-02T00:00:00Z' });

			await replyMessage({ message_id: 'msg-original', body: 'Tagged', tags: ['ack', 'done'] });

			expect(mockSendMessage.mock.calls[0][5]).toEqual(['ack', 'done', 'reply']);
		});

		test('returns success with reply details', async () => {
			mockGetMessage.mockResolvedValue(mockOriginal);
			mockSendMessage.mockResolvedValue({ id: 'msg-reply6', timestamp: '2026-01-02T00:00:00Z' });

			const result = await replyMessage({ message_id: 'msg-original', body: 'My reply' });

			expect(result.content[0].text).toContain('Réponse envoyée avec succès');
			expect(result.content[0].text).toContain('msg-reply6');
		});
	});

	describe('error handling', () => {
		test('returns error on send failure', async () => {
			mockGetMessage.mockResolvedValue({
				id: 'msg-1', from: 'ai-01', to: 'po-2023',
				subject: 'Test', priority: 'MEDIUM', timestamp: '2026-01-01T00:00:00Z'
			});
			mockSendMessage.mockRejectedValue(new Error('Disk full'));

			const result = await replyMessage({ message_id: 'msg-1', body: 'Reply' });

			expect(result.content[0].text).toContain('Erreur');
			expect(result.content[0].text).toContain('Disk full');
		});
	});
});
