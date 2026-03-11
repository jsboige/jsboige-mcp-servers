/**
 * Tests pour mark_message_read.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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
			super(message); this.name = 'MessageManagerError'; this.code = code; this.details = details;
		}
	},
	MessageManagerErrorCode: { INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT' }
}));

// Fix #636 timeout: Use static import instead of dynamic imports
import { markMessageRead } from '../mark_message_read.js';

describe('mark_message_read', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
	});

	test('rejects missing message_id', async () => {
		const result = await markMessageRead({ message_id: '' });
		expect(result.content[0].text).toContain('Erreur');
	});

	test('returns not found for nonexistent message', async () => {
		mockGetMessage.mockResolvedValue(null);
		const result = await markMessageRead({ message_id: 'missing' });
		expect(result.content[0].text).toContain('Message introuvable');
	});

	test('returns already read for read messages', async () => {
		mockGetMessage.mockResolvedValue({
			id: 'msg-1', from: 'ai-01', to: 'po-2023',
			subject: 'Test', timestamp: '2026-01-01T00:00:00Z', status: 'read'
		});
		const result = await markMessageRead({ message_id: 'msg-1' });
		expect(result.content[0].text).toContain('déjà marqué comme lu');
	});

	test('marks unread message as read', async () => {
		mockGetMessage
			.mockResolvedValueOnce({
				id: 'msg-2', from: 'ai-01', to: 'po-2023',
				subject: 'New Message', timestamp: '2026-01-01T00:00:00Z', status: 'unread'
			})
			.mockResolvedValueOnce({
				id: 'msg-2', from: 'ai-01', to: 'po-2023',
				subject: 'New Message', timestamp: '2026-01-01T00:00:00Z', status: 'read'
			});
		mockMarkAsRead.mockResolvedValue(undefined);

		const result = await markMessageRead({ message_id: 'msg-2' });

		expect(result.content[0].text).toContain('Message marqué comme lu');
		expect(result.content[0].text).toContain('UNREAD');
		expect(result.content[0].text).toContain('READ');
		expect(mockMarkAsRead).toHaveBeenCalledWith('msg-2', expect.any(String));
	});

	test('returns error on failure', async () => {
		mockGetMessage.mockResolvedValue({
			id: 'msg-3', from: 'ai-01', to: 'po-2023',
			subject: 'Fail', timestamp: '2026-01-01T00:00:00Z', status: 'unread'
		});
		mockMarkAsRead.mockRejectedValue(new Error('Write failed'));

		const result = await markMessageRead({ message_id: 'msg-3' });
		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('Write failed');
	});
});
