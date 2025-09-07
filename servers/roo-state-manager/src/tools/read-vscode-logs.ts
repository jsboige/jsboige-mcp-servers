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
    async execute(args: { lines?: number; filter?: string }): Promise<CallToolResult> {
        const lineCount = args.lines || 100;
        const { filter } = args;
        const rootLogsPath = path.join(process.env.APPDATA || '', 'Code', 'logs');
        const debugLog: string[] = [`[DEBUG] Starting log search in: ${rootLogsPath}`];

        if (!process.env.APPDATA) {
            return { content: [{ type: 'text' as const, text: 'APPDATA environment variable not set. Cannot find logs directory.' }] };
        }

        try {
            const dirents = await fs.readdir(rootLogsPath, { withFileTypes: true });
            debugLog.push(`[DEBUG] Found ${dirents.length} entries in root log path.`);
            const sessionDirs = dirents
                .filter(d => d.isDirectory() && /^\d{8}T\d{6}$/.test(d.name))
                .sort((a, b) => b.name.localeCompare(a.name));

            if (sessionDirs.length === 0) {
                debugLog.push('[DEBUG] No session directories found.');
                return { content: [{ type: 'text' as const, text: `No session log directory found in ${rootLogsPath}.\n\n${debugLog.join('\n')}` }] };
            }

            // Find the first session directory that contains window subdirectories
            debugLog.push(`[DEBUG] NEW LOGIC: Starting search through ${sessionDirs.length} session directories`);
            let sessionPath: string | null = null;
            let windowDirs: Dirent[] = [];

            for (const sessionDir of sessionDirs) {
                const candidatePath = path.join(rootLogsPath, sessionDir.name);
                debugLog.push(`[DEBUG] Checking session directory: ${candidatePath}`);
                
                try {
                    const entries = await fs.readdir(candidatePath, { withFileTypes: true });
                    debugLog.push(`[DEBUG] Found ${entries.length} entries in ${candidatePath}`);
                    
                    const windowSubDirs = entries.filter(d => d.isDirectory() && d.name.startsWith('window'));
                    debugLog.push(`[DEBUG] Found ${windowSubDirs.length} window directories in ${candidatePath}`);
                    
                    if (windowSubDirs.length > 0) {
                        sessionPath = candidatePath;
                        windowDirs = entries;
                        debugLog.push(`[DEBUG] Selected session directory: ${sessionPath}`);
                        break;
                    }
                } catch (err) {
                    debugLog.push(`[DEBUG] Error reading ${candidatePath}: ${err}`);
                    continue;
                }
            }

            if (!sessionPath) {
                debugLog.push('[DEBUG] No session directory with window subdirectories found.');
                return { content: [{ type: 'text' as const, text: `No valid session directory found in ${rootLogsPath}.\n\n${debugLog.join('\n')}` }] };
            }
            
            const latestWindow = windowDirs
                .filter(d => d.isDirectory() && d.name.startsWith('window'))
                .sort((a, b) => b.name.localeCompare(a.name))
                [0];

            if (!latestWindow) {
                debugLog.push(`[DEBUG] No window directories found in ${sessionPath}.`);
                return { content: [{ type: 'text' as const, text: `No window directory found in ${sessionPath}.\n\n${debugLog.join('\n')}` }] };
            }

            const windowPath = path.join(sessionPath, latestWindow.name);
            debugLog.push(`[DEBUG] Selected window directory: ${windowPath}`);
            const logResults: { category: string; path: string; content: string }[] = [];

            // 1. Renderer Log
            const rendererLogPath = path.join(windowPath, 'renderer.log');
            try {
                await fs.access(rendererLogPath);
                logResults.push({
                    category: 'renderer',
                    path: rendererLogPath,
                    content: await readLastLines(rendererLogPath, lineCount, filter),
                });
            } catch (e) { /* ignore */ }

            // 2. Extension Host Log
            const exthostPath = path.join(windowPath, 'exthost');
            const exthostLogPath = path.join(exthostPath, 'exthost.log');
             try {
                await fs.access(exthostLogPath);
                logResults.push({
                    category: 'exthost',
                    path: exthostLogPath,
                    content: await readLastLines(exthostLogPath, lineCount, filter),
                });
            } catch (e) { /* ignore */ }

            // 3. Roo-Code Output Channel Log
            try {
                const outputDirs = await fs.readdir(exthostPath, { withFileTypes: true });
                const latestOutputDir = outputDirs
                    .filter(d => d.isDirectory() && d.name.startsWith('output_logging_'))
                    .sort((a, b) => b.name.localeCompare(a.name))
                    [0];
                
                if (latestOutputDir) {
                    const rooLogPath = path.join(exthostPath, latestOutputDir.name, '1-Roo-Code.log');
                    await fs.access(rooLogPath);
                    logResults.push({
                        category: 'Roo-Code Output',
                        path: rooLogPath,
                        content: await readLastLines(rooLogPath, lineCount, filter),
                    });
                }
            } catch (e) { /* ignore */ }

            if (logResults.length === 0) {
                debugLog.push('[DEBUG] Found 0 log files after checking all categories.');
                return { content: [{ type: 'text' as const, text: `No relevant log files found in latest session ${sessionPath}.\n\n${debugLog.join('\n')}` }] };
            }
            
            const resultText = logResults.map(r => `--- LOG: ${r.category} ---\nPath: ${r.path}\n\n${r.content}`).join('\n\n');
            return { content: [{ type: 'text' as const, text: resultText }] };

        } catch (error) {
            const errorMessage = `Failed to read VS Code logs: ${(error as Error).stack}`;
            console.error(errorMessage);
            return { content: [{ type: 'text' as const, text: errorMessage }] };
        }
    },
};