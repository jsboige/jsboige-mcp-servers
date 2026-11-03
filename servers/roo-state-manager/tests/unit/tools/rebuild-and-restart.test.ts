import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rebuildAndRestart } from '../../../src/tools/rebuild-and-restart.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// #4149 (famille ms#1630) : le touch est execFile argv sans shell ; le build
// reste exec sur une chaîne CONSTANTE (CVE-2024-27980 : Node refuse de spawner
// un .cmd/.bat sans shell — execFile('npm.cmd', …) lève spawn EINVAL).
vi.mock('child_process', () => {
    const mockExec = vi.fn();
    const mockExecFile = vi.fn();
    return {
        exec: mockExec,
        execFile: mockExecFile,
    };
});

// Mock fs/promises
vi.mock('fs/promises', () => {
    const mockReadFile = vi.fn();
    const mockAccess = vi.fn();
    return {
        readFile: mockReadFile,
        access: mockAccess,
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

const TOUCH_SCRIPT = '(Get-Item -LiteralPath $env:RSM_TOUCH_PATH).LastWriteTime = Get-Date';

describe('rebuild_and_restart_mcp Tool', () => {
    let mockExec: any;
    let mockExecFile: any;
    let mockReadFile: any;
    let mockAccess: any;
    let mockJoin: any;

    beforeEach(async () => {
        // Récupérer les mocks
        const childProcess = await vi.importMock('child_process');
        const fsPromises = await vi.importMock('fs/promises');
        const pathModule = await vi.importMock('path');

        mockExec = childProcess.exec;
        mockExecFile = childProcess.execFile;
        mockReadFile = fsPromises.readFile;
        mockAccess = fsPromises.access;
        mockJoin = pathModule.join;

        vi.clearAllMocks();

        // #4006: rebuild exige un package.json au chemin résolu — présent par
        // défaut pour garder la sémantique des tests legacy.
        mockAccess.mockResolvedValue(undefined);

        // Défauts : build via exec (chaîne constante), touch via execFile argv.
        mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
            cb(null, 'Build output', '');
        });
        mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
            cb(null, 'Touched', '');
        });

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
        const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

        expect(result.content[0].text).toContain('Build for "test-mcp" successful');
        expect(result.content[0].text).toContain('targeted restart via watchPaths');
        // Le build voyage par exec — ligne CONSTANTE, mcpPath passe par cwd
        // uniquement (CVE-2024-27980 : pas de .cmd spawne sans shell).
        expect(mockExec).toHaveBeenCalledWith('npm run build', expect.objectContaining({ cwd: '/path/to/test-mcp', windowsHide: true, timeout: 120_000 }), expect.any(Function));
        expect(mockExecFile).toHaveBeenCalledWith('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOUCH_SCRIPT], expect.objectContaining({ windowsHide: true, timeout: 15_000 }), expect.any(Function));
    });

    it('should fallback to global restart when watchPaths is missing', async () => {
        const result = await rebuildAndRestart.handler({ mcp_name: 'mcp-without-watchpaths' });

        expect(result.content[0].text).toContain('global restart as fallback');
        expect(result.content[0].text).toContain('WARNING');
    });

    it('should handle MCP with options.cwd', async () => {
        const result = await rebuildAndRestart.handler({ mcp_name: 'mcp-with-options-cwd' });

        expect(result.content[0].text).toContain('Build for "mcp-with-options-cwd" successful');
        expect(mockExec).toHaveBeenCalledWith('npm run build', expect.objectContaining({ cwd: '/path/to/mcp-with-options-cwd', windowsHide: true, timeout: 120_000 }), expect.any(Function));
    });

    it('should throw error when MCP not found', async () => {
        const result = await rebuildAndRestart.handler({ mcp_name: 'non-existent-mcp' });

        expect(result.content[0].text).toContain('Error during rebuild and restart');
        expect(result.content[0].text).toContain('not found in settings file');
    });

    it('should handle build failure', async () => {
        mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
            cb(new Error('Build failed'), '', '');
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

        expect(result.content[0].text).toContain('Error during rebuild and restart');
        expect(result.content[0].text).toContain('Build failed');
    });

    it('should handle touch file failure', async () => {
        mockExecFile.mockImplementation((file: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => {
            if (file === 'powershell.exe') {
                cb(new Error('Touch failed'), '', '');
            }
        });

        const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

        expect(result.content[0].text).toContain('Error during rebuild and restart');
        expect(result.content[0].text).toContain('Touch failed');
    });
});
