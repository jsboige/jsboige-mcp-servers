/**
 * Tests pour send_message.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockSendMessage } = vi.hoisted(() => ({
	mockSendMessage: vi.fn()
}));

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

const { mockHostname } = vi.hoisted(() => ({
	mockHostname: vi.fn()
}));

vi.mock('../../../services/MessageManager.js', () => {
	const mockInstance = {
		sendMessage: (...args: any[]) => mockSendMessage(...args),
	};
	return {
		MessageManager: class {
			constructor() {}
			sendMessage(...args: any[]) { return mockSendMessage(...args); }
		},
		getMessageManager: () => mockInstance,
	};
});

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: mockGetSharedStatePath
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return { ...actual, default: actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return { ...actual, default: { ...actual, hostname: mockHostname }, hostname: mockHostname };
});

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
import { sendMessage } from '../send_message.js';

describe('send_message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
		mockHostname.mockReturnValue('test-machine');
	});

	describe('parameter validation', () => {
		test('rejects missing to', async () => {
			const result = await sendMessage({ to: '', subject: 'Test', body: 'Hello' });
			expect(result.content[0].text).toContain('Erreur');
		});

		test('rejects missing subject', async () => {
			const result = await sendMessage({ to: 'ai-01', subject: '', body: 'Hello' });
			expect(result.content[0].text).toContain('Erreur');
		});

		test('rejects missing body', async () => {
			const result = await sendMessage({ to: 'ai-01', subject: 'Test', body: '' });
			expect(result.content[0].text).toContain('Erreur');
		});
	});

	describe('successful send', () => {
		test('sends message with all required fields', async () => {
			mockSendMessage.mockResolvedValue({
				id: 'msg-001',
				from: 'test-machine',
				to: 'ai-01',
				subject: 'Test',
				priority: 'MEDIUM',
				timestamp: '2026-01-01T00:00:00Z'
			});

			const result = await sendMessage({
				to: 'ai-01',
				subject: 'Test',
				body: 'Hello'
			});

			expect(result.content[0].text).toContain('Message envoyé avec succès');
			expect(result.content[0].text).toContain('msg-001');
		});

		test('passes priority and tags', async () => {
			mockSendMessage.mockResolvedValue({
				id: 'msg-002',
				from: 'test-machine',
				to: 'po-2023',
				subject: 'Urgent',
				priority: 'HIGH',
				timestamp: '2026-01-01T00:00:00Z'
			});

			await sendMessage({
				to: 'po-2023',
				subject: 'Urgent',
				body: 'Fix required',
				priority: 'HIGH',
				tags: ['fix', 'critical']
			});

			expect(mockSendMessage).toHaveBeenCalledWith(
				'test-machine', 'po-2023', 'Urgent', 'Fix required',
				'HIGH', ['fix', 'critical'], undefined, undefined
			);
		});

		test('passes thread_id and reply_to', async () => {
			mockSendMessage.mockResolvedValue({
				id: 'msg-003',
				from: 'test-machine',
				to: 'ai-01',
				subject: 'Re: Thread',
				priority: 'MEDIUM',
				timestamp: '2026-01-01T00:00:00Z'
			});

			await sendMessage({
				to: 'ai-01',
				subject: 'Re: Thread',
				body: 'Reply text',
				thread_id: 'thread-1',
				reply_to: 'msg-original'
			});

			expect(mockSendMessage).toHaveBeenCalledWith(
				'test-machine', 'ai-01', 'Re: Thread', 'Reply text',
				'MEDIUM', undefined, 'thread-1', 'msg-original'
			);
		});
	});

	describe('error handling', () => {
		test('returns error on send failure', async () => {
			mockSendMessage.mockRejectedValue(new Error('Write permission denied'));

			const result = await sendMessage({
				to: 'ai-01',
				subject: 'Test',
				body: 'Hello'
			});

			expect(result.content[0].text).toContain('Erreur');
			expect(result.content[0].text).toContain('Write permission denied');
		});
	});
});
