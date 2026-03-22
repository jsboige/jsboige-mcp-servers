/**
 * Tests for export-conversation-xml.ts
 * Issue #492 - Coverage for legacy conversation XML export tool
 *
 * @module tools/export/__tests__/export-conversation-xml
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { exportConversationXmlTool, handleExportConversationXml } from '../export-conversation-xml.js';

describe('exportConversationXmlTool', () => {
	test('has correct tool definition', () => {
		expect(exportConversationXmlTool.name).toBe('export_conversation_xml');
		expect(exportConversationXmlTool.inputSchema.required).toEqual(['conversationId']);
	});
});

describe('handleExportConversationXml', () => {
	const mockXmlService = {
		generateConversationXml: vi.fn(),
		saveXmlToFile: vi.fn()
	};
	const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('returns error when conversation not in cache', async () => {
		const cache = new Map();

		const result = await handleExportConversationXml(
			{ conversationId: 'missing' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('missing');
	});

	test('returns XML content when no filePath', async () => {
		const cache = new Map();
		cache.set('root', { taskId: 'root', metadata: {} });
		mockXmlService.generateConversationXml.mockReturnValue('<conversation/>');

		const result = await handleExportConversationXml(
			{ conversationId: 'root' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toBe('<conversation/>');
	});

	test('saves to file when filePath provided', async () => {
		const cache = new Map();
		cache.set('root', { taskId: 'root', metadata: {} });
		mockXmlService.generateConversationXml.mockReturnValue('<c/>');
		mockXmlService.saveXmlToFile.mockResolvedValue(undefined);

		const result = await handleExportConversationXml(
			{ conversationId: 'root', filePath: '/out.xml' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockXmlService.saveXmlToFile).toHaveBeenCalledWith('<c/>', '/out.xml');
		expect(result.content[0].text).toContain('/out.xml');
	});

	test('collects child tasks recursively', async () => {
		const cache = new Map();
		cache.set('root', { taskId: 'root', metadata: {} });
		cache.set('child-1', { taskId: 'child-1', parentTaskId: 'root', metadata: {} });
		cache.set('grandchild', { taskId: 'grandchild', parentTaskId: 'child-1', metadata: {} });
		cache.set('unrelated', { taskId: 'unrelated', metadata: {} });
		mockXmlService.generateConversationXml.mockImplementation((root: any, children: any[]) => `<c>${[root, ...children].map((t: any) => t.taskId).join(',')}</c>`);

		await handleExportConversationXml(
			{ conversationId: 'root' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		const rootTask = mockXmlService.generateConversationXml.mock.calls[0][0];
		const children = mockXmlService.generateConversationXml.mock.calls[0][1];
		const allTaskIds = [rootTask, ...children].map((t: any) => t.taskId);
		expect(allTaskIds).toContain('root');
		expect(allTaskIds).toContain('child-1');
		expect(allTaskIds).toContain('grandchild');
		expect(allTaskIds).not.toContain('unrelated');
	});

	test('respects maxDepth', async () => {
		const cache = new Map();
		cache.set('root', { taskId: 'root', metadata: {} });
		cache.set('child', { taskId: 'child', parentTaskId: 'root', metadata: {} });
		cache.set('grandchild', { taskId: 'grandchild', parentTaskId: 'child', metadata: {} });
		mockXmlService.generateConversationXml.mockImplementation((root: any, children: any[]) => `<c>${[root, ...children].map((t: any) => t.taskId).join(',')}</c>`);

		// maxDepth=2: root(0) + child(1) collected, grandchild(2) excluded
		await handleExportConversationXml(
			{ conversationId: 'root', maxDepth: 2 },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		const rootTask = mockXmlService.generateConversationXml.mock.calls[0][0];
		const children = mockXmlService.generateConversationXml.mock.calls[0][1];
		const allTaskIds = [rootTask, ...children].map((t: any) => t.taskId);
		expect(allTaskIds).toContain('root');
		expect(allTaskIds).toContain('child');
		expect(allTaskIds).not.toContain('grandchild');
	});

	test('calls ensureSkeletonCacheIsFresh', async () => {
		const cache = new Map();
		cache.set('root', { taskId: 'root', metadata: {} });
		mockXmlService.generateConversationXml.mockReturnValue('<c/>');

		await handleExportConversationXml(
			{ conversationId: 'root' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockEnsureFresh).toHaveBeenCalledTimes(1);
	});

	test('handles error gracefully', async () => {
		const cache = new Map();
		cache.set('root', { taskId: 'root', metadata: {} });
		mockXmlService.generateConversationXml.mockImplementation(() => { throw new Error('XML error'); });

		const result = await handleExportConversationXml(
			{ conversationId: 'root' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('XML error');
	});
});
