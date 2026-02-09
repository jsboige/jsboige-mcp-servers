/**
 * Tests unitaires pour diagnose_conversation_bom
 * Diagnostique les fichiers de conversation corrompus par un BOM UTF-8
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock RooStorageDetector avec vi.hoisted
const { mockDetectStorageLocations } = vi.hoisted(() => ({
    mockDetectStorageLocations: vi.fn()
}));

vi.mock('../../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: mockDetectStorageLocations
    }
}));

// Mock fs avec vi.hoisted
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

import { diagnoseConversationBomTool } from '../../../../src/tools/repair/diagnose-conversation-bom.tool.js';

// Helper: create a Buffer with BOM prefix
function createBomBuffer(content: string): Buffer {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    return Buffer.concat([bom, Buffer.from(content, 'utf-8')]);
}

describe('diagnose_conversation_bom', () => {
    const handler = diagnoseConversationBomTool.handler;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should have correct tool definition', () => {
        expect(diagnoseConversationBomTool.definition.name).toBe('diagnose_conversation_bom');
        expect(diagnoseConversationBomTool.definition.inputSchema.properties).toHaveProperty('fix_found');
    });

    it('should return message when no storage locations found', async () => {
        mockDetectStorageLocations.mockResolvedValue([]);

        const result = await handler({});
        const text = (result.content[0] as any).text;

        expect(text).toContain('Aucun emplacement');
    });

    it('should scan files and report no corruption', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // Clean file without BOM
        mockReadFile.mockResolvedValue(Buffer.from('[{"role":"user"}]', 'utf-8'));

        const result = await handler({});
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers analysés:** 1');
        expect(text).toContain('Fichiers corrompus (BOM):** 0');
    });

    it('should detect BOM-corrupted files', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // File with BOM prefix
        mockReadFile.mockResolvedValue(createBomBuffer('[{"role":"user"}]'));

        const result = await handler({});
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers corrompus (BOM):** 1');
        expect(text).toContain('repair_conversation_bom');
    });

    it('should list corrupted file paths', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true },
            { name: 'conv-002', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockImplementation(async () => {
            return createBomBuffer('[{"role":"user"}]');
        });

        const result = await handler({});
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers corrompus détectés');
        expect(text).toContain('api_conversation_history.json');
    });

    it('should fix BOM-corrupted files when fix_found=true', async () => {
        const validJson = '[{"role":"user","content":"hello"}]';
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue(createBomBuffer(validJson));
        mockWriteFile.mockResolvedValue(undefined);

        const result = await handler({ fix_found: true });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers réparés:** 1');
        expect(text).toContain('Réparation automatique');
        expect(mockWriteFile).toHaveBeenCalledWith(
            expect.stringContaining('api_conversation_history.json'),
            validJson,
            'utf-8'
        );
    });

    it('should not fix files with invalid JSON after BOM removal', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // BOM + invalid JSON
        mockReadFile.mockResolvedValue(createBomBuffer('not valid json{{{'));
        mockWriteFile.mockResolvedValue(undefined);

        const result = await handler({ fix_found: true });
        const text = (result.content[0] as any).text;

        // File detected as corrupted but not repaired (JSON parse fails)
        expect(text).toContain('Fichiers corrompus (BOM):** 1');
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should skip non-directory entries', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'file.txt', isDirectory: () => false },
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue(Buffer.from('[]', 'utf-8'));

        const result = await handler({});
        const text = (result.content[0] as any).text;

        // Only 1 file analyzed (the directory entry)
        expect(text).toContain('Fichiers analysés:** 1');
    });

    it('should handle inaccessible files gracefully', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await handler({});
        const text = (result.content[0] as any).text;

        // 0 files analyzed (file not accessible)
        expect(text).toContain('Fichiers analysés:** 0');
    });

    it('should handle scan errors for storage locations gracefully', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockRejectedValue(new Error('Permission denied'));

        const result = await handler({});
        const text = (result.content[0] as any).text;

        // Should not crash, report 0 files
        expect(text).toContain('Fichiers analysés:** 0');
    });
});
