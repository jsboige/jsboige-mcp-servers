/**
 * Tests pour amend_message.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockAmendMessage } = vi.hoisted(() => ({
	mockAmendMessage: vi.fn()
}));

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

const { mockHostname } = vi.hoisted(() => ({
	mockHostname: vi.fn()
}));

vi.mock('../../../services/MessageManager.js', () => ({
	MessageManager: class {
		constructor() {}
		amendMessage(...args: any[]) { return mockAmendMessage(...args); }
	}
}));

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: mockGetSharedStatePath
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn()
	};
});

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return {
		...actual,
		default: { ...actual, hostname: mockHostname },
		hostname: mockHostname
	};
});

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	})),
	Logger: class {}
}));

// Mock message-helpers to control getLocalFullId behavior
const { mockGetLocalFullId } = vi.hoisted(() => ({
	mockGetLocalFullId: vi.fn()
}));

vi.mock('../../../utils/message-helpers.js', () => ({
	getLocalFullId: mockGetLocalFullId
}));

vi.mock('../../../types/errors.js', () => ({
	StateManagerError: class extends Error {
		code: string;
		source: string;
		details: any;
		constructor(message: string, code: string, source: string, details?: any) {
			super(message);
			this.name = 'StateManagerError';
			this.code = code;
			this.source = source;
			this.details = details;
		}
	}
}));

// Fix #636 timeout: Use static import instead of dynamic imports
import { amendMessage } from '../amend_message.js';

describe('amend_message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
		mockHostname.mockReturnValue('TEST-MACHINE');
		mockGetLocalFullId.mockReturnValue('test-machine:roo-extensions');
		delete process.env.ROOSYNC_MACHINE_ID;
	});

	// ============================================================
	// Parameter validation
	// ============================================================

	describe('parameter validation', () => {
		test('rejects missing message_id', async () => {
			const result = await amendMessage({
				message_id: '',
				new_content: 'new content'
			});

			expect(result.content[0].text).toContain('Erreur');
		});

		test('rejects missing new_content', async () => {
			const result = await amendMessage({
				message_id: 'msg-123',
				new_content: ''
			});

			expect(result.content[0].text).toContain('Erreur');
		});
	});

	// ============================================================
	// Machine ID resolution
	// ============================================================

	describe('machine ID resolution', () => {
		test('uses ROOSYNC_MACHINE_ID env var when set', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'env-machine';
			mockGetLocalFullId.mockReturnValue('env-machine:roo-extensions');
			mockAmendMessage.mockResolvedValue({
				message_id: 'msg-123',
				amended_at: '2026-01-01T00:00:00Z',
				reason: 'test',
				original_content_preserved: true
			});

			await amendMessage({
				message_id: 'msg-123',
				new_content: 'updated content'
			});

			expect(mockAmendMessage).toHaveBeenCalledWith(
				'msg-123',
				'env-machine:roo-extensions',
				'updated content',
				undefined
			);
		});

		test('falls back to os.hostname when env not set', async () => {
			mockHostname.mockReturnValue('My-Machine-01');
			mockGetLocalFullId.mockReturnValue('my-machine-01:roo-extensions');
			mockAmendMessage.mockResolvedValue({
				message_id: 'msg-456',
				amended_at: '2026-01-01T00:00:00Z',
				reason: 'update',
				original_content_preserved: true
			});

			await amendMessage({
				message_id: 'msg-456',
				new_content: 'new text'
			});

			// getLocalFullId returns full ID with workspace
			expect(mockAmendMessage).toHaveBeenCalledWith(
				'msg-456',
				'my-machine-01:roo-extensions',
				'new text',
				undefined
			);
		});
	});

	// ============================================================
	// Successful amendment
	// ============================================================

	describe('successful amendment', () => {
		test('returns success message with details', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'test-machine';
			mockAmendMessage.mockResolvedValue({
				message_id: 'msg-789',
				amended_at: '2026-02-20T10:30:00Z',
				reason: 'correction typo',
				original_content_preserved: true
			});

			const result = await amendMessage({
				message_id: 'msg-789',
				new_content: 'corrected content',
				reason: 'correction typo'
			});

			expect(result.content[0].text).toContain('Message amendé avec succès');
			expect(result.content[0].text).toContain('msg-789');
		});

		test('passes reason to MessageManager', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'test-machine';
			mockGetLocalFullId.mockReturnValue('test-machine:roo-extensions');
			mockAmendMessage.mockResolvedValue({
				message_id: 'msg-100',
				amended_at: '2026-01-01T00:00:00Z',
				reason: 'my reason',
				original_content_preserved: true
			});

			await amendMessage({
				message_id: 'msg-100',
				new_content: 'updated',
				reason: 'my reason'
			});

			expect(mockAmendMessage).toHaveBeenCalledWith(
				'msg-100',
				'test-machine:roo-extensions',
				'updated',
				'my reason'
			);
		});

		test('shows original content preservation status', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'test-machine';
			mockAmendMessage.mockResolvedValue({
				message_id: 'msg-200',
				amended_at: '2026-01-01T00:00:00Z',
				reason: 'test',
				original_content_preserved: true
			});

			const result = await amendMessage({
				message_id: 'msg-200',
				new_content: 'new'
			});

			expect(result.content[0].text).toContain('Oui');
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('returns error message on MessageManager failure', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'test-machine';
			mockAmendMessage.mockRejectedValue(new Error('Message already read'));

			const result = await amendMessage({
				message_id: 'msg-read',
				new_content: 'too late'
			});

			expect(result.content[0].text).toContain('Erreur');
			expect(result.content[0].text).toContain('Message already read');
		});

		test('includes troubleshooting suggestions', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'test-machine';
			mockAmendMessage.mockRejectedValue(new Error('Not found'));

			const result = await amendMessage({
				message_id: 'msg-missing',
				new_content: 'update'
			});

			expect(result.content[0].text).toContain('Vérifications');
			expect(result.content[0].text).toContain('roosync_get_message');
		});
	});
});
