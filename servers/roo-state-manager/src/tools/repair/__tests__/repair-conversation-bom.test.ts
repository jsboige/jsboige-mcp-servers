/**
 * Tests pour repair_conversation_bom
 * Issue #492 - Couverture des outils actifs
 *
 * @module tools/repair/__tests__/repair-conversation-bom
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for ESM compatibility
const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations
	}
}));

const { mockReaddir, mockAccess, mockReadFile, mockWriteFile } = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockAccess: vi.fn(),
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn()
}));

vi.mock('fs', () => ({
	promises: {
		readdir: mockReaddir,
		access: mockAccess,
		readFile: mockReadFile,
		writeFile: mockWriteFile
	}
}));

import { repairConversationBomTool } from '../repair-conversation-bom.tool.js';

// Helper: create a Buffer with BOM prefix
function createBomBuffer(content: string): Buffer {
	const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
	return Buffer.concat([bom, Buffer.from(content, 'utf-8')]);
}

function getText(result: any): string {
	return result.content[0]?.text || '';
}

describe('repair_conversation_bom', () => {
	const handler = repairConversationBomTool.handler;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// Tool definition
	// ============================================================

	describe('tool definition', () => {
		test('has correct name', () => {
			expect(repairConversationBomTool.definition.name).toBe('repair_conversation_bom');
		});

		test('has dry_run parameter', () => {
			const props = repairConversationBomTool.definition.inputSchema.properties as any;
			expect(props.dry_run).toBeDefined();
			expect(props.dry_run.type).toBe('boolean');
		});

		test('has no required parameters', () => {
			expect(repairConversationBomTool.definition.inputSchema.required).toEqual([]);
		});
	});

	// ============================================================
	// No storage locations
	// ============================================================

	describe('no storage locations', () => {
		test('returns message when no storage found', async () => {
			mockDetectStorageLocations.mockResolvedValue([]);

			const result = await handler({});
			expect(getText(result)).toContain('Aucun emplacement');
		});
	});

	// ============================================================
	// Dry-run mode
	// ============================================================

	describe('dry-run mode', () => {
		test('does not write files in dry_run mode', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer('[{"role":"user"}]'));

			const result = await handler({ dry_run: true });
			const text = getText(result);

			expect(text).toContain('Simulation');
			expect(text).toContain('dry-run');
			expect(text).toContain('seraient réparés');
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('reports number of files that would be repaired', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true },
				{ name: 'conv-002', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer('[]'));

			const result = await handler({ dry_run: true });
			const text = getText(result);

			expect(text).toContain('2 fichier(s) seraient réparés');
		});
	});

	// ============================================================
	// Real repair mode
	// ============================================================

	describe('real repair', () => {
		test('repairs BOM-corrupted files', async () => {
			const validJson = '[{"role":"user","content":"hello"}]';
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer(validJson));
			mockWriteFile.mockResolvedValue(undefined);

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('Réparation réelle');
			expect(text).toContain('Fichiers réparés:** 1');
			expect(text).toContain('api_conversation_history.json');
			expect(mockWriteFile).toHaveBeenCalledWith(
				expect.stringContaining('api_conversation_history.json'),
				validJson,
				'utf-8'
			);
		});

		test('reports success count correctly', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true },
				{ name: 'conv-002', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer('[]'));
			mockWriteFile.mockResolvedValue(undefined);

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('Fichiers réparés:** 2');
			expect(text).toContain('2 fichier(s) réparé(s) avec succès');
		});

		test('handles repair failure (invalid JSON after BOM removal)', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer('not valid json{{{'));

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('Fichiers corrompus (BOM):** 1');
			expect(text).toContain('réparation');
			expect(text).toContain('Erreur:');
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('handles writeFile failure gracefully', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer('[]'));
			mockWriteFile.mockRejectedValue(new Error('EPERM'));

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('Erreur: EPERM');
			expect(text).toContain('réparation');
		});
	});

	// ============================================================
	// Clean files (no BOM)
	// ============================================================

	describe('clean files', () => {
		test('reports no corruption for clean files', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(Buffer.from('[{"role":"user"}]', 'utf-8'));

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('Fichiers analysés:** 1');
			expect(text).toContain('Fichiers corrompus (BOM):** 0');
		});
	});

	// ============================================================
	// Edge cases
	// ============================================================

	describe('edge cases', () => {
		test('skips non-directory entries', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'file.txt', isDirectory: () => false },
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(Buffer.from('[]', 'utf-8'));

			const result = await handler({});
			expect(getText(result)).toContain('Fichiers analysés:** 1');
		});

		test('handles inaccessible files gracefully', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const result = await handler({});
			expect(getText(result)).toContain('Fichiers analysés:** 0');
		});

		test('handles readdir error gracefully', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockRejectedValue(new Error('Permission denied'));

			const result = await handler({});
			expect(getText(result)).toContain('Fichiers analysés:** 0');
		});

		test('scans multiple storage locations', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/loc1', '/loc2']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-001', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(Buffer.from('[]', 'utf-8'));

			const result = await handler({});
			expect(getText(result)).toContain('Fichiers analysés:** 2');
		});

		test('truncates detail list when more than 30 results', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);

			// Create 35 directories
			const dirs = Array.from({ length: 35 }, (_, i) => ({
				name: `conv-${String(i).padStart(3, '0')}`,
				isDirectory: () => true
			}));
			mockReaddir.mockResolvedValue(dirs);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(createBomBuffer('[]'));
			mockWriteFile.mockResolvedValue(undefined);

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('30 premiers résultats');
			expect(text).toContain('5 autres résultats');
		});

		test('mixed clean and corrupted files', async () => {
			mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
			mockReaddir.mockResolvedValue([
				{ name: 'conv-clean', isDirectory: () => true },
				{ name: 'conv-dirty', isDirectory: () => true }
			]);
			mockAccess.mockResolvedValue(undefined);

			let callCount = 0;
			mockReadFile.mockImplementation(async () => {
				callCount++;
				if (callCount === 1) return Buffer.from('[]', 'utf-8');
				return createBomBuffer('[]');
			});
			mockWriteFile.mockResolvedValue(undefined);

			const result = await handler({});
			const text = getText(result);

			expect(text).toContain('Fichiers analysés:** 2');
			expect(text).toContain('Fichiers corrompus (BOM):** 1');
			expect(text).toContain('Fichiers réparés:** 1');
		});
	});
});
