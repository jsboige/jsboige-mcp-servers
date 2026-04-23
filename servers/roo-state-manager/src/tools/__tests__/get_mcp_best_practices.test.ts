import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockGetMcpSettingsPath = vi.hoisted(() => vi.fn());

vi.mock('../roosync/mcp-management.js', () => ({
	getMcpSettingsPath: mockGetMcpSettingsPath,
}));

import {
	getMcpConfiguration,
	getMcpPath,
	scanMcpDirectory,
	getPackageInfo,
} from '../get_mcp_best_practices.js';
import { getMcpBestPractices } from '../get_mcp_best_practices.js';

describe('get_mcp_best_practices', () => {
	describe('getMcpConfiguration', () => {
		let tmpFile: string;

		afterEach(async () => {
			if (tmpFile) {
				await fs.unlink(tmpFile).catch(() => {});
			}
		});

		it('should return parsed MCP settings when file exists', async () => {
			const mockSettings = {
				mcpServers: {
					'test-mcp': { command: 'node', description: 'Test MCP' },
				},
			};
			tmpFile = path.join(os.tmpdir(), `mcp-settings-test-${Date.now()}.json`);
			await fs.writeFile(tmpFile, JSON.stringify(mockSettings));
			mockGetMcpSettingsPath.mockReturnValue(tmpFile);

			const result = await getMcpConfiguration();
			expect(result).toEqual(mockSettings);
			expect(result?.mcpServers['test-mcp'].command).toBe('node');
		});

		it('should return null when file does not exist', async () => {
			mockGetMcpSettingsPath.mockReturnValue('/non/existent/path/settings.json');

			const result = await getMcpConfiguration();
			expect(result).toBeNull();
		});

		it('should return null when file contains invalid JSON', async () => {
			tmpFile = path.join(os.tmpdir(), `mcp-settings-invalid-${Date.now()}.json`);
			await fs.writeFile(tmpFile, 'not valid json');
			mockGetMcpSettingsPath.mockReturnValue(tmpFile);

			const result = await getMcpConfiguration();
			expect(result).toBeNull();
		});
	});

	describe('getMcpPath', () => {
		it('should return null when config is undefined', async () => {
			expect(await getMcpPath('test-mcp', undefined)).toBeNull();
		});

		it('should extract path from options.cwd', async () => {
			const config = { options: { cwd: '/path/to/mcp' } };
			expect(await getMcpPath('test-mcp', config as any)).toBe('/path/to/mcp');
		});

		it('should extract path from args[0] using dirname(dirname())', async () => {
			const config = { args: ['/path/to/mcp/build/index.js'] };
			const result = await getMcpPath('test-mcp', config as any);
			expect(result).toBe(path.dirname(path.dirname('/path/to/mcp/build/index.js')));
		});

		it('should extract path when command is node and args contain a path', async () => {
			const config = { command: 'node', args: ['/some/deep/path/to/build/index.js'] };
			const result = await getMcpPath('test-mcp', config as any);
			expect(result).toBe(path.dirname(path.dirname('/some/deep/path/to/build/index.js')));
		});

		it('should return null when config has no args, no cwd, and no node command', async () => {
			const config = { command: 'python' };
			expect(await getMcpPath('test-mcp', config as any)).toBeNull();
		});

		it('should resolve dirname(dirname()) for non-path args[0]', async () => {
			const config = { command: 'python', args: ['server.py'] };
			expect(await getMcpPath('test-mcp', config as any)).toBe('.');
		});
	});

	describe('scanMcpDirectory', () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = path.join(os.tmpdir(), `mcp-scan-test-${Date.now()}`);
			await fs.mkdir(tmpDir, { recursive: true });
		});

		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		});

		it('should return error for non-existent directory', async () => {
			const result = await scanMcpDirectory('/non/existent/path');
			expect(result).toContain('Erreur');
		});

		it('should return warning for a file path (not directory)', async () => {
			const filePath = path.join(tmpDir, 'file.txt');
			await fs.writeFile(filePath, 'test');
			const result = await scanMcpDirectory(filePath);
			expect(result).toContain("n'est pas un répertoire");
		});

		it('should list key files and directories', async () => {
			await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
			await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
			await fs.mkdir(path.join(tmpDir, 'src'));
			await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), '');
			await fs.mkdir(path.join(tmpDir, 'build'));

			const result = await scanMcpDirectory(tmpDir);
			expect(result).toContain('package.json');
			expect(result).toContain('README.md');
			expect(result).toContain('src');
			expect(result).toContain('build');
		});

		it('should list contents of key subdirectories', async () => {
			const srcDir = path.join(tmpDir, 'src');
			await fs.mkdir(srcDir, { recursive: true });
			await fs.writeFile(path.join(srcDir, 'server.ts'), '');
			await fs.writeFile(path.join(srcDir, 'utils.ts'), '');

			const result = await scanMcpDirectory(tmpDir);
			expect(result).toContain('server.ts');
			expect(result).toContain('utils.ts');
		});

		it('should truncate listing when more than 10 items', async () => {
			const srcDir = path.join(tmpDir, 'src');
			await fs.mkdir(srcDir, { recursive: true });
			for (let i = 0; i < 15; i++) {
				await fs.writeFile(path.join(srcDir, `file${i}.ts`), '');
			}

			const result = await scanMcpDirectory(tmpDir);
			expect(result).toContain('autres fichiers');
		});
	});

	describe('getPackageInfo', () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = path.join(os.tmpdir(), `mcp-pkg-test-${Date.now()}`);
			await fs.mkdir(tmpDir, { recursive: true });
		});

		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		});

		it('should return package info from package.json', async () => {
			const pkg = {
				name: 'test-mcp',
				version: '1.0.0',
				description: 'A test MCP',
				scripts: { build: 'tsc', test: 'vitest' },
				dependencies: { express: '^4.18.0' },
			};
			await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

			const result = await getPackageInfo(tmpDir);
			expect(result).toContain('test-mcp');
			expect(result).toContain('1.0.0');
			expect(result).toContain('tsc');
			expect(result).toContain('express');
		});

		it('should handle missing package.json', async () => {
			const result = await getPackageInfo(tmpDir);
			expect(result).toContain('Aucun package.json');
		});

		it('should handle package.json with missing fields', async () => {
			await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');

			const result = await getPackageInfo(tmpDir);
			expect(result).toContain('N/A');
		});
	});

	describe('handler', () => {
		it('should return comprehensive guide without mcp_name', async () => {
			const result = await getMcpBestPractices.handler({});
			expect(result.content[0].type).toBe('text');
			const text = result.content[0].text as string;
			expect(text).toContain('GUIDE EXPERT');
			expect(text).toContain('PATTERNS DE DÉBOGAGE');
			expect(text).toContain('CHECKLIST');
			expect(text).toContain('ERREURS COMMUNES');
			expect(text).toContain('BONNES PRATIQUES');
		});

		it('should include MCP-specific analysis when mcp_name provided', async () => {
			const result = await getMcpBestPractices.handler({ mcp_name: 'nonexistent-mcp-xyz' });
			const text = result.content[0].text as string;
			expect(text).toContain('ANALYSE DÉTAILLÉE');
			expect(text).toContain('non trouvé');
		});

		it('should include configuration section when settings available', async () => {
			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;
			expect(text.length).toBeGreaterThan(500);
		});
	});
});
