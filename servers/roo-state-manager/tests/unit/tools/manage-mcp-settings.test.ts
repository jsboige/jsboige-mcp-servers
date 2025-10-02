import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const MOCK_SETTINGS_PATH = '/mock/mcp_settings.json';

// Mock fs/promises et le chemin avant d'importer l'outil
jest.unstable_mockModule('fs/promises', () => ({
    default: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
    },
}));

jest.unstable_mockModule('../../../src/tools/manage-mcp-settings.js', async () => {
    const originalModule = await import('../src/tools/manage-mcp-settings.js');
    return {
        ...originalModule,
        MCP_SETTINGS_PATH: MOCK_SETTINGS_PATH,
    };
});

const { manageMcpSettings } = await import('../src/tools/manage-mcp-settings.js');

describe('manage_mcp_settings Tool', () => {
    const mockSettings = {
        mcpServers: {
            'server-a': { disabled: false, command: 'node a.js' },
            'server-b': { disabled: true, command: 'node b.js' },
        }
    };

    beforeEach(() => {
        mockReadFile.mockResolvedValue(JSON.stringify(mockSettings) as never);
        mockWriteFile.mockResolvedValue(undefined as never);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should read the settings file', async () => {
        await manageMcpSettings.handler({ action: 'read' });
        expect(mockReadFile).toHaveBeenCalledWith(MOCK_SETTINGS_PATH, 'utf-8');
    });

    it('should write new settings to the file', async () => {
        const newSettings = { mcpServers: { 'server-c': { enabled: true, command: 'node c.js' } } };
        await manageMcpSettings.handler({ action: 'write', settings: newSettings });
        expect(mockWriteFile).toHaveBeenCalledWith(MOCK_SETTINGS_PATH, JSON.stringify(newSettings, null, 2), 'utf-8');
    });
});