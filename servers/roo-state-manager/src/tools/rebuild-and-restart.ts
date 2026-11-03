import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { exec, execFile, ExecFileOptions, ExecOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GenericError, GenericErrorCode } from '../types/errors.js';
import { getMcpSettingsPath, withEBUSYRetry } from './roosync/mcp-management.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default timeouts */
const BUILD_TIMEOUT_MS = 120_000; // 120s for npm build
const TOUCH_TIMEOUT_MS = 15_000;  // 15s for PowerShell touch

/**
 * Execute a shell command with timeout protection. For CONSTANT command lines
 * only (#4149 review): `mcpPath` travels as `cwd`, never through the command
 * string, so nothing user-controlled reaches the shell. Kills the child
 * process if timeout expires, preventing zombie processes.
 */
function execWithTimeout(command: string, options: ExecOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = exec(command, options, (error, stdout, stderr) => {
            if (error) {
                const msg = (error as any).killed
                    ? `Command timed out after ${options.timeout}ms: ${command}`
                    : error.message;
                return reject(new GenericError(msg, GenericErrorCode.FILE_SYSTEM_ERROR));
            }
            resolve(stdout?.toString() ?? '');
        });

        // Safety net: ensure child is killed if process exits prematurely
        const cleanup = () => { try { child.kill(); } catch {} };
        process.on('exit', cleanup);
        child.on('exit', () => { process.removeListener('exit', cleanup); });
    });
}

/**
 * Execute a program with timeout protection, WITHOUT a shell (#4149, famille
 * ms#1630): the command line is an argv array, so every interpolated value is
 * a literal argument — no quote in a path can close it and start a new one.
 * Kills the child process if timeout expires, preventing zombie processes.
 */
function execFileWithTimeout(file: string, args: string[], options: ExecFileOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, options, (error, stdout, stderr) => {
            if (error) {
                const msg = (error as any).killed
                    ? `Command timed out after ${options.timeout}ms: ${file} ${args.join(' ')}`
                    : error.message;
                return reject(new GenericError(msg, GenericErrorCode.FILE_SYSTEM_ERROR));
            }
            resolve(stdout?.toString() ?? '');
        });

        // Safety net: ensure child is killed if process exits prematurely
        const cleanup = () => { try { child.kill(); } catch {} };
        process.on('exit', cleanup);
        child.on('exit', () => { process.removeListener('exit', cleanup); });
    });
}

async function runNpmBuild(mcpPath: string): Promise<string> {
    // #2307 (Phase 4, item EBUSY) : retry borné partagé avec roosync_mcp_management
    // rebuild — l'hôte MCP vivant tient sqlite3.node chargé sous Windows, le
    // remplacement du binaire natif peut échouer en EBUSY de façon transitoire.
    // CVE-2024-27980 (mesuré ai-01 v24.14.1 / web2 v24.19.0) : Node refuse de
    // spawner un .cmd/.bat sans shell — execFile('npm.cmd', …) lève spawn
    // EINVAL, `npm` nu rend ENOENT sur win32. La ligne est une CONSTANTE et
    // mcpPath ne voyage que par cwd : pas un site #4149, on garde la forme de
    // main (exec). L'invariant est épinglé par test : jamais de .cmd/.bat via
    // execFile sans shell.
    return withEBUSYRetry(() =>
        execWithTimeout('npm run build', { cwd: mcpPath, windowsHide: true, timeout: BUILD_TIMEOUT_MS })
    );
}

async function touchFile(filePath: string): Promise<string> {
    // #4149 (famille ms#1630) : l'ancienne forme interpolait filePath dans un
    // script pwsh -Command — un `"` dans le chemin séparait l'argument. Le
    // chemin passe maintenant par une variable d'environnement, qu'aucun shell
    // ne ré-analyse : le script est une constante, la donnée reste une donnée.
    const script = '(Get-Item -LiteralPath $env:RSM_TOUCH_PATH).LastWriteTime = Get-Date';
    return execFileWithTimeout(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: TOUCH_TIMEOUT_MS, env: { ...process.env, RSM_TOUCH_PATH: filePath } }
    ).then(() => `Touched: ${filePath}`);
}

export const rebuildAndRestart = {
    name: 'rebuild_and_restart_mcp',
    description: 'Rebuilds a specific MCP and triggers a restart. Prefers a targeted restart by touching the first file in `watchPaths` if available, ensuring reliability. Falls back to a global restart by touching the settings file. Warns the user if `watchPaths` is not configured.',
    inputSchema: {
        type: 'object',
        properties: {
            mcp_name: { type: 'string', description: 'The name of the MCP to rebuild, as defined in mcp_settings.json.' },
        },
        required: ['mcp_name'],
    },
    handler: async (args: { mcp_name: string }): Promise<CallToolResult> => {
        try {
            const { mcp_name } = args;
            // FIX: Use centralized getMcpSettingsPath() with safety guard
            // instead of inline path resolution (no test isolation protection).
            const settingsPath = getMcpSettingsPath();
            
            const settingsContent = await fs.readFile(settingsPath, 'utf-8');
            const settings = JSON.parse(settingsContent);
            
            const mcpConfig = settings.mcpServers?.[mcp_name];
            if (!mcpConfig) {
                throw new GenericError(`MCP "${mcp_name}" not found in settings file.`, GenericErrorCode.INVALID_ARGUMENT);
            }

            let mcpPath: string;
            // Updated cwd logic to check root property first
            if (mcpConfig.cwd) {
                mcpPath = mcpConfig.cwd;
            } else if (mcpConfig.options?.cwd) {
                mcpPath = mcpConfig.options.cwd;
            } else if (mcpConfig.args?.[0] && (mcpConfig.args[0].includes('/') || mcpConfig.args[0].includes('\\'))) {
                mcpPath = path.dirname(path.dirname(mcpConfig.args[0]));
            } else {
                throw new GenericError(`Could not determine working directory for MCP "${mcp_name}". Please add a "cwd" property to its configuration.`, GenericErrorCode.INVALID_ARGUMENT);
            }

            // #4006: refuse to build outside a package root — the dirname×2
            // heuristic can resolve to a filesystem root where `npm run build`
            // would fail obscurely or hit the wrong project (same guard as
            // roosync_mcp_management rebuild).
            try {
                await fs.access(path.join(mcpPath, 'package.json'));
            } catch {
                throw new GenericError(
                    `Resolved path "${mcpPath}" for MCP "${mcp_name}" has no package.json — the args[0] heuristic is probably wrong. Please add a "cwd" property pointing at the server root.`,
                    GenericErrorCode.INVALID_ARGUMENT
                );
            }

            let warningMessage = '';
            if (!mcpConfig.watchPaths || mcpConfig.watchPaths.length === 0) {
                warningMessage = `\n\n[WARNING] MCP "${mcp_name}" has no 'watchPaths' configured. The restart is triggered globally, which is less reliable. For best results, add a 'watchPaths' property to its configuration pointing to the build output file.`;
            }

            const buildResult = await runNpmBuild(mcpPath);
            
            let touchResult: string;
            if (mcpConfig.watchPaths && mcpConfig.watchPaths.length > 0) {
                const fileToTouch = mcpConfig.watchPaths[0];
                touchResult = await touchFile(fileToTouch);
                touchResult += ` (targeted restart via watchPaths)`;
            } else {
                // #2307 : le fallback global ne touche le fichier de settings
                // qu'UNE fois — un double touch déclenchait deux redémarrages
                // globaux consécutifs (ligne dupliquée, mesurée par test).
                touchResult = await touchFile(settingsPath);
                touchResult += ` (global restart as fallback)`;
            }

            const resultText = `Build for "${mcp_name}" successful:\n${buildResult}\n\nRestart triggered:\n${touchResult}${warningMessage}`;
            
            return { content: [{ type: 'text', text: resultText }] };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text', text: `Error during rebuild and restart: ${errorMessage}` }] };
        }
    },
};
