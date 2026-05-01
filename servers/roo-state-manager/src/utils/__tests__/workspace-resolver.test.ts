/**
 * Tests for workspace-resolver.ts
 * #1861: Auto-detection of workspace for codebase_search
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveWorkspace, resetWorkspaceResolver, setServerReference, getCachedRoots } from '../workspace-resolver.js';

describe('workspace-resolver', () => {
	beforeEach(() => {
		resetWorkspaceResolver();
		delete process.env.WORKSPACE_PATH;
	});

	describe('resolveWorkspace', () => {
		it('returns explicit workspace with source "explicit"', async () => {
			const result = await resolveWorkspace('C:/dev/roo-extensions');
			expect(result).toEqual({
				workspace: 'C:/dev/roo-extensions',
				source: 'explicit',
			});
		});

		it('trims and returns explicit workspace', async () => {
			const result = await resolveWorkspace('  C:/dev/roo-extensions  ');
			expect(result.workspace).toBe('  C:/dev/roo-extensions  ');
			expect(result.source).toBe('explicit');
		});

		it('falls back to MCP roots when no explicit workspace', async () => {
			const mockServer = {
				listRoots: vi.fn().mockResolvedValue({
					roots: [{ uri: 'file:///C:/dev/roo-extensions' }],
				}),
			} as any;

			setServerReference(mockServer);
			const result = await resolveWorkspace();
			expect(result).toEqual({
				workspace: 'C:/dev/roo-extensions',
				source: 'mcp-roots',
			});
			expect(mockServer.listRoots).toHaveBeenCalledOnce();
		});

		it('handles Windows file:/// URIs correctly', async () => {
			const mockServer = {
				listRoots: vi.fn().mockResolvedValue({
					roots: [{ uri: 'file:///D:/Dev/my-project' }],
				}),
			} as any;

			setServerReference(mockServer);
			const result = await resolveWorkspace();
			expect(result.workspace).toBe('D:/Dev/my-project');
			expect(result.source).toBe('mcp-roots');
		});

		it('falls back to WORKSPACE_PATH env var when MCP roots unavailable', async () => {
			// No server reference
			process.env.WORKSPACE_PATH = '/home/user/project';

			const result = await resolveWorkspace();
			expect(result).toEqual({
				workspace: '/home/user/project',
				source: 'env-var',
			});
		});

		it('falls back to process.cwd() as last resort', async () => {
			// No server, no env var
			const result = await resolveWorkspace();
			expect(result.source).toBe('cwd');
			expect(result.workspace).toBe(process.cwd());
		});

		it('falls back from MCP roots error to env var', async () => {
			const mockServer = {
				listRoots: vi.fn().mockRejectedValue(new Error('Client does not support roots')),
			} as any;

			setServerReference(mockServer);
			process.env.WORKSPACE_PATH = 'C:/fallback';

			const result = await resolveWorkspace();
			expect(result).toEqual({
				workspace: 'C:/fallback',
				source: 'env-var',
			});
		});

		it('handles empty roots array', async () => {
			const mockServer = {
				listRoots: vi.fn().mockResolvedValue({ roots: [] }),
			} as any;

			setServerReference(mockServer);
			process.env.WORKSPACE_PATH = 'C:/env-fallback';

			const result = await resolveWorkspace();
			expect(result.source).toBe('env-var');
		});

		it('empty string treated as missing', async () => {
			process.env.WORKSPACE_PATH = 'C:/via-env';

			const result = await resolveWorkspace('');
			expect(result.source).toBe('env-var');
		});

		it('caches roots from listRoots call', async () => {
			const mockServer = {
				listRoots: vi.fn().mockResolvedValue({
					roots: [
						{ uri: 'file:///C:/dev/project1' },
						{ uri: 'file:///C:/dev/project2' },
					],
				}),
			} as any;

			setServerReference(mockServer);
			await resolveWorkspace();

			const cached = getCachedRoots();
			expect(cached).toEqual(['C:/dev/project1', 'C:/dev/project2']);
		});
	});
});
