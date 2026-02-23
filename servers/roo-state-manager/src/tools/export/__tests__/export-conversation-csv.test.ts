/**
 * Tests for export-conversation-csv.ts
 * Issue #492 - Coverage for CSV export tool
 *
 * @module tools/export/__tests__/export-conversation-csv
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

import { exportConversationCsvTool, handleExportConversationCsv } from '../export-conversation-csv.js';

const makeSkeleton = (taskId: string) => ({
	taskId,
	metadata: { title: 'Test' },
	sequence: []
});

const makeSuccessResult = (content = 'col1,col2\nval1,val2') => ({
	success: true,
	content,
	statistics: {
		totalSections: 3,
		userMessages: 1,
		assistantMessages: 1,
		toolResults: 1,
		totalContentSize: 512,
		compressionRatio: 1.5
	}
});

describe('exportConversationCsvTool', () => {
	test('has correct tool definition', () => {
		expect(exportConversationCsvTool.name).toBe('export_conversation_csv');
		expect(exportConversationCsvTool.inputSchema.required).toEqual(['taskId']);
	});
});

describe('handleExportConversationCsv', () => {
	const mockGetSkeleton = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('throws when taskId is empty', async () => {
		await expect(handleExportConversationCsv(
			{ taskId: '' },
			mockGetSkeleton
		)).rejects.toThrow('taskId est requis');
	});

	test('throws when conversation not found', async () => {
		mockGetSkeleton.mockResolvedValue(null);

		await expect(handleExportConversationCsv(
			{ taskId: 'missing' },
			mockGetSkeleton
		)).rejects.toThrow('introuvable');
	});

	test('returns CSV content when no filePath', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());

		const result = await handleExportConversationCsv(
			{ taskId: 'task-1' },
			mockGetSkeleton
		);

		expect(result).toContain('Export CSV généré avec succès');
		expect(result).toContain('```csv');
	});

	test('saves to file when filePath provided', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());
		mockMkdir.mockResolvedValue(undefined);
		mockWriteFile.mockResolvedValue(undefined);

		const result = await handleExportConversationCsv(
			{ taskId: 'task-1', filePath: '/out/data.csv' },
			mockGetSkeleton
		);

		expect(mockWriteFile).toHaveBeenCalledWith('/out/data.csv', 'col1,col2\nval1,val2', 'utf8');
		expect(result).toContain('Fichier sauvegardé');
	});

	test('passes csvVariant option', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult());

		await handleExportConversationCsv(
			{ taskId: 'task-1', csvVariant: 'tools' },
			mockGetSkeleton
		);

		expect(mockGenerateSummary).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ csvVariant: 'tools', outputFormat: 'csv' })
		);
	});

	test('throws when generation fails', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue({ success: false, error: 'format error' });

		await expect(handleExportConversationCsv(
			{ taskId: 'task-1' },
			mockGetSkeleton
		)).rejects.toThrow('format error');
	});

	test('counts CSV lines in output', async () => {
		mockGetSkeleton.mockResolvedValue(makeSkeleton('task-1'));
		mockGenerateSummary.mockResolvedValue(makeSuccessResult('h1,h2\nr1\nr2\nr3'));

		const result = await handleExportConversationCsv(
			{ taskId: 'task-1' },
			mockGetSkeleton
		);

		expect(result).toContain('4'); // 4 lines including header
	});
});
