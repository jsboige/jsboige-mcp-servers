/**
 * Tests pour diagnose-conversation-bom.tool.ts
 * Module de diagnostic des fichiers corrompus par BOM UTF-8
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité MOYENNE - Diagnostic BOM
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Mock fs module with promises namespace (for import { promises as fs } from 'fs')
const { mockReaddir, mockReadFile, mockWriteFile, mockAccess, mockMkdir } = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockAccess: vi.fn(),
	mockMkdir: vi.fn()
}));

vi.mock('fs', () => ({
	promises: {
		readdir: mockReaddir,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		access: mockAccess,
		mkdir: mockMkdir
	}
}));

// Import AFTER mocking fs
import { diagnoseConversationBomTool } from '../diagnose-conversation-bom.tool.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';
let detectStorageLocationsSpy: ReturnType<typeof vi.spyOn>;

describe('diagnose-conversation-bom', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Use spyOn to control the static method on the real class
		detectStorageLocationsSpy = vi.spyOn(RooStorageDetector, 'detectStorageLocations');
		// Default: return empty array
		detectStorageLocationsSpy.mockResolvedValue([]);
	});

	afterEach(() => {
		detectStorageLocationsSpy.mockRestore();
	});

	describe('tool metadata', () => {
		it('should have correct name', () => {
			expect(diagnoseConversationBomTool.definition.name).toBe('diagnose_conversation_bom');
		});

		it('should have description', () => {
			expect(diagnoseConversationBomTool.definition.description).toBeDefined();
			expect(diagnoseConversationBomTool.definition.description.length).toBeGreaterThan(0);
		});

		it('should accept optional fix_found parameter', () => {
			expect(diagnoseConversationBomTool.definition.inputSchema.properties.fix_found).toBeDefined();
			expect(diagnoseConversationBomTool.definition.inputSchema.properties.fix_found.type).toBe('boolean');
			expect(diagnoseConversationBomTool.definition.inputSchema.required).toEqual([]);
		});

		it('should have default value for fix_found', () => {
			expect(diagnoseConversationBomTool.definition.inputSchema.properties.fix_found.default).toBe(false);
		});
	});

	describe('handler - no storage locations', () => {
		it('should return message when no storage locations found', async () => {
			// Mock returns empty array by default
			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('Aucun emplacement de stockage Roo trouvé');
		});
	});

	describe('handler - BOM detection', () => {
		const mockLocation = 'C:/Users/test/.vscode/extensions';

		beforeEach(() => {
			// Mock RooStorageDetector to return storage location
			detectStorageLocationsSpy.mockResolvedValue([mockLocation]);

			// Mock readdir to return conversation directories
		 mockReaddir.mockResolvedValue([
				{ name: 'task1', isDirectory: () => true } as any,
				{ name: 'task2', isDirectory: () => true } as any,
				{ name: 'task3', isDirectory: () => true } as any
			] as any);
		});

		it('should detect BOM at start of file', async () => {
			// Buffer with BOM (0xEF 0xBB 0xBF)
			const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF, 0x7B, 0x22, 0x6D, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3A, 0x22, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x22, 0x7D]);
		 mockReadFile.mockResolvedValue(bomBuffer);
		 mockAccess.mockResolvedValue(undefined);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 3');
			expect(text).toContain('**Fichiers analysés:** 3');
		});

		it('should not detect BOM in clean file', async () => {
			// Buffer without BOM (just JSON)
			const cleanBuffer = Buffer.from([0x7B, 0x22, 0x6D, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3A, 0x22, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x22, 0x7D]);
		 mockReadFile.mockResolvedValue(cleanBuffer);
		 mockAccess.mockResolvedValue(undefined);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 0');
			expect(text).toContain('**Fichiers analysés:** 3');
		});

		it('should detect partial BOM pattern', async () => {
			// Only first two BOM bytes (0xEF 0xBB)
			const partialBomBuffer = Buffer.from([0xEF, 0xBB, 0x7B, 0x22, 0x6D, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3A, 0x22, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x22, 0x7D]);
		 mockReadFile.mockResolvedValue(partialBomBuffer);
		 mockAccess.mockResolvedValue(undefined);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 0');
		});

		it('should handle empty buffer', async () => {
		 mockReadFile.mockResolvedValue(Buffer.from([]));
		 mockAccess.mockResolvedValue(undefined);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 0');
		});

		it('should handle buffer too small for BOM check', async () => {
		 mockReadFile.mockResolvedValue(Buffer.from([0x7B]));
		 mockAccess.mockResolvedValue(undefined);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 0');
		});
	});

	describe('handler - auto-repair', () => {
		const mockLocation = 'C:/Users/test/.vscode/extensions';

		beforeEach(() => {
			detectStorageLocationsSpy.mockResolvedValue([mockLocation]);

		 mockReaddir.mockResolvedValue([
				{ name: 'task1', isDirectory: () => true } as any,
				{ name: 'task2', isDirectory: () => true } as any
			] as any);
		});

		it('should repair file with BOM when fix_found is true', async () => {
			const jsonContent = '{"message":"hello"}';
			const bomBuffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(jsonContent, 'utf-8')]);

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(bomBuffer);
			mockWriteFile.mockResolvedValue(undefined);

			const result = await diagnoseConversationBomTool.handler({ fix_found: true });
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers réparés:** 2');
			expect(text).toContain('✅ Réparation automatique effectuée.');
			expect( mockWriteFile).toHaveBeenCalledTimes(2);
		});

		it('should write clean content without BOM', async () => {
			const jsonContent = '{"test":"data"}';
			const bomBuffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(jsonContent, 'utf-8')]);

		 mockAccess.mockResolvedValue(undefined);
		 mockReadFile.mockResolvedValue(bomBuffer);
		 mockWriteFile.mockResolvedValue(undefined);

			await diagnoseConversationBomTool.handler({ fix_found: true });

			// Verify that writeFile was called with clean content (no BOM)
			const writeCall = mockWriteFile.mock.calls[0];
			const writtenContent = writeCall[1] as string;

			expect(writtenContent).not.toContain('\uFEFF'); // No BOM character
			expect(writtenContent).toBe(jsonContent);
		});

		it('should not repair file with invalid JSON beyond BOM', async () => {
			const invalidJson = 'not valid json';
			const bomBuffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(invalidJson, 'utf-8')]);

		 mockAccess.mockResolvedValue(undefined);
		 mockReadFile.mockResolvedValue(bomBuffer);

			const result = await diagnoseConversationBomTool.handler({ fix_found: true });
			const text = result.content[0].text as string;

			// Files detected as corrupted but not repaired
			expect(text).toContain('**Fichiers corrompus (BOM):** 2');
			expect(text).not.toContain('**Fichiers réparés:** 2');
			expect( mockWriteFile).not.toHaveBeenCalled();
		});
	});

	describe('handler - report format', () => {
		const mockLocation = 'C:/Users/test/.vscode/extensions';

		beforeEach(() => {
			detectStorageLocationsSpy.mockResolvedValue([mockLocation]);
		});

		it('should list up to 20 corrupted files', async () => {
			const dirs = Array.from({ length: 25 }, (_, i) => ({
				name: `task${i}`,
				isDirectory: () => true
			})) as any;

		 mockReaddir.mockResolvedValue(dirs);
		 mockAccess.mockResolvedValue(undefined);

			// All files have BOM
			const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF, 0x7B, 0x7D]);
		 mockReadFile.mockResolvedValue(bomBuffer);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('20 premiers');
			expect(text).toContain('et 5 autres fichiers');
		});

		it('should list all corrupted files when 20 or fewer', async () => {
			const dirs = Array.from({ length: 5 }, (_, i) => ({
				name: `task${i}`,
				isDirectory: () => true
			})) as any;

		 mockReaddir.mockResolvedValue(dirs);
		 mockAccess.mockResolvedValue(undefined);

			const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF, 0x7B, 0x7D]);
		 mockReadFile.mockResolvedValue(bomBuffer);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('## Fichiers corrompus détectés:');
			expect(text).toContain('task0');
			expect(text).toContain('task4');
			expect(text).not.toContain('20 premiers');
		});

		it('should show warning when corrupted files found and not repaired', async () => {
		 mockReaddir.mockResolvedValue([
				{ name: 'task1', isDirectory: () => true } as any
			]);
		 mockAccess.mockResolvedValue(undefined);

			const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF, 0x7B, 0x7D]);
		 mockReadFile.mockResolvedValue(bomBuffer);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('repair_conversation_bom');
			expect(text).toContain('⚠️');
		});
	});

	describe('handler - error handling', () => {
		const mockLocation = 'C:/Users/test/.vscode/extensions';

		beforeEach(() => {
			detectStorageLocationsSpy.mockResolvedValue([mockLocation]);
		});

		it('should skip files that do not exist', async () => {
		 mockReaddir.mockResolvedValue([
				{ name: 'task1', isDirectory: () => true } as any
			]);
		 mockAccess.mockRejectedValue(new Error('ENOENT'));

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers analysés:** 0');
		});

		it('should skip non-directory entries', async () => {
		 mockReaddir.mockResolvedValue([
				{ name: 'file.txt', isDirectory: () => false } as any,
				{ name: 'task1', isDirectory: () => true } as any
			]);
		 mockAccess.mockResolvedValue(undefined);

			const cleanBuffer = Buffer.from([0x7B, 0x7D]);
		 mockReadFile.mockResolvedValue(cleanBuffer);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			// Only task1 should be analyzed (file.txt skipped)
			expect(text).toContain('**Fichiers analysés:** 1');
		});

		it('should handle readdir errors gracefully', async () => {
		 mockReaddir.mockRejectedValue(new Error('Permission denied'));

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers analysés:** 0');
		});
	});

	describe('handler - multiple storage locations', () => {
		it('should scan all storage locations', async () => {
			const mockLocations = [
				'C:/Users/test/.vscode/extensions',
				'D:/other/location'
			];

			detectStorageLocationsSpy.mockResolvedValue(mockLocations);

			// Each location has 1 conversation directory
		 mockReaddir.mockResolvedValue([
				{ name: 'task1', isDirectory: () => true } as any
			]);
		 mockAccess.mockResolvedValue(undefined);

			const cleanBuffer = Buffer.from([0x7B, 0x7D]);
		 mockReadFile.mockResolvedValue(cleanBuffer);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers analysés:** 2');
			expect( mockReaddir).toHaveBeenCalledTimes(2);
		});
	});

	describe('BOM detection edge cases', () => {
		const mockLocation = 'C:/Users/test/.vscode/extensions';

		beforeEach(() => {
			detectStorageLocationsSpy.mockResolvedValue([mockLocation]);
		 mockReaddir.mockResolvedValue([
				{ name: 'task1', isDirectory: () => true } as any
			]);
		 mockAccess.mockResolvedValue(undefined);
		});

		it('should detect exact BOM sequence', async () => {
			const exactBom = Buffer.from([0xEF, 0xBB, 0xBF, 0x7B, 0x22, 0x7D]);
			mockReadFile.mockResolvedValue(exactBom);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 1');
		});

		it('should not mistake similar bytes for BOM', async () => {
			const similarBytes = Buffer.from([0xEF, 0xBB, 0xBE, 0x7B, 0x22, 0x7D]); // Last byte different
		 mockReadFile.mockResolvedValue(similarBytes);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 0');
		});

		it('should not mistake BOM in middle of file', async () => {
			const bomInMiddle = Buffer.from([0x7B, 0x22, 0x7D, 0xEF, 0xBB, 0xBF]);
		 mockReadFile.mockResolvedValue(bomInMiddle);

			const result = await diagnoseConversationBomTool.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('**Fichiers corrompus (BOM):** 0');
		});
	});
});
