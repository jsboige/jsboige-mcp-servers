/**
 * Tests unitaires pour repair_conversation_bom
 * Répare les fichiers de conversation corrompus par un BOM UTF-8
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

import { repairConversationBomTool } from '../../../../src/tools/repair/repair-conversation-bom.tool.js';

// Helper: create a Buffer with BOM prefix
function createBomBuffer(content: string): Buffer {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    return Buffer.concat([bom, Buffer.from(content, 'utf-8')]);
}

describe('repair_conversation_bom', () => {
    const handler = repairConversationBomTool.handler;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should have correct tool definition', () => {
        expect(repairConversationBomTool.definition.name).toBe('repair_conversation_bom');
        expect(repairConversationBomTool.definition.inputSchema.properties).toHaveProperty('dry_run');
        expect(repairConversationBomTool.definition.inputSchema.properties.dry_run.type).toBe('boolean');
    });

    it('should return message when no storage locations found', async () => {
        mockDetectStorageLocations.mockResolvedValue([]);

        const result = await handler({});
        const text = (result.content[0] as any).text;

        expect(text).toContain('Aucun emplacement');
    });

    it('should scan files and report no corruption in dry_run mode', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // Clean file without BOM
        mockReadFile.mockResolvedValue(Buffer.from('[{"role":"user"}]', 'utf-8'));

        const result = await handler({ dry_run: true });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Simulation (dry-run)');
        expect(text).toContain('Fichiers analysés:** 1');
        expect(text).toContain('Fichiers corrompus (BOM):** 0');
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should detect BOM-corrupted files in dry_run mode', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // File with BOM prefix
        mockReadFile.mockResolvedValue(createBomBuffer('[{"role":"user"}]'));

        const result = await handler({ dry_run: true });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Simulation (dry-run)');
        expect(text).toContain('Fichiers corrompus (BOM):** 1');
        expect(text).toContain('seraient réparés');
        expect(text).toContain('🔍'); // Icon for SERAIT_REPARE
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should repair BOM-corrupted files in real mode', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // File with BOM prefix
        mockReadFile.mockResolvedValue(createBomBuffer('[{"role":"user"}]'));
        mockWriteFile.mockResolvedValue(undefined);

        const result = await handler({ dry_run: false });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Réparation réelle');
        expect(text).toContain('Fichiers réparés:** 1');
        expect(text).toContain('✅ 1 fichier(s) réparé(s)');
        expect(text).toContain('✅'); // Icon for REPARE
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        // Verify that BOM was removed (buffer should start after 3 bytes)
        const writtenContent = mockWriteFile.mock.calls[0][1] as string;
        expect(writtenContent).toBe('[{"role":"user"}]');
    });

    it('should handle multiple corrupted files', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true },
            { name: 'conv-002', isDirectory: () => true },
            { name: 'conv-003', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // Mix of clean and corrupted files
        mockReadFile.mockImplementation((path: string) => {
            if (path.includes('conv-001')) return Promise.resolve(createBomBuffer('[{"role":"user"}]'));
            if (path.includes('conv-002')) return Promise.resolve(createBomBuffer('[{"role":"assistant"}]'));
            return Promise.resolve(Buffer.from('[{"role":"system"}]', 'utf-8'));
        });
        mockWriteFile.mockResolvedValue(undefined);

        const result = await handler({ dry_run: false });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers analysés:** 3');
        expect(text).toContain('Fichiers corrompus (BOM):** 2');
        expect(text).toContain('Fichiers réparés:** 2');
        expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it('should handle repair failure when JSON is invalid', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        // File with BOM but invalid JSON after BOM removal
        mockReadFile.mockResolvedValue(createBomBuffer('not valid json'));

        const result = await handler({ dry_run: false });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers corrompus (BOM):** 1');
        expect(text).toContain('Échecs de réparation:** 1');
        expect(text).toContain('❌ 1 échec(s)');
        expect(text).toContain('❌'); // Icon for ECHEC
        expect(text).toContain('Erreur:'); // Error details
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should truncate results when more than 30 files', async () => {
        const dirs = Array.from({ length: 35 }, (_, i) => ({
            name: `conv-${String(i).padStart(3, '0')}`,
            isDirectory: () => true
        }));

        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue(dirs);
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue(createBomBuffer('[{"role":"user"}]'));
        mockWriteFile.mockResolvedValue(undefined);

        const result = await handler({ dry_run: false });
        const text = (result.content[0] as any).text;

        expect(text).toContain('30 premiers résultats');
        expect(text).toContain('et 5 autres résultats');
    });

    it('should ignore missing files gracefully', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true },
            { name: 'conv-002', isDirectory: () => true }
        ]);
        // First file exists, second doesn't
        mockAccess.mockImplementation((path: string) => {
            if (path.includes('conv-001')) return Promise.resolve(undefined);
            throw new Error('ENOENT');
        });
        mockReadFile.mockResolvedValue(createBomBuffer('[{"role":"user"}]'));
        mockWriteFile.mockResolvedValue(undefined);

        const result = await handler({ dry_run: false });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers analysés:** 1');
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });

    it('should handle directory read errors', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockRejectedValue(new Error('Permission denied'));

        const result = await handler({ dry_run: false });
        const text = (result.content[0] as any).text;

        expect(text).toContain('Fichiers analysés:** 0');
        expect(text).toContain('Fichiers corrompus (BOM):** 0');
    });

    it('should default dry_run to false when not specified', async () => {
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockReaddir.mockResolvedValue([
            { name: 'conv-001', isDirectory: () => true }
        ]);
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue(Buffer.from('[{"role":"user"}]', 'utf-8'));

        const result = await handler({});
        const text = (result.content[0] as any).text;

        expect(text).toContain('Réparation réelle');
        expect(text).not.toContain('Simulation (dry-run)');
    });
});
