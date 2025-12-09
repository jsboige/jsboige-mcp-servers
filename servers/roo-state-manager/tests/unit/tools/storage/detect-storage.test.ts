import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectStorageTool } from '../../../../src/tools/storage/detect-storage.tool';
import { RooStorageDetector } from '../../../../src/utils/roo-storage-detector';

// Mock RooStorageDetector
vi.mock('../../../../src/utils/roo-storage-detector');

describe('detect_roo_storage tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should have correct definition', () => {
        expect(detectStorageTool.definition.name).toBe('detect_roo_storage');
        expect(detectStorageTool.definition.description).toBe('Détecte automatiquement les emplacements de stockage Roo et scanne les conversations existantes');
        expect(detectStorageTool.definition.inputSchema).toEqual({
            type: 'object',
            properties: {},
            required: []
        });
    });

    it('should call RooStorageDetector.detectRooStorage and return result', async () => {
        const mockResult = {
            globalStoragePath: '/mock/path',
            tasksPath: '/mock/path/tasks',
            tasksFound: 10,
            workspacesFound: 2,
            locations: []
        };

        vi.mocked(RooStorageDetector.detectRooStorage).mockResolvedValue(mockResult);

        const result = await detectStorageTool.handler({});

        expect(RooStorageDetector.detectRooStorage).toHaveBeenCalled();
        expect(result).toEqual({
            content: [{
                type: 'text',
                text: JSON.stringify(mockResult, null, 2)
            }]
        });
    });

    it('should handle errors from RooStorageDetector', async () => {
        const mockError = new Error('Detection failed');
        vi.mocked(RooStorageDetector.detectRooStorage).mockRejectedValue(mockError);

        await expect(detectStorageTool.handler({})).rejects.toThrow('Detection failed');
    });
});