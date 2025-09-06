import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Helper to recursively find files matching a filename
async function findFilesRecursive(dir: string, fileName: string): Promise<string[]> {
    let results: string[] = [];
    try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
            const res = path.resolve(dir, dirent.name);
            if (dirent.isDirectory()) {
                results = results.concat(await findFilesRecursive(res, fileName));
            } else if (dirent.name === fileName) {
                results.push(res);
            }
        }
    } catch (error) {
        // Ignore errors like permission denied
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
        const logsBasePath = path.join(process.env.APPDATA || '', 'Code', 'logs');

        if (!process.env.APPDATA) {
            return { content: [{ type: 'text' as const, text: 'APPDATA environment variable not set. Cannot find logs directory.' }] };
        }

        try {
            const allFiles = await findFilesRecursive(logsBasePath, '.log');

            const categorizedFiles: Record<string, string[]> = {
                exthost: allFiles.filter(f => f.includes('exthost.log')),
                renderer: allFiles.filter(f => f.includes('renderer.log')),
                outputChannel: allFiles.filter(f => f.includes('output_logging') && f.includes('Roo-Code')),
            };

            const logResults: { category: string; path: string; content: string }[] = [];

            for (const category in categorizedFiles) {
                const files = categorizedFiles[category];
                if (files.length > 0) {
                    const fileStats = await Promise.all(
                        files.map(async (file) => ({
                            path: file,
                            mtime: (await fs.stat(file)).mtime,
                        }))
                    );
                    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
                    const latestFile = fileStats[0];
                    
                    logResults.push({
                        category,
                        path: latestFile.path,
                        content: await readLastLines(latestFile.path, lineCount, filter),
                    });
                }
            }

            if (logResults.length === 0) {
                return { content: [{ type: 'text' as const, text: `No relevant log files found in ${logsBasePath}.` }] };
            }

            const result = {
                searchPath: logsBasePath,
                logs: logResults,
            };

            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            const errorMessage = `Failed to read VS Code logs: ${(error as Error).stack}`;
            console.error(errorMessage);
            return { content: [{ type: 'text' as const, text: errorMessage }] };
        }
    },
};