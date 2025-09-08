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
           const debugLog: string[] = [`[DEBUG] Smart Log Search starting in: ${rootLogsPath}`];
   
           if (!process.env.APPDATA) {
               return { content: [{ type: 'text' as const, text: 'APPDATA environment variable not set. Cannot find logs directory.' }] };
           }
   
           try {
               const sessionDirs = await fs.readdir(rootLogsPath, { withFileTypes: true });
               let latestRooLog = { path: '', mtime: new Date(0) };
               
               debugLog.push(`[DEBUG] Found ${sessionDirs.length} total entries. Filtering for session directories...`);
   
               for (const sessionDir of sessionDirs) {
                   if (sessionDir.isDirectory() && /^\d{8}T\d{6}$/.test(sessionDir.name)) {
                       const sessionPath = path.join(rootLogsPath, sessionDir.name);
                       //debugLog.push(`[DEBUG] Scanning session: ${sessionPath}`);
                       const windowDirs = await fs.readdir(sessionPath, { withFileTypes: true }).catch(() => []);
   
                       for (const windowDir of windowDirs) {
                           if (windowDir.isDirectory() && windowDir.name.startsWith('window')) {
                               const exthostPath = path.join(sessionPath, windowDir.name, 'exthost');
                               const outputDirs = await fs.readdir(exthostPath, { withFileTypes: true }).catch(() => []);
   
                               for (const outputDir of outputDirs) {
                                   if (outputDir.isDirectory() && outputDir.name.startsWith('output_logging_')) {
                                       const rooLogPath = path.join(exthostPath, outputDir.name, '1-Roo-Code.log');
                                       try {
                                           const stats = await fs.stat(rooLogPath);
                                           if (stats.mtime > latestRooLog.mtime) {
                                               latestRooLog = { path: rooLogPath, mtime: stats.mtime };
                                               debugLog.push(`[DEBUG] Found newer Roo log: ${rooLogPath} (Modified: ${stats.mtime.toISOString()})`);
                                           }
                                       } catch (e) {
                                           // File doesn't exist, ignore
                                       }
                                   }
                               }
                           }
                       }
                   }
               }
   
               if (!latestRooLog.path) {
                   debugLog.push('[DEBUG] No Roo-Code.log file found across all session directories.');
                   return { content: [{ type: 'text' as const, text: `No Roo-Code.log found.\n\n${debugLog.join('\n')}` }] };
               }
   
               debugLog.push(`[DEBUG] Final selection for latest log: ${latestRooLog.path}`);
               const logContent = await readLastLines(latestRooLog.path, lineCount, filter);
               const resultText = `--- LOG: Roo-Code (Latest) ---\nPath: ${latestRooLog.path}\n\n${logContent}`;
               
               // Append debug log if filter is not set, to aid in debugging the tool itself
               const finalResult = filter ? resultText : `${resultText}\n\n--- DEBUG LOG ---\n${debugLog.join('\n')}`;
   
               return { content: [{ type: 'text' as const, text: finalResult }] };
   
           } catch (error) {
               const errorMessage = `Failed to read VS Code logs: ${(error as Error).stack}\n\nDEBUG LOG:\n${debugLog.join('\n')}`;
               console.error(errorMessage);
               return { content: [{ type: 'text' as const, text: errorMessage }] };
           }
    },
};