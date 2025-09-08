import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runNpmBuild(mcpPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec('npm run build', { cwd: mcpPath }, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`Build failed: ${error.message}\n${stderr}`));
            }
            resolve(stdout);
        });
    });
}

async function touchMcpSettings(): Promise<string> {
    const settingsPath = "c:/Users/jsboi/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json";
    const command = `(Get-Item "${settingsPath}").LastWriteTime = Get-Date`;
    return new Promise((resolve, reject) => {
        exec(`powershell.exe -Command "${command}"`, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`Touch failed: ${error.message}\n${stderr}`));
            }
            resolve(stdout.trim());
        });
    });
}

export const rebuildAndRestart = {
    name: 'rebuild_and_restart_mcp',
    description: 'Rebuilds a specific MCP and then restarts all MCPs by touching the global settings file.',
    inputSchema: {
        type: 'object',
        properties: {
            mcp_name: { type: 'string', description: 'The name of the MCP to rebuild, as defined in mcp_settings.json.' },
        },
        required: ['mcp_name'],
    },
    async handler(args: { mcp_name: string }): Promise<CallToolResult> {
        try {
            const { mcp_name } = args;
            const settingsPath = "c:/Users/jsboi/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json";
            
            const settingsContent = await fs.readFile(settingsPath, 'utf-8');
            const settings = JSON.parse(settingsContent);
            
            const mcpConfig = settings.mcpServers?.[mcp_name];
            if (!mcpConfig) {
                throw new Error(`MCP "${mcp_name}" not found in settings file.`);
            }

            let mcpPath: string;
            if (mcpConfig.options?.cwd) {
                mcpPath = mcpConfig.options.cwd;
            } else if (mcpConfig.args?.[0]) {
                // Infer path from the first argument, assuming it's a path to the main script
                mcpPath = path.dirname(path.dirname(mcpConfig.args[0]));
            } else {
                throw new Error(`Could not determine the working directory for MCP "${mcp_name}". Please add a "cwd" property to its configuration.`);
            }

            const buildResult = await runNpmBuild(mcpPath);
            const touchResult = await touchMcpSettings();

            const resultText = `Build for "${mcp_name}" successful:\n${buildResult}\n\nAll MCPs restart triggered:\n${touchResult}`;
            
            return { content: [{ type: 'text' as const, text: resultText }] };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text' as const, text: `Error during rebuild and restart: ${errorMessage}` }] };
        }
    },
};