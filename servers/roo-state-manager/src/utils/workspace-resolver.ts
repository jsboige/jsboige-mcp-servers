/**
 * Workspace Resolver — Auto-detects the calling agent's workspace
 *
 * #1861: Solves the auto-detection bug where codebase_search defaults to
 * the MCP server's directory instead of the agent's project workspace.
 *
 * Resolution chain (first wins):
 * 1. Explicit parameter — caller provided workspace
 * 2. MCP roots — server.listRoots() from the connected client
 * 3. WORKSPACE_PATH env var — configured in .claude.json
 * 4. process.cwd() — last resort (MCP server dir, usually wrong)
 *
 * @version 1.0.0
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('WorkspaceResolver');

let _server: Server | null = null;
let _cachedRoots: string[] | null = null;

/**
 * Inject the MCP server instance for roots/list access.
 * Called once during handler registration.
 */
export function setServerReference(server: Server): void {
	_server = server;
}

/**
 * Resolve the workspace path for a tool call.
 *
 * @param explicitWorkspace - Workspace provided by the caller (highest priority)
 * @returns Resolved workspace path
 */
export async function resolveWorkspace(explicitWorkspace?: string): Promise<{
	workspace: string;
	source: 'explicit' | 'mcp-roots' | 'env-var' | 'cwd';
}> {
	// 1. Explicit parameter (highest priority)
	if (explicitWorkspace && explicitWorkspace.trim().length > 0) {
		return { workspace: explicitWorkspace, source: 'explicit' };
	}

	// 2. MCP roots — ask the client for its workspace roots
	if (_server) {
		try {
			const rootsResponse = await _server.listRoots();
			if (rootsResponse?.roots?.length > 0) {
				// Use the first root as the primary workspace
				const rootUri = rootsResponse.roots[0].uri;
				// file:// URI to path
				let rootPath = rootUri;
				if (rootUri.startsWith('file://')) {
					rootPath = decodeURIComponent(rootUri.slice(7));
					// Windows: file:///C:/dev/project → C:/dev/project
					if (rootPath.startsWith('/') && rootPath.length > 2 && rootPath.charAt(2) === ':') {
						rootPath = rootPath.slice(1);
					}
				}
				_cachedRoots = rootsResponse.roots.map(r => {
					let p = r.uri;
					if (p.startsWith('file://')) {
						p = decodeURIComponent(p.slice(7));
						if (p.startsWith('/') && p.length > 2 && p.charAt(2) === ':') {
							p = p.slice(1);
						}
					}
					return p;
				});
				logger.info(`[resolveWorkspace] MCP roots: ${rootPath} (${rootsResponse.roots.length} roots)`);
				return { workspace: rootPath, source: 'mcp-roots' };
			}
		} catch (err) {
			// Client doesn't support roots, or not connected yet
			logger.debug(`[resolveWorkspace] listRoots() failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// 3. WORKSPACE_PATH env var
	const envWorkspace = process.env.WORKSPACE_PATH;
	if (envWorkspace) {
		return { workspace: envWorkspace, source: 'env-var' };
	}

	// 4. Last resort: process.cwd() (usually the MCP server dir)
	return { workspace: process.cwd(), source: 'cwd' };
}

/**
 * Get all cached roots from the last listRoots() call.
 * Returns empty array if roots were never fetched.
 */
export function getCachedRoots(): string[] {
	return _cachedRoots ?? [];
}

/**
 * Reset for testing.
 * @internal
 */
export function resetWorkspaceResolver(): void {
	_server = null;
	_cachedRoots = null;
}
