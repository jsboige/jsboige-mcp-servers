import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMcpBestPractices } from '../../../src/tools/get_mcp_best_practices.js';

// Mock fs module
vi.mock('fs/promises', () => {
    const mockReadFile = vi.fn();
    const mockStat = vi.fn();
    const mockReaddir = vi.fn();
    return {
        readFile: mockReadFile,
        stat: mockStat,
        readdir: mockReaddir,
    };
});

describe('get_mcp_best_practices Tool', () => {
    let mockReadFile: any;
    let mockStat: any;
    let mockReaddir: any;

    beforeEach(async () => {
        const fsModule: any = await vi.importMock('fs/promises');
        mockReadFile = fsModule.readFile;
        mockStat = fsModule.stat;
        mockReaddir = fsModule.readdir;
        vi.clearAllMocks();
    });

    it('should return guide without mcp_name', async () => {
        mockReadFile.mockRejectedValue(new Error('File not found'));
        
        const result = await getMcpBestPractices.handler({});
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
        expect(textContent).toContain('PATTERNS DE DÉBOGAGE ÉPROUVÉS');
        expect(textContent).toContain('WORKFLOW DE DÉBOGAGE SYSTÉMATIQUE');
        expect(textContent).toContain('CHECKLIST DE DÉBOGAGE URGENT');
        expect(textContent).toContain('ERREURS COMMUNES DOCUMENTÉES');
        expect(textContent).toContain('CONFIGURATION MCP ESSENTIELLE');
        expect(textContent).toContain('BONNES PRATIQUES VALIDÉES');
        expect(textContent).toContain('OUTILS ROO-STATE-MANAGER ESSENTIELS');
        expect(textContent).toContain('GROUNDING POUR AGENTS EXTERNES');
    });

    it('should return MCP specific analysis', async () => {
        // Mock mcp_settings.json
        mockReadFile.mockImplementation((path: string) => {
            if (path.includes('mcp_settings.json')) {
                return Promise.resolve(JSON.stringify({
                    mcpServers: {
                        'test-mcp': {
                            command: 'node /path/to/test-mcp/index.js',
                            options: { cwd: '/path/to/test-mcp' }
                        }
                    }
                }));
            }
            return Promise.reject(new Error('File not found'));
        });

        // Mock fs.stat pour le chemin MCP
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);

        // Mock fs.readdir pour lister les fichiers
        mockReaddir.mockResolvedValue(['index.js', 'package.json', 'src']);

        const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('test-mcp');
        expect(textContent).toContain('ANALYSE DÉTAILLÉE');
        expect(textContent).toContain('Arborescence de développement');
    });

    it('should handle missing MCP', async () => {
        mockReadFile.mockResolvedValue(JSON.stringify({
            mcpServers: {
                'other-mcp': { command: 'node /path/to/other-mcp/index.js' }
            }
        }));

        const result = await getMcpBestPractices.handler({ mcp_name: 'non-existent-mcp' });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('MCP "non-existent-mcp" non trouvé');
    });

    it('should handle disabled MCPs', async () => {
        mockReadFile.mockResolvedValue(JSON.stringify({
            mcpServers: {
                'disabled-mcp': {
                    command: 'node /path/to/disabled-mcp/index.js',
                    disabled: true
                }
            }
        }));

        const result = await getMcpBestPractices.handler({});
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('disabled-mcp');
        expect(textContent).toContain('Désactivé');
    });

    it('should handle file system errors', async () => {
        mockReadFile.mockRejectedValue(new Error('Permission denied'));

        const result = await getMcpBestPractices.handler({});
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        // Should still return the guide even if mcp_settings.json can't be read
        expect(textContent).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
    });

    it('should handle package info reading', async () => {
        // Mock mcp_settings.json
        mockReadFile.mockImplementation((path: string) => {
            if (path.includes('mcp_settings.json')) {
                return Promise.resolve(JSON.stringify({
                    mcpServers: {
                        'test-mcp': {
                            command: 'node /path/to/test-mcp/index.js',
                            options: { cwd: '/path/to/test-mcp' }
                        }
                    }
                }));
            }
            if (path.includes('package.json')) {
                return Promise.resolve(JSON.stringify({
                    name: 'test-mcp',
                    version: '1.0.0',
                    description: 'Test MCP',
                    scripts: {
                        build: 'tsc',
                        test: 'vitest'
                    },
                    dependencies: {
                        '@modelcontextprotocol/sdk': '^1.0.0'
                    }
                }));
            }
            return Promise.reject(new Error('File not found'));
        });

        // Mock fs.stat pour le chemin MCP
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);

        // Mock fs.readdir pour lister les fichiers
        mockReaddir.mockResolvedValue(['index.js', 'package.json', 'src']);

        const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('test-mcp');
        expect(textContent).toContain('1.0.0');
        expect(textContent).toContain('Test MCP');
        expect(textContent).toContain('Informations du package');
    });
});
