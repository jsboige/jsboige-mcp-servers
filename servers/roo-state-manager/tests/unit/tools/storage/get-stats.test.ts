import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStorageStatsTool } from '@/tools/storage/get-stats.tool';
import { RooStorageDetector } from '@/utils/roo-storage-detector';

// Mock RooStorageDetector
vi.mock('@/utils/roo-storage-detector');

describe('get_storage_stats tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should have correct definition', () => {
        expect(getStorageStatsTool.definition.name).toBe('get_storage_stats');
        expect(getStorageStatsTool.definition.description).toBe('Calcule des statistiques sur le stockage (nombre de conversations, taille totale).');
        expect(getStorageStatsTool.definition.inputSchema).toEqual({
            type: 'object',
            properties: {},
            required: []
        });
    });

    it('should call RooStorageDetector methods and return enhanced stats', async () => {
        const mockStats = {
            totalConversations: 100,
            totalSize: 1024000,
            lastUpdate: '2023-01-01T00:00:00Z'
        };

        const mockBreakdown = {
            '/workspace/a': { count: 60, size: 600000 },
            '/workspace/b': { count: 40, size: 424000 }
        };

        vi.mocked(RooStorageDetector.getStorageStats).mockResolvedValue(mockStats);
        vi.mocked(RooStorageDetector.getWorkspaceBreakdown).mockResolvedValue(mockBreakdown);

        const result = await getStorageStatsTool.handler({});

        expect(RooStorageDetector.getStorageStats).toHaveBeenCalled();
        expect(RooStorageDetector.getWorkspaceBreakdown).toHaveBeenCalled();

        const expectedResult = {
            ...mockStats,
            workspaceBreakdown: mockBreakdown,
            totalWorkspaces: 2
        };

        expect(result).toEqual({
            content: [{
                type: 'text',
                text: JSON.stringify(expectedResult, null, 2)
            }]
        });
    });

    it('should handle errors', async () => {
        const mockError = new Error('Stats calculation failed');
        vi.mocked(RooStorageDetector.getStorageStats).mockRejectedValue(mockError);

        await expect(getStorageStatsTool.handler({})).rejects.toThrow('Stats calculation failed');
    });
});