import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GenericError, GenericErrorCode } from '../types/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runNpmBuild(mcpPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec('npm run build', { cwd: mcpPath }, (error, stdout, stderr) => {
            if (error) {
                return reject(new GenericError(`Build failed: ${error.message}`, GenericErrorCode.FILE_SYSTEM_ERROR));
            }
            resolve(stdout);
        });
    });
}

async function touchFile(filePath: string): Promise<string> {
    const command = `(Get-Item -LiteralPath "${filePath}").LastWriteTime = Get-Date`;
    return new Promise((resolve, reject) => {
        exec(`powershell.exe -Command "${command}"`, (error, stdout, stderr) => {
            if (error) {
                return reject(new GenericError(`Touch failed for ${filePath}: ${error.message}`, GenericErrorCode.FILE_SYSTEM_ERROR));
            }
            resolve(`Touched: ${filePath}`);
        });
    });
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
            const settingsPath = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
            
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
                touchResult = await touchFile(settingsPath);
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
