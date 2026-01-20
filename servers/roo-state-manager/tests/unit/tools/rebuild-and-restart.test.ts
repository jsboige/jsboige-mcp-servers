import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rebuildAndRestart } from '../../../src/tools/rebuild-and-restart.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock child_process.exec
vi.mock('child_process', () => {
    const mockExec = vi.fn();
    return {
        exec: mockExec,
    };
});

// Mock fs/promises
vi.mock('fs/promises', () => {
    const mockReadFile = vi.fn();
    return {
        readFile: mockReadFile,
    };
});

// Mock path.join
vi.mock('path', async () => {
    const actualPath = await vi.importActual('path');
    return {
        ...actualPath,
        join: vi.fn((...args: string[]) => args.join('/')),
    };
});

describe('rebuild_and_restart_mcp Tool', () => {
    let mockExec: any;
    let mockReadFile: any;
    let mockJoin: any;

    beforeEach(async () => {
        // Récupérer les mocks
        const childProcess = await vi.importMock('child_process');
        const fsPromises = await vi.importMock('fs/promises');
        const pathModule = await vi.importMock('path');
        
        mockExec = childProcess.exec;
        mockReadFile = fsPromises.readFile;
        mockJoin = pathModule.join;
        
        vi.clearAllMocks();
        
        // Mock par défaut pour readFile
        mockReadFile.mockResolvedValue(JSON.stringify({
            mcpServers: {
                'test-mcp': {
                    command: 'node /path/to/test-mcp/index.js',
                    cwd: '/path/to/test-mcp',
                    watchPaths: ['/path/to/test-mcp/build/index.js'],
                },
                'mcp-without-watchpaths': {
                    command: 'node /path/to/mcp-without-watchpaths/index.js',
                    cwd: '/path/to/mcp-without-watchpaths',
                },
                'mcp-with-options-cwd': {
                    command: 'node /path/to/mcp-with-options-cwd/index.js',
                    options: {
                        cwd: '/path/to/mcp-with-options-cwd',
                    },
                    watchPaths: ['/path/to/mcp-with-options-cwd/build/index.js'],
                },
            },
        }));
    });

    it('should rebuild and restart MCP with watchPaths', async () => {
        // Mock exec pour gérer les deux cas (avec et sans options)
        mockExec.mockImplementation((command: string, optionsOrCallback: any, callback?: any) => {
            const cb = callback || optionsOrCallback;
            if (command === 'npm run build') {
                cb(null, 'Build output', '');
            } else if (command.includes('powershell.exe')) {
                cb(null, 'Touched', '');
            }
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });
        
        expect(result.content[0].text).toContain('Build for "test-mcp" successful');
        expect(result.content[0].text).toContain('targeted restart via watchPaths');
        expect(mockExec).toHaveBeenCalledWith('npm run build', { cwd: '/path/to/test-mcp' }, expect.any(Function));
        expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('powershell.exe'), expect.any(Function));
    });

    it('should fallback to global restart when watchPaths is missing', async () => {
        mockExec.mockImplementation((command: string, optionsOrCallback: any, callback?: any) => {
            const cb = callback || optionsOrCallback;
            if (command === 'npm run build') {
                cb(null, 'Build output', '');
            } else if (command.includes('powershell.exe')) {
                cb(null, 'Touched', '');
            }
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'mcp-without-watchpaths' });
        
        expect(result.content[0].text).toContain('global restart as fallback');
        expect(result.content[0].text).toContain('WARNING');
    });

    it('should handle MCP with options.cwd', async () => {
        mockExec.mockImplementation((command: string, optionsOrCallback: any, callback?: any) => {
            const cb = callback || optionsOrCallback;
            if (command === 'npm run build') {
                cb(null, 'Build output', '');
            } else if (command.includes('powershell.exe')) {
                cb(null, 'Touched', '');
            }
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'mcp-with-options-cwd' });
        
        expect(result.content[0].text).toContain('Build for "mcp-with-options-cwd" successful');
        expect(mockExec).toHaveBeenCalledWith('npm run build', { cwd: '/path/to/mcp-with-options-cwd' }, expect.any(Function));
    });

    it('should throw error when MCP not found', async () => {
        const result = await rebuildAndRestart.handler({ mcp_name: 'non-existent-mcp' });
        
        expect(result.content[0].text).toContain('Error during rebuild and restart');
        expect(result.content[0].text).toContain('not found in settings file');
    });

    it('should handle build failure', async () => {
        mockExec.mockImplementation((command: string, optionsOrCallback: any, callback?: any) => {
            const cb = callback || optionsOrCallback;
            if (command === 'npm run build') {
                cb(new Error('Build failed'), '', '');
            }
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });
        
        expect(result.content[0].text).toContain('Error during rebuild and restart');
        expect(result.content[0].text).toContain('Build failed');
    });

    it('should handle touch file failure', async () => {
        mockExec.mockImplementation((command: string, optionsOrCallback: any, callback?: any) => {
            const cb = callback || optionsOrCallback;
            if (command === 'npm run build') {
                cb(null, 'Build output', '');
            } else if (command.includes('powershell.exe')) {
                cb(new Error('Touch failed'), '', '');
            }
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });
        
        expect(result.content[0].text).toContain('Error during rebuild and restart');
        expect(result.content[0].text).toContain('Touch failed');
    });
});
