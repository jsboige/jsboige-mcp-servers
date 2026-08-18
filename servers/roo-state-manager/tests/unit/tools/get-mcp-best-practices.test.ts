/**
 * Tests consolidés pour get_mcp_best_practices.ts (#833 P1-3)
 *
 * Fusion des 4 suites historiques :
 *   - src/tools/__tests__/get-mcp-best-practices.test.ts (16 tests, fs mocké)
 *   - src/tools/__tests__/get-mcp-best-practices-internals.test.ts (16 tests, fs mocké)
 *   - src/tools/__tests__/get_mcp_best_practices.test.ts (20 tests, fs réel)
 *   - tests/unit/tools/get-mcp-best-practices.test.ts (6 tests, fs mocké)
 *
 * Stratégie unifiée : fs RÉEL (répertoires temporaires) + mock de
 * getMcpSettingsPath uniquement. Chaque assertion unique des 4 fichiers
 * est préservée (table de correspondance dans la PR).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockGetMcpSettingsPath = vi.hoisted(() => vi.fn());

vi.mock('../../../src/tools/roosync/mcp-management.js', () => ({
	getMcpSettingsPath: mockGetMcpSettingsPath,
}));

import {
	getMcpBestPractices,
	getMcpConfiguration,
	getMcpPath,
	scanMcpDirectory,
	getPackageInfo,
} from '../../../src/tools/get_mcp_best_practices.js';

const NO_SETTINGS = path.join(os.tmpdir(), `no-settings-${Date.now()}.json`);

describe('get_mcp_best_practices', () => {
	let tmpRoot: string;
	let tmpSettingsFile: string;
	let savedAppdata: string | undefined;

	beforeEach(async () => {
		tmpRoot = path.join(os.tmpdir(), `mcp-bp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		await fs.mkdir(tmpRoot, { recursive: true });
		tmpSettingsFile = path.join(tmpRoot, 'mcp_settings.json');
		mockGetMcpSettingsPath.mockReturnValue(NO_SETTINGS);
	});

	afterEach(async () => {
		if (savedAppdata !== undefined) {
			process.env.APPDATA = savedAppdata;
			savedAppdata = undefined;
		}
		await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	});

	async function writeSettings(settings: Record<string, unknown>): Promise<void> {
		await fs.writeFile(tmpSettingsFile, JSON.stringify(settings));
		mockGetMcpSettingsPath.mockReturnValue(tmpSettingsFile);
	}

	describe('tool metadata', () => {
		it('should have correct name', () => {
			expect(getMcpBestPractices.name).toBe('get_mcp_best_practices');
		});

		it('should have description mentioning MCP', () => {
			expect(getMcpBestPractices.description).toBeDefined();
			expect(getMcpBestPractices.description).toContain('MCP');
		});

		it('should accept optional mcp_name parameter', () => {
			expect(getMcpBestPractices.inputSchema.properties.mcp_name).toBeDefined();
			expect(getMcpBestPractices.inputSchema.required).toEqual([]);
		});
	});

	describe('handler without mcp_name', () => {
		it('should return the complete guide with all sections', async () => {
			const result = await getMcpBestPractices.handler({});
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe('text');
			const text = result.content[0].text as string;
			expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
			expect(text).toContain('PATTERNS DE DÉBOGAGE ÉPROUVÉS');
			expect(text).toContain('WORKFLOW DE DÉBOGAGE SYSTÉMATIQUE');
			expect(text).toContain('CHECKLIST DE DÉBOGAGE URGENT');
			expect(text).toContain('ERREURS COMMUNES DOCUMENTÉES');
			expect(text).toContain('CONFIGURATION MCP ESSENTIELLE');
			expect(text).toContain('BONNES PRATIQUES VALIDÉES');
			expect(text).toContain('OUTILS ROO-STATE-MANAGER ESSENTIELS');
			expect(text).toContain('GROUNDING POUR AGENTS EXTERNES');
			expect(text.length).toBeGreaterThan(500);
		});

		it('should omit current-configuration section when settings are absent', async () => {
			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;
			expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
			expect(text).not.toContain('CONFIGURATION MCP ACTUELLE');
		});

		it('should include watchPaths / hot-reload explanation', async () => {
			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;
			expect(text).toContain('watchPaths');
			expect(text).toContain('Hot-Reload');
		});

		it('should include cwd / stable relative paths explanation', async () => {
			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;
			expect(text).toContain('cwd');
			expect(text).toContain('Chemins Relatifs Stables');
		});

		it('should include essential tools table', async () => {
			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;
			expect(text).toContain('roosync_mcp_management touch');
			expect(text).toContain('roosync_mcp_management rebuild');
			expect(text).toContain('read_vscode_logs');
		});

		it('should include configuration section when settings exist', async () => {
			await writeSettings({
				mcpServers: {
					'test-mcp': { transportType: 'stdio', disabled: false, description: 'Test MCP' },
				},
			});

			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('CONFIGURATION MCP ACTUELLE');
			expect(text).toContain('test-mcp');
			expect(text).toContain('✅ Actif');
		});

		it('should list disabled MCPs as disabled', async () => {
			await writeSettings({
				mcpServers: {
					'disabled-mcp': { command: 'node', args: ['/path/to/disabled-mcp/index.js'], disabled: true },
				},
			});

			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('disabled-mcp');
			expect(text).toContain('❌ Désactivé');
		});

		it('should still return the guide when settings file is unreadable (error not leaked)', async () => {
			// A directory as settings path makes fs.readFile throw EISDIR —
			// the real-fs equivalent of the historical "fs/network error" mocks.
			mockGetMcpSettingsPath.mockReturnValue(tmpRoot);

			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
			expect(text).not.toContain('EISDIR');
		});

		it('should work without APPDATA environment variable', async () => {
			savedAppdata = process.env.APPDATA;
			delete process.env.APPDATA;

			const result = await getMcpBestPractices.handler({});
			const text = result.content[0].text as string;

			expect(text).toContain('GUIDE EXPERT DE DÉBOGAGE MCP');
		});
	});

	describe('handler with mcp_name parameter', () => {
		it('should report MCP not found with available list', async () => {
			await writeSettings({
				mcpServers: {
					'other-mcp': { command: 'node', args: ['/path/to/other-mcp/index.js'] },
				},
			});

			const result = await getMcpBestPractices.handler({ mcp_name: 'non-existent-mcp' });
			const text = result.content[0].text as string;

			expect(text).toContain('MCP "non-existent-mcp" non trouvé');
			expect(text).toContain('other-mcp');
		});

		it('should include detailed analysis: config, tree, package info, commands', async () => {
			const mcpDir = path.join(tmpRoot, 'test-mcp-home');
			await fs.mkdir(path.join(mcpDir, 'src'), { recursive: true });
			await fs.writeFile(path.join(mcpDir, 'package.json'), JSON.stringify({
				name: 'test-mcp',
				version: '1.0.0',
				description: 'Test MCP',
				scripts: { build: 'tsc', test: 'vitest' },
				dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
			}));
			await fs.writeFile(path.join(mcpDir, 'src', 'index.ts'), '');

			await writeSettings({
				mcpServers: {
					'test-mcp': {
						command: 'node',
						args: ['/path/to/test-mcp/index.js'],
						options: { cwd: mcpDir },
					},
				},
			});

			const result = await getMcpBestPractices.handler({ mcp_name: 'test-mcp' });
			const text = result.content[0].text as string;

			expect(text).toContain('ANALYSE DÉTAILLÉE: TEST-MCP');
			expect(text).toContain('⚙️ Configuration');
			expect(text).toContain('Arborescence de développement');
			expect(text).toContain('Structure du MCP');
			expect(text).toContain('Informations du package');
			expect(text).toContain('test-mcp');
			expect(text).toContain('1.0.0');
			expect(text).toContain('Test MCP');
		});

		it('should generate development commands with npm workflow and rebuild hook', async () => {
			await writeSettings({
				mcpServers: {
					'dev-mcp': {
						command: 'node',
						args: ['/dev/mcp/build/index.js'],
					},
				},
			});

			const result = await getMcpBestPractices.handler({ mcp_name: 'dev-mcp' });
			const text = result.content[0].text as string;

			expect(text).toContain('🚀 Commandes de développement');
			expect(text).toContain('npm install');
			expect(text).toContain('npm run build');
			expect(text).toContain('use_mcp_tool roo-state-manager roosync_mcp_management {"action": "rebuild"');
		});

		it('should render full package information for a complex package.json', async () => {
			const mcpDir = path.join(tmpRoot, 'complex-mcp-home');
			await fs.mkdir(mcpDir, { recursive: true });
			await fs.writeFile(path.join(mcpDir, 'package.json'), JSON.stringify({
				name: 'complex-mcp',
				version: '2.1.0',
				description: 'A complex MCP with many features',
				scripts: {
					build: 'tsc -b',
					test: 'vitest run',
					lint: 'eslint',
					typecheck: 'tsc --noEmit',
					clean: 'rimraf dist',
					prebuild: 'npm run clean',
				},
				dependencies: {
					'@modelcontextprotocol/sdk': '^1.0.0',
					'zod': '^3.22.0',
					'chalk': '^5.3.0',
				},
				devDependencies: { '@types/node': '^20.0.0', 'typescript': '^5.0.0' },
				keywords: ['mcp', 'tool', 'ai'],
				author: 'Test Author',
				license: 'MIT',
				repository: { type: 'git', url: 'https://github.com/test/mcp.git' },
			}));

			await writeSettings({
				mcpServers: {
					'complex-mcp': {
						command: 'node',
						args: ['/some/very/deep/path/to/mcp.js', 'arg1'],
						transportType: 'stdio',
						disabled: false,
						description: 'Complex MCP for testing',
						options: { cwd: mcpDir },
					},
				},
			});

			const result = await getMcpBestPractices.handler({ mcp_name: 'complex-mcp' });
			const text = result.content[0].text as string;

			expect(text).toContain('complex-mcp');
			expect(text).toContain('📦 Informations du package');
			expect(text).toContain('Dépendances principales (3)');
		});

		it('should render configuration for an MCP with relative paths', async () => {
			await writeSettings({
				mcpServers: {
					'relative-path-mcp': {
						transportType: 'stdio',
						disabled: false,
						description: 'MCP with relative paths',
						command: 'node',
						args: ['./dist/index.js'],
						options: { cwd: './relative/path' },
					},
				},
			});

			const result = await getMcpBestPractices.handler({ mcp_name: 'relative-path-mcp' });
			const text = result.content[0].text as string;

			expect(text).toContain('relative-path-mcp');
			expect(text).toContain('⚙️ Configuration');
		});
	});

	describe('internals: getMcpConfiguration', () => {
		it('should return parsed MCP settings when file exists', async () => {
			const mockSettings = {
				mcpServers: {
					'test-mcp': { command: 'node', description: 'Test MCP' },
				},
			};
			await writeSettings(mockSettings);

			const result = await getMcpConfiguration();
			expect(result).toEqual(mockSettings);
			expect(result?.mcpServers['test-mcp'].command).toBe('node');
		});

		it('should return null when file does not exist', async () => {
			mockGetMcpSettingsPath.mockReturnValue('/non/existent/path/settings.json');
			expect(await getMcpConfiguration()).toBeNull();
		});

		it('should return null when file contains invalid JSON', async () => {
			await fs.writeFile(tmpSettingsFile, 'not valid json');
			mockGetMcpSettingsPath.mockReturnValue(tmpSettingsFile);
			expect(await getMcpConfiguration()).toBeNull();
		});
	});

	describe('internals: getMcpPath', () => {
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

		it('should use args[0] branch even when command is node (args branch takes priority)', async () => {
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

	describe('internals: scanMcpDirectory', () => {
		it('should return error for non-existent directory', async () => {
			const result = await scanMcpDirectory('/non/existent/path');
			expect(result).toContain('Erreur');
		});

		it('should return warning for a file path (not directory)', async () => {
			const filePath = path.join(tmpRoot, 'file.txt');
			await fs.writeFile(filePath, 'test');
			const result = await scanMcpDirectory(filePath);
			expect(result).toContain("n'est pas un répertoire");
		});

		it('should list key files and directories', async () => {
			await fs.writeFile(path.join(tmpRoot, 'package.json'), '{}');
			await fs.writeFile(path.join(tmpRoot, 'README.md'), '# Test');
			await fs.mkdir(path.join(tmpRoot, 'src'));
			await fs.writeFile(path.join(tmpRoot, 'src', 'index.ts'), '');
			await fs.mkdir(path.join(tmpRoot, 'build'));

			const result = await scanMcpDirectory(tmpRoot);
			expect(result).toContain('Structure du MCP');
			expect(result).toContain(String(tmpRoot).split(path.sep).pop()!);
			expect(result).toContain('package.json');
			expect(result).toContain('README.md');
			expect(result).toContain('src');
			expect(result).toContain('build');
		});

		it('should preserve the header when no key entries exist (partial stat failures)', async () => {
			// Empty directory: every keyPath stat fails — header must survive.
			const result = await scanMcpDirectory(tmpRoot);
			expect(result).toContain('Structure du MCP');
			expect(result).not.toContain('package.json');
		});

		it('should list contents of key subdirectories', async () => {
			const srcDir = path.join(tmpRoot, 'src');
			await fs.mkdir(srcDir, { recursive: true });
			await fs.writeFile(path.join(srcDir, 'server.ts'), '');
			await fs.writeFile(path.join(srcDir, 'utils.ts'), '');

			const result = await scanMcpDirectory(tmpRoot);
			expect(result).toContain('server.ts');
			expect(result).toContain('utils.ts');
		});

		it('should truncate listing when more than 10 items', async () => {
			const srcDir = path.join(tmpRoot, 'src');
			await fs.mkdir(srcDir, { recursive: true });
			for (let i = 0; i < 15; i++) {
				await fs.writeFile(path.join(srcDir, `file${i}.ts`), '');
			}

			const result = await scanMcpDirectory(tmpRoot);
			expect(result).toContain('autres fichiers');
		});
	});

	describe('internals: getPackageInfo', () => {
		it('should return package info from package.json', async () => {
			const pkg = {
				name: 'test-mcp',
				version: '1.0.0',
				description: 'A test MCP',
				scripts: { build: 'tsc', test: 'vitest' },
				dependencies: { express: '^4.18.0' },
			};
			await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify(pkg));

			const result = await getPackageInfo(tmpRoot);
			expect(result).toContain('Informations du package');
			expect(result).toContain('Nom: test-mcp');
			expect(result).toContain('Version: 1.0.0');
			expect(result).toContain('tsc');
			expect(result).toContain('express');
		});

		it('should handle missing package.json', async () => {
			const result = await getPackageInfo(tmpRoot);
			expect(result).toContain('Aucun package.json');
		});

		it('should handle invalid package.json', async () => {
			await fs.writeFile(path.join(tmpRoot, 'package.json'), 'invalid json');
			const result = await getPackageInfo(tmpRoot);
			expect(result).toContain('Aucun package.json');
		});

		it('should handle package.json with missing optional fields', async () => {
			await fs.writeFile(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'minimal-mcp', version: '0.0.1' }));

			const result = await getPackageInfo(tmpRoot);
			expect(result).toContain('Nom: minimal-mcp');
			expect(result).toContain('Version: 0.0.1');
			expect(result).toContain('N/A');
			expect(result).not.toContain('Scripts disponibles');
			expect(result).not.toContain('pendances principales');
		});
	});
});
