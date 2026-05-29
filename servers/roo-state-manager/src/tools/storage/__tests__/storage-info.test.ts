/**
 * Tests pour l'outil consolidé storage_info (CONS-13)
 * Updated for #2429: Zoo-Code storage stats alongside Roo.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Define mock functions at top level so they persist across clearAllMocks
const mockDetectRooStorage = vi.fn();
const mockGetStorageStats = vi.fn();
const mockGetWorkspaceBreakdown = vi.fn();
const mockZooDetectStorageLocations = vi.fn();
const mockZooGetStorageStats = vi.fn();

vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectRooStorage: mockDetectRooStorage,
        getStorageStats: mockGetStorageStats,
        getWorkspaceBreakdown: mockGetWorkspaceBreakdown
    }
}));

vi.mock('../../../utils/zoo-storage-detector.js', () => ({
    ZOO_CODE_EXTENSION_ID: 'zoocodeorganization.zoo-code',
    ZooStorageDetector: {
        detectStorageLocations: mockZooDetectStorageLocations,
        getStorageStats: mockZooGetStorageStats,
    }
}));

describe('storage_info tool (CONS-13)', () => {
    let handleStorageInfo: typeof import('../storage-info.js').handleStorageInfo;
    let storageInfoTool: typeof import('../storage-info.js').storageInfoTool;

    beforeEach(async () => {
        vi.clearAllMocks();

        // Re-setup mock return values after clearAllMocks
        mockDetectRooStorage.mockResolvedValue({
            locations: ['/path/to/storage'],
            totalConversations: 5
        });
        mockGetStorageStats.mockResolvedValue({
            totalSize: 1024000,
            totalConversations: 10,
            totalLocations: 1
        });
        mockGetWorkspaceBreakdown.mockResolvedValue({
            '/workspace/a': { conversations: 5, size: 512000 },
            '/workspace/b': { conversations: 5, size: 512000 }
        });

        // Zoo-Code: no storage by default
        mockZooDetectStorageLocations.mockResolvedValue([]);
        mockZooGetStorageStats.mockResolvedValue({
            totalLocations: 0,
            totalConversations: 0,
            totalSize: 0
        });

        const mod = await import('../storage-info.js');
        handleStorageInfo = mod.handleStorageInfo;
        storageInfoTool = mod.storageInfoTool;
    });

    describe('Tool definition', () => {
        test('should have correct name', () => {
            expect(storageInfoTool.definition.name).toBe('storage_info');
        });

        test('should have description', () => {
            expect(storageInfoTool.definition.description).toBeTruthy();
        });

        test('should require action parameter', () => {
            expect(storageInfoTool.definition.inputSchema.required).toContain('action');
        });

        test('should have action enum with detect and stats', () => {
            const actionProp = storageInfoTool.definition.inputSchema.properties.action as any;
            expect(actionProp.enum).toContain('detect');
            expect(actionProp.enum).toContain('stats');
        });
    });

    describe('action=detect', () => {
        test('should call detectRooStorage and return result', async () => {
            const result = await handleStorageInfo({ action: 'detect' });

            expect(mockDetectRooStorage).toHaveBeenCalled();
            expect(result.content).toBeDefined();
            expect(result.content.length).toBe(1);
            expect(result.content[0].type).toBe('text');

            const data = JSON.parse((result.content[0] as any).text);
            expect(data.locations).toContain('/path/to/storage');
            expect(data.totalConversations).toBe(5);
        });

        test('should not have isError flag', async () => {
            const result = await handleStorageInfo({ action: 'detect' });
            expect(result.isError).toBeUndefined();
        });
    });

    describe('action=stats', () => {
        test('should call getStorageStats and getWorkspaceBreakdown', async () => {
            const result = await handleStorageInfo({ action: 'stats' });

            expect(mockGetStorageStats).toHaveBeenCalled();
            expect(mockGetWorkspaceBreakdown).toHaveBeenCalled();

            const data = JSON.parse((result.content[0] as any).text);
            // Flat top-level backward compatible keys
            expect(data.totalSize).toBe(1024000);
            expect(data.totalConversations).toBe(10);
            // Nested roo stats
            expect(data.roo).toBeDefined();
            expect(data.roo.totalSize).toBe(1024000);
            expect(data.roo.totalConversations).toBe(10);
            expect(data.workspaceBreakdown).toBeDefined();
            expect(data.totalWorkspaces).toBe(2);
        });

        test('should not include zooCode when no Zoo storage present', async () => {
            const result = await handleStorageInfo({ action: 'stats' });
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.zooCode).toBeUndefined();
        });

        test('should include zooCode when Zoo storage is present', async () => {
            mockZooGetStorageStats.mockResolvedValue({
                totalLocations: 1,
                totalConversations: 360,
                totalSize: 2048000
            });

            const result = await handleStorageInfo({ action: 'stats' });
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.zooCode).toBeDefined();
            expect(data.zooCode.totalConversations).toBe(360);
            expect(data.zooCode.totalSize).toBe(2048000);
        });

        test('should include workspace breakdown details', async () => {
            const result = await handleStorageInfo({ action: 'stats' });
            const data = JSON.parse((result.content[0] as any).text);

            expect(data.workspaceBreakdown['/workspace/a']).toBeDefined();
            expect(data.workspaceBreakdown['/workspace/b']).toBeDefined();
        });
    });

    describe('invalid action', () => {
        test('should return error for unknown action', async () => {
            const result = await handleStorageInfo({ action: 'unknown' as any });
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Action inconnue');
        });
    });
});
