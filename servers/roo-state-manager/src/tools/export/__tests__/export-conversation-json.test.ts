/**
 * Tests for export-conversation-json.ts
 * Issue #492 - Coverage for JSON export tool
 *
 * @module tools/export/__tests__/export-conversation-json
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGenerateSummary, mockMkdir, mockWriteFile } = vi.hoisted(() => ({
	mockGenerateSummary: vi.fn(),
	mockMkdir: vi.fn(),
	mockWriteFile: vi.fn()
}));

vi.mock('../../../services/TraceSummaryService.js', () => ({
	TraceSummaryService: class {
		generateSummary = mockGenerateSummary;
	}
}));

vi.mock('../../../services/ExportConfigManager.js', () => ({
	ExportConfigManager: class {}
}));

vi.mock('fs/promises', () => ({
	default: {
		mkdir: mockMkdir,
		writeFile: mockWriteFile
	}
}));

import { exportConversationJsonTool, handleExportConversationJson } from '../export-conversation-json.js';

const makeSkeleton = (taskId: string) => ({
	taskId,
	metadata: { title: 'Test' },
	sequence: []
});

const makeSuccessResult = (content = '{"data":"test"}') => ({
	success: true,
	content,
	statistics: {
		totalSections: 5,
		userMessages: 2,
		assistantMessages: 2,
		toolResults: 1,
		totalContentSize: 1024,
		compressionRatio: 2.5
	}
});

describe('exportConversationJsonTool', () => {
	test('has correct tool definition', () => {
		expect(exportConversationJsonTool.name).toBe('export_conversation_json');
		expect(exportConversationJsonTool.inputSchema.required).toEqual(['taskId']);
	});
});

describe('handleExportConversationJson', () => {
	const mockGetSkeleton = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('throws when taskId is empty', async () => {
		await expect(handleExportConversationJson(
			{ taskId: '' },
			mockGetSkeleton
		)).rejects.toThrow('taskId est requis');
	});

	test('throws when conversation not found', async () => {
		mockGetSkeleton.mockResolvedValue(null);

		await expect(handleExportConversationJson(
			{ taskId: 'missing' },
			mockGetSkeleton
		)).rejects.toThrow('introuvable');
	});

	test('returns JSON content when no filePath', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());

		const result = await handleExportConversationJson(
			{ taskId: 'task-1' },
			mockGetSkeleton
		);

		expect(result).toContain('Export JSON généré avec succès');
		expect(result).toContain('task-1');
		expect(result).toContain('```json');
	});

	test('saves to file when filePath provided', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());
		mockMkdir.mockResolvedValue(undefined);
		mockWriteFile.mockResolvedValue(undefined);

		const result = await handleExportConversationJson(
			{ taskId: 'task-1', filePath: '/out/export.json' },
			mockGetSkeleton
		);

		expect(mockMkdir).toHaveBeenCalled();
		expect(mockWriteFile).toHaveBeenCalledWith('/out/export.json', '{"data":"test"}', 'utf8');
		expect(result).toContain('Fichier sauvegardé');
	});

	test('passes jsonVariant option', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());

		await handleExportConversationJson(
			{ taskId: 'task-1', jsonVariant: 'full' },
			mockGetSkeleton
		);

		expect(mockGenerateSummary).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ jsonVariant: 'full', outputFormat: 'json' })
		);
	});

	test('throws when generation fails', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue({ success: false, error: 'parse error' });

		await expect(handleExportConversationJson(
			{ taskId: 'task-1' },
			mockGetSkeleton
		)).rejects.toThrow('parse error');
	});

	test('throws when file write fails', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());
		mockMkdir.mockResolvedValue(undefined);
		mockWriteFile.mockRejectedValue(new Error('EACCES'));

		await expect(handleExportConversationJson(
			{ taskId: 'task-1', filePath: '/readonly/out.json' },
			mockGetSkeleton
		)).rejects.toThrow('EACCES');
	});
});
