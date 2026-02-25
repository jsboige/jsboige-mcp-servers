/**
 * Tests for export-project-xml.ts
 * Issue #492 - Coverage for legacy project XML export tool
 *
 * @module tools/export/__tests__/export-project-xml
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { exportProjectXmlTool, handleExportProjectXml } from '../export-project-xml.js';

describe('exportProjectXmlTool', () => {
	test('has correct tool definition', () => {
		expect(exportProjectXmlTool.name).toBe('export_project_xml');
		expect(exportProjectXmlTool.inputSchema.required).toEqual(['projectPath']);
	});
});

describe('handleExportProjectXml', () => {
	const mockXmlService = {
		generateProjectXml: vi.fn(),
		saveXmlToFile: vi.fn()
	};
	const mockEnsureFresh = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('returns XML content when no filePath', async () => {
		const cache = new Map();
		cache.set('task-1', {
			taskId: 'task-1',
			metadata: { workspace: 'D:\\project', lastActivity: '2026-02-01' }
		});
		mockXmlService.generateProjectXml.mockReturnValue('<project>xml</project>');

		const result = await handleExportProjectXml(
			{ projectPath: 'D:\\project' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toBe('<project>xml</project>');
	});

	test('saves to file when filePath provided', async () => {
		const cache = new Map();
		mockXmlService.generateProjectXml.mockReturnValue('<p/>');
		mockXmlService.saveXmlToFile.mockResolvedValue(undefined);

		const result = await handleExportProjectXml(
			{ projectPath: '/proj', filePath: '/out.xml' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockXmlService.saveXmlToFile).toHaveBeenCalledWith('<p/>', '/out.xml');
		expect(result.content[0].text).toContain('/out.xml');
	});

	test('filters by startDate', async () => {
		const cache = new Map();
		cache.set('old', {
			taskId: 'old',
			metadata: { workspace: '/proj', lastActivity: '2025-01-01' }
		});
		cache.set('new', {
			taskId: 'new',
			metadata: { workspace: '/proj', lastActivity: '2026-06-01' }
		});
		mockXmlService.generateProjectXml.mockReturnValue('<p/>');

		await handleExportProjectXml(
			{ projectPath: '/proj', startDate: '2026-01-01' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		// generateProjectXml should only receive the new task
		const passedTasks = mockXmlService.generateProjectXml.mock.calls[0][0];
		expect(passedTasks.length).toBe(1);
		expect(passedTasks[0].taskId).toBe('new');
	});

	test('filters by endDate', async () => {
		const cache = new Map();
		cache.set('old', {
			taskId: 'old',
			metadata: { workspace: '/proj', lastActivity: '2025-01-01' }
		});
		cache.set('new', {
			taskId: 'new',
			metadata: { workspace: '/proj', lastActivity: '2026-06-01' }
		});
		mockXmlService.generateProjectXml.mockReturnValue('<p/>');

		await handleExportProjectXml(
			{ projectPath: '/proj', endDate: '2025-12-31' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		const passedTasks = mockXmlService.generateProjectXml.mock.calls[0][0];
		expect(passedTasks.length).toBe(1);
		expect(passedTasks[0].taskId).toBe('old');
	});

	test('calls ensureSkeletonCacheIsFresh with workspace', async () => {
		const cache = new Map();
		mockXmlService.generateProjectXml.mockReturnValue('<p/>');

		await handleExportProjectXml(
			{ projectPath: '/my/project' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(mockEnsureFresh).toHaveBeenCalledWith({ workspace: '/my/project' });
	});

	test('handles error gracefully', async () => {
		const cache = new Map();
		mockXmlService.generateProjectXml.mockImplementation(() => { throw new Error('XML crash'); });

		const result = await handleExportProjectXml(
			{ projectPath: '/proj' },
			cache,
			mockXmlService as any,
			mockEnsureFresh
		);

		expect(result.content[0].text).toContain('Erreur');
		expect(result.content[0].text).toContain('XML crash');
	});
});
