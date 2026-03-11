/**
 * Tests pour read_inbox.ts
 * Issue #492 - Couverture des outils RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockReadInbox } = vi.hoisted(() => ({
	mockReadInbox: vi.fn()
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
		readInbox(...args: any[]) { return mockReadInbox(...args); }
	}
}));

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: mockGetSharedStatePath
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	Logger: class {}
}));

vi.mock('os', () => ({
	default: { hostname: () => mockHostname() },
	hostname: () => mockHostname()
}));

// Fix #636 timeout: Use static import instead of dynamic imports
import { readInbox } from '../read_inbox.js';

describe('read_inbox', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('/shared/state');
		mockHostname.mockReturnValue('MyIA-AI-01');
	});

	test('returns empty inbox message when no messages', async () => {
		mockReadInbox.mockResolvedValue([]);

		const result = await readInbox({});

		expect(result.content[0].text).toContain('Aucun message');
		expect(result.content[0].text).toContain('myia-ai-01');
	});

	test('filters by status', async () => {
		mockReadInbox.mockResolvedValue([]);

		const result = await readInbox({ status: 'unread' });

		expect(mockReadInbox).toHaveBeenCalledWith('myia-ai-01', 'unread', undefined);
		expect(result.content[0].text).toContain('unread');
	});

	test('passes limit parameter', async () => {
		mockReadInbox.mockResolvedValue([]);

		await readInbox({ limit: 5 });

		expect(mockReadInbox).toHaveBeenCalledWith('myia-ai-01', 'all', 5);
	});

	test('formats messages as table', async () => {
		mockReadInbox.mockResolvedValue([
			{
				id: 'msg-100', from: 'po-2023', to: 'ai-01',
				subject: 'Test Report', priority: 'HIGH',
				timestamp: '2026-01-15T10:30:00Z', status: 'unread',
				preview: 'All tests passed...'
			},
			{
				id: 'msg-101', from: 'po-2024', to: 'ai-01',
				subject: 'Build Complete', priority: 'LOW',
				timestamp: '2026-01-15T09:00:00Z', status: 'read',
				preview: 'Build succeeded...'
			}
		]);

		const result = await readInbox({});

		expect(result.content[0].text).toContain('msg-100');
		expect(result.content[0].text).toContain('msg-101');
		expect(result.content[0].text).toContain('po-2023');
		expect(result.content[0].text).toContain('Test Report');
		expect(result.content[0].text).toContain('2 messages');
	});

	test('shows statistics for unread and read counts', async () => {
		mockReadInbox.mockResolvedValue([
			{ id: 'msg-1', from: 'a', to: 'b', subject: 'S1', priority: 'MEDIUM', timestamp: '2026-01-01T00:00:00Z', status: 'unread', preview: '' },
			{ id: 'msg-2', from: 'a', to: 'b', subject: 'S2', priority: 'MEDIUM', timestamp: '2026-01-01T00:00:00Z', status: 'unread', preview: '' },
			{ id: 'msg-3', from: 'a', to: 'b', subject: 'S3', priority: 'MEDIUM', timestamp: '2026-01-01T00:00:00Z', status: 'read', preview: '' }
		]);

		const result = await readInbox({});

		expect(result.content[0].text).toContain('2 non-lu');
		expect(result.content[0].text).toContain('1 lu');
	});

	test('shows preview of most recent message', async () => {
		mockReadInbox.mockResolvedValue([
			{
				id: 'msg-200', from: 'po-2023', to: 'ai-01',
				subject: 'Coverage Report', priority: 'MEDIUM',
				timestamp: '2026-01-01T00:00:00Z', status: 'unread',
				preview: 'Test coverage increased to 85%'
			}
		]);

		const result = await readInbox({});

		expect(result.content[0].text).toContain('Coverage Report');
		expect(result.content[0].text).toContain('Test coverage increased to 85%');
	});

	test('shows priority icons', async () => {
		mockReadInbox.mockResolvedValue([
			{ id: 'msg-1', from: 'a', to: 'b', subject: 'Urgent', priority: 'URGENT', timestamp: '2026-01-01T00:00:00Z', status: 'unread', preview: '' }
		]);

		const result = await readInbox({});

		expect(result.content[0].text).toContain('URGENT');
	});

	test('normalizes hostname to lowercase with sanitization', async () => {
		mockHostname.mockReturnValue('MyIA-Web1');
		mockReadInbox.mockResolvedValue([]);

		await readInbox({});

		expect(mockReadInbox).toHaveBeenCalledWith('myia-web1', 'all', undefined);
	});

	test('returns error on failure', async () => {
		mockReadInbox.mockRejectedValue(new Error('Permission denied'));

		const result = await readInbox({});

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('Permission denied');
	});

	test('suggests available actions', async () => {
		mockReadInbox.mockResolvedValue([
			{ id: 'msg-1', from: 'a', to: 'b', subject: 'Test', priority: 'MEDIUM', timestamp: '2026-01-01T00:00:00Z', status: 'unread', preview: '' }
		]);

		const result = await readInbox({});

		expect(result.content[0].text).toContain('roosync_get_message');
		expect(result.content[0].text).toContain('roosync_read_inbox');
	});
});
