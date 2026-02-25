/**
 * Tests for export-tasks-xml.ts
 * Issue #492 - Coverage for legacy XML export tool
 *
 * @module tools/export/__tests__/export-tasks-xml
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { exportTasksXmlTool, handleExportTasksXml } from '../export-tasks-xml.js';

describe('exportTasksXmlTool', () => {
	test('has correct tool definition', () => {
		expect(exportTasksXmlTool.name).toBe('export_tasks_xml');
		expect(exportTasksXmlTool.inputSchema.required).toEqual(['taskId']);
	});
});

describe('handleExportTasksXml', () => {
	const mockXmlService = {
		generateTaskXml: vi.fn(),
		saveXmlToFile: vi.fn()
	};
	const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('returns error when task not in cache', async () => {
		const cache = new Map();

		const result = await handleExportTasksXml(
			{ taskId: 'missing' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('missing');
	});

	test('returns XML content when no filePath', async () => {
		const cache = new Map();
		cache.set('task-1', { taskId: 'task-1', metadata: {} });
		mockXmlService.generateTaskXml.mockReturnValue('<task>xml</task>');

		const result = await handleExportTasksXml(
			{ taskId: 'task-1' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toBe('<task>xml</task>');
		expect(mockXmlService.generateTaskXml).toHaveBeenCalledWith(
			{ taskId: 'task-1', metadata: {} },
			{ includeContent: false, prettyPrint: true }
		);
	});

	test('saves to file when filePath provided', async () => {
		const cache = new Map();
		cache.set('task-1', { taskId: 'task-1', metadata: {} });
		mockXmlService.generateTaskXml.mockReturnValue('<task/>');
		mockXmlService.saveXmlToFile.mockResolvedValue(undefined);

		const result = await handleExportTasksXml(
			{ taskId: 'task-1', filePath: '/out.xml' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockXmlService.saveXmlToFile).toHaveBeenCalledWith('<task/>', '/out.xml');
		expect(result.content[0].text).toContain('/out.xml');
	});

	test('passes includeContent and prettyPrint options', async () => {
		const cache = new Map();
		cache.set('task-1', { taskId: 'task-1', metadata: {} });
		mockXmlService.generateTaskXml.mockReturnValue('<t/>');

		await handleExportTasksXml(
			{ taskId: 'task-1', includeContent: true, prettyPrint: false },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockXmlService.generateTaskXml).toHaveBeenCalledWith(
			expect.anything(),
			{ includeContent: true, prettyPrint: false }
		);
	});

	test('calls ensureSkeletonCacheIsFresh', async () => {
		const cache = new Map();
		cache.set('task-1', { taskId: 'task-1', metadata: {} });
		mockXmlService.generateTaskXml.mockReturnValue('<t/>');

		await handleExportTasksXml(
			{ taskId: 'task-1' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockEnsureFresh).toHaveBeenCalledTimes(1);
	});

	test('handles generateTaskXml error gracefully', async () => {
		const cache = new Map();
		cache.set('task-1', { taskId: 'task-1', metadata: {} });
		mockXmlService.generateTaskXml.mockImplementation(() => { throw new Error('XML gen failed'); });

		const result = await handleExportTasksXml(
			{ taskId: 'task-1' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('XML gen failed');
	});
});
