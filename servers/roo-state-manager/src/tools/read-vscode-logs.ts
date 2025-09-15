import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import { Dirent } from 'fs';
import * as path from 'path';

// Helper to recursively find files matching a filename
async function findLogFilesRecursive(dir: string): Promise<string[]> {
    let results: string[] = [];
    try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
            const res = path.resolve(dir, dirent.name);
            if (dirent.isDirectory()) {
                results = results.concat(await findLogFilesRecursive(res));
            } else if (dirent.name.endsWith('.log')) {
                results.push(res);
            }
        }
    } catch (error) {
        // Ignore errors
    }
    return results;
}

// Helper to read the last N lines of a file
async function readLastLines(filePath: string, lineCount: number, filter?: string): Promise<string> {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        let lines = data.split(/\r?\n/).filter(line => line.trim() !== ''); // Handles both LF and CRLF
        if (filter) {
            try {
                const regex = new RegExp(filter, 'i');
                lines = lines.filter(line => regex.test(line));
            } catch (e) {
                // Fallback to simple string inclusion if regex is invalid
                lines = lines.filter(line => line.toLowerCase().includes(filter.toLowerCase()));
            }
        }
        return lines.slice(-lineCount).join('\n');
    } catch (error) {
        return `Error reading ${filePath}: ${(error as Error).message}`;
    }
}

export const readVscodeLogs = {
    name: 'read_vscode_logs',
    description: 'Scans the VS Code log directory to automatically find and read the latest logs from the Extension Host, Renderer, and Roo-Code Output Channels.',
    inputSchema: {
        type: 'object',
        properties: {
            lines: { type: 'number', description: 'Number of lines to read from the end of each log file.', default: 100 },
            filter: { type: 'string', description: 'A keyword or regex to filter log lines.' },
        },
    },
       async handler(args: { lines?: number; filter?: string }): Promise<CallToolResult> {
        const lineCount = args.lines || 100;
        const { filter } = args;
        const debugLog: string[] = [];

        try {
            if (!process.env.APPDATA) {
                return { content: [{ type: 'text' as const, text: 'APPDATA environment variable not set. Cannot find logs directory.' }] };
            }
            const rootLogsPath = path.join(process.env.APPDATA, 'Code', 'logs');
            debugLog.push(`[DEBUG] Scanning for logs in: ${rootLogsPath}`);

            const sessionDirs = (await fs.readdir(rootLogsPath, { withFileTypes: true }))
                .filter(d => d.isDirectory() && /^\d{8}T\d{6}$/.test(d.name))
                .sort((a, b) => b.name.localeCompare(a.name));

            if (sessionDirs.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No VS Code session log directories found.' }] };
            }
            const latestSessionPath = path.join(rootLogsPath, sessionDirs[0].name);
            debugLog.push(`[DEBUG] Latest session directory: ${latestSessionPath}`);

            const windowDirs = (await fs.readdir(latestSessionPath, { withFileTypes: true }))
                .filter(d => d.isDirectory() && d.name.startsWith('window'))
                .sort((a, b) => b.name.localeCompare(a.name));

            if (windowDirs.length === 0) {
                return { content: [{ type: 'text' as const, text: `No 'window' subdirectories found in ${latestSessionPath}` }] };
            }
            const latestWindowPath = path.join(latestSessionPath, windowDirs[0].name);
            debugLog.push(`[DEBUG] Latest window directory: ${latestWindowPath}`);

            const logPaths = {
                renderer: path.join(latestWindowPath, 'renderer.log'),
                exthost: path.join(latestWindowPath, 'exthost', 'exthost.log'),
                roo: '', // Will be determined dynamically
            };

            // Find the Roo-Code output log dynamically
            const exthostPath = path.join(latestWindowPath, 'exthost');
            const outputDirs = (await fs.readdir(exthostPath, { withFileTypes: true }).catch(() => []))
                .filter(d => d.isDirectory() && d.name.startsWith('output_logging_'))
                .sort((a, b) => b.name.localeCompare(a.name));
            
            if (outputDirs.length > 0) {
                const latestOutputPath = path.join(exthostPath, outputDirs[0].name);
                logPaths.roo = path.join(latestOutputPath, '1-Roo-Code.log');
                debugLog.push(`[DEBUG] Found Roo log output directory: ${latestOutputPath}`);
            } else {
                 debugLog.push(`[DEBUG] No Roo log output directory found in ${exthostPath}`);
            }

            let combinedLogs = '';
            for (const [name, logPath] of Object.entries(logPaths)) {
                 if (logPath) {
                    try {
                        await fs.access(logPath); // Check if file exists
                        const content = await readLastLines(logPath, lineCount, filter);
                        combinedLogs += `--- LOG: ${name} ---\nPath: ${logPath}\n\n${content}\n\n`;
                        debugLog.push(`[DEBUG] Successfully read ${content.split('\n').length} lines from ${name} log.`);
                    } catch (e) {
                        const errorMsg = `--- LOG: ${name} ---\nPath: ${logPath}\n\nFile not found or unreadable.\n\n`;
                        combinedLogs += errorMsg;
                        debugLog.push(`[DEBUG] Could not read ${name} log at ${logPath}.`);
                    }
                 }
            }

            const finalResult = filter ? combinedLogs : `${combinedLogs.trim()}\n\n--- DEBUG LOG ---\n${debugLog.join('\n')}`;

            return { content: [{ type: 'text' as const, text: finalResult.trim() }] };

        } catch (error) {
            const errorMessage = `Failed to read VS Code logs: ${(error as Error).stack}\n\nDEBUG LOG:\n${debugLog.join('\n')}`;
            console.error(errorMessage);
            return { content: [{ type: 'text' as const, text: errorMessage }] };
        }
    },
};