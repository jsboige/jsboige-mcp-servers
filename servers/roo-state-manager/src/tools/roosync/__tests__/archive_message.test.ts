/**
 * Tests pour archive_message.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockGetMessage, mockArchiveMessage } = vi.hoisted(() => ({
	mockGetMessage: vi.fn(),
	mockArchiveMessage: vi.fn()
}));

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

vi.mock('../../../services/MessageManager.js', () => {
	const mockInstance = {
		getMessage: (...args: any[]) => mockGetMessage(...args),
		archiveMessage: (...args: any[]) => mockArchiveMessage(...args),
	};
	return {
		MessageManager: class {
			constructor() {}
			getMessage(...args: any[]) { return mockGetMessage(...args); }
			archiveMessage(...args: any[]) { return mockArchiveMessage(...args); }
		},
		getMessageManager: () => mockInstance,
	};
});

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

// Fix #636 timeout: Use static import instead of dynamic imports
import { archiveMessage } from '../archive_message.js';

describe('archive_message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
		delete process.env.ROOSYNC_TEST_PATH;
	});

	describe('parameter validation', () => {
		test('rejects missing message_id', async () => {
			const result = await archiveMessage({ message_id: '' });
			expect(result.content[0].text).toContain('Erreur');
		});
	});

	describe('message not found', () => {
		test('returns not found message', async () => {
			mockGetMessage.mockResolvedValue(null);

			const result = await archiveMessage({ message_id: 'nonexistent' });

			expect(result.content[0].text).toContain('Message introuvable');
		});
	});

	describe('already archived', () => {
		test('returns already archived info', async () => {
			mockGetMessage.mockResolvedValue({
				id: 'msg-archived',
				from: 'ai-01',
				to: 'po-2023',
				subject: 'Old Message',
				timestamp: '2026-01-01T00:00:00Z',
				status: 'archived'
			});

			const result = await archiveMessage({ message_id: 'msg-archived' });

			expect(result.content[0].text).toContain('déjà archivé');
		});
	});

	describe('successful archival', () => {
		const mockMsg = {
			id: 'msg-200',
			from: 'ai-01',
			to: 'po-2023',
			subject: 'Archive Me',
			body: 'Some content',
			priority: 'LOW',
			timestamp: '2026-01-01T00:00:00Z',
			status: 'read',
			thread_id: 'thread-5'
		};

		test('archives message and returns success', async () => {
			mockGetMessage.mockResolvedValueOnce(mockMsg).mockResolvedValueOnce({ ...mockMsg, status: 'archived' });
			mockArchiveMessage.mockResolvedValue(undefined);

			const result = await archiveMessage({ message_id: 'msg-200' });

			expect(result.content[0].text).toContain('Message archivé avec succès');
			expect(mockArchiveMessage).toHaveBeenCalledWith('msg-200');
		});

		test('shows status transition', async () => {
			mockGetMessage.mockResolvedValueOnce(mockMsg).mockResolvedValueOnce({ ...mockMsg, status: 'archived' });
			mockArchiveMessage.mockResolvedValue(undefined);

			const result = await archiveMessage({ message_id: 'msg-200' });

			expect(result.content[0].text).toContain('READ');
			expect(result.content[0].text).toContain('ARCHIVED');
		});

		test('shows archive location', async () => {
			mockGetMessage.mockResolvedValueOnce(mockMsg).mockResolvedValueOnce({ ...mockMsg, status: 'archived' });
			mockArchiveMessage.mockResolvedValue(undefined);

			const result = await archiveMessage({ message_id: 'msg-200' });

			expect(result.content[0].text).toContain('messages/archive/msg-200.json');
		});

		test('shows thread link when thread_id present', async () => {
			mockGetMessage.mockResolvedValueOnce(mockMsg).mockResolvedValueOnce({ ...mockMsg, status: 'archived' });
			mockArchiveMessage.mockResolvedValue(undefined);

			const result = await archiveMessage({ message_id: 'msg-200' });

			expect(result.content[0].text).toContain('thread');
		});
	});

	describe('error handling', () => {
		test('returns error on archive failure', async () => {
			mockGetMessage.mockResolvedValue({
				id: 'msg-fail', from: 'ai-01', to: 'po-2023',
				subject: 'Fail', timestamp: '2026-01-01T00:00:00Z', status: 'read'
			});
			mockArchiveMessage.mockRejectedValue(new Error('Permission denied'));

			const result = await archiveMessage({ message_id: 'msg-fail' });

			expect(result.content[0].text).toContain('Erreur');
			expect(result.content[0].text).toContain('Permission denied');
		});
	});
});
