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
            maxSessions: { type: 'number', description: 'Maximum number of recent sessions to search. Default: 1, use 3-5 for MCP startup errors.', default: 1 },
        },
    },
    async handler(args: { lines?: number; filter?: string; maxSessions?: number }): Promise<CallToolResult> {
        const lineCount = args.lines || 100;
        const { filter } = args;
        const maxSessions = args.maxSessions || 1;
        const rootLogsPath = path.join(process.env.APPDATA || '', 'Code', 'logs');
        const debugLog: string[] = [`[DEBUG] Smart Log Search starting in: ${rootLogsPath}`];

        if (!process.env.APPDATA) {
            return { content: [{ type: 'text' as const, text: 'APPDATA environment variable not set. Cannot find logs directory.' }] };
        }

        try {
            const sessionDirs = (await fs.readdir(rootLogsPath, { withFileTypes: true }) || [])
                .filter(d => d.isDirectory() && /^\d{8}T\d{6}$/.test(d.name))
                .sort((a, b) => b.name.localeCompare(a.name)); // Sort descending to get latest first

            debugLog.push(`[DEBUG] Found ${sessionDirs.length} session directories.`);

            let allLogsContent: { title: string; path: string; content: string }[] = [];
            let foundLogs = false;
            let sessionsProcessed = 0;

            // Find the most recent sessions that have window logs (up to maxSessions)
            for (const sessionDir of sessionDirs) {
                if (sessionsProcessed >= maxSessions) break;
                const sessionPath = path.join(rootLogsPath, sessionDir.name);
                const windowDirs = (await fs.readdir(sessionPath, { withFileTypes: true }).catch(() => []) || [])
                    .filter(d => d.isDirectory() && d.name.startsWith('window'))
                    .sort((a, b) => b.name.localeCompare(a.name));

                if (windowDirs.length > 0) {
                    const latestWindowPath = path.join(sessionPath, windowDirs[0].name); // Most recent window in the session
                    debugLog.push(`[DEBUG] Processing session ${sessionsProcessed + 1}/${maxSessions}: ${latestWindowPath}`);
                    sessionsProcessed++;

                    const logTargets = [
                        { name: 'renderer', file: 'renderer.log' },
                        { name: 'exthost', file: 'exthost.log' },
                        { name: 'Main', file: 'main.log' }
                    ];

                    // Standard Logs
                    for (const target of logTargets) {
                        const logPath = path.join(latestWindowPath, target.file);
                        try {
                            await fs.access(logPath); // Check if file exists
                            const content = await readLastLines(logPath, lineCount, filter);
                            allLogsContent.push({ title: target.name, path: logPath, content });
                            foundLogs = true;
                        } catch (e) { /* File doesn't exist, ignore */ }
                    }

                    // Roo-Code Output Log (special search)
                    const exthostPath = path.join(latestWindowPath, 'exthost');

                    // Also read nested exthost/exthost.log (tests expect this)
                    try {
                        const nestedExthostLog = path.join(exthostPath, 'exthost.log');
                        await fs.access(nestedExthostLog);
                        const nestedContent = await readLastLines(nestedExthostLog, lineCount, filter);
                        allLogsContent.push({ title: 'exthost', path: nestedExthostLog, content: nestedContent });
                        foundLogs = true;
                    } catch (e) { /* ignore if not present */ }

                    const outputDirs = (await fs.readdir(exthostPath, { withFileTypes: true }).catch(() => []) || [])
                        .filter(d => d.isDirectory() && d.name.startsWith('output_logging_'));

                    let latestRooLog = { path: '', mtime: new Date(0) };
                    for (const outputDir of outputDirs) {
                        const logFilesPath = path.join(exthostPath, outputDir.name);
                        const logFiles = await fs.readdir(logFilesPath, { withFileTypes: true }).catch(() => []) || [];
                        for (const logFile of logFiles) {
                            if (logFile.isFile() && /\d+-Roo-Code\.log$/.test(logFile.name)) {
                                const rooLogPath = path.join(logFilesPath, logFile.name);
                                const stats = await fs.stat(rooLogPath);

                                if (stats.mtime > latestRooLog.mtime) {
                                    latestRooLog = { path: rooLogPath, mtime: stats.mtime };
                                }
                            }
                        }
                    }

                    if (latestRooLog.path) {
                        const content = await readLastLines(latestRooLog.path, lineCount, filter);
                        allLogsContent.push({ title: 'Roo-Code Output', path: latestRooLog.path, content });
                        foundLogs = true;
                    }
                    
                    // Continue to next session (removed break for multi-session search)
                }
            }
            
            if (sessionDirs.length === 0) {
                 return { content: [{ type: 'text' as const, text: 'No session log directory found' }] };
            }
            if (!foundLogs) {
                 return { content: [{ type: 'text' as const, text: `No relevant VS Code logs found.\n\n${debugLog.join('\n')}` }] };
            }

            let resultText = allLogsContent.map(log =>
                `--- LOG: ${log.title} ---\nPath: ${log.path}\n\n${log.content}`
            ).join('\n\n');

            // Append debug log if filter is not set
            const finalResult = filter ? resultText : `${resultText}\n\n--- DEBUG LOG ---\n${debugLog.join('\n')}`;

            return { content: [{ type: 'text' as const, text: finalResult }] };

        } catch (error) {
            // 🎯 CORRECTION SDDD: Gestion robuste des erreurs de filtrage
            // Si filter est undefined, ne pas essayer de l'utiliser dans le message d'erreur
            const errorMessage = `Failed to read VS Code logs: ${(error as Error).stack}\n\nDEBUG LOG:\n${debugLog.join('\n')}`;
            console.error(errorMessage);
            return { content: [{ type: 'text' as const, text: errorMessage }] };
        }
    },
};