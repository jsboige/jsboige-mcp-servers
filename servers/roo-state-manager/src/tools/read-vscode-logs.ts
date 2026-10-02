import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import { Dirent } from 'fs';
import * as path from 'path';
import { sanitizeInt } from '../utils/int-validator.js';

// #3990 — the four robustness defects of this tool, and the guards below.
// 1. ReDoS: the user `filter` was compiled and applied to every line with no
//    bound — `(a+)+$` against a multi-MB log parks the Node thread.
// 2. OOM: `fs.readFile` loaded the whole file regardless of `lines: 10`, so a
//    multi-GB renderer.log crashed the process.
// 4. Swallowed errors: a failing readdir and an invalid filter were silent, and
//    the caller read "No relevant VS Code logs found" — a false negative.
// (Defect 3, unvalidated `lines`/`maxSessions`, was closed by #4002 above.)

/** A filter longer than this is refused outright (#3990 defect 1). */
const MAX_FILTER_LENGTH = 200;
/** Files up to this size are read whole; below it the tail walk costs more than it saves (#3990 defect 2). */
const INLINE_READ_MAX_BYTES = 5 * 1024 * 1024;
/** Above INLINE_READ_MAX_BYTES, only these trailing bytes are ever held in memory (#3990 defect 2). */
const TAIL_WINDOW_BYTES = 2 * 1024 * 1024;

interface LineMatcher {
    matches(line: string): boolean;
}

/**
 * Conservative catastrophic-backtracking detector (#3990 defect 1).
 *
 * Flags a quantified group that itself contains a quantifier — `(a+)+`,
 * `(a*)*`, `([a-z]+)*` — the classic exponential shapes. It is a heuristic,
 * not a proof: `(a|a)+` slips through. That is why it is combined with the
 * MAX_FILTER_LENGTH bound and the bounded read window, both of which cap the
 * input a bad pattern gets to chew on. On a hit the caller falls back to a
 * literal substring match and SAYS SO in the response — never silently.
 */
function hasNestedQuantifier(pattern: string): boolean {
    // One flag per open group: "a quantifier was seen inside me".
    const containsQuantifier: boolean[] = [];
    const quantifierAt = (s: string): number => {
        const m = /^\{\d+(,\d*)?\}/.exec(s);
        return m ? m[0].length : 0;
    };

    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\') { i++; continue; } // escaped literal — never a metacharacter
        if (c === '[') {
            i++; // character class: `[` is literal inside, `\]` is escaped
            while (i < pattern.length && pattern[i] !== ']') {
                if (pattern[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (c === '(') {
            containsQuantifier.push(false);
            // A group prefix (?: ?= ?! ?<= ?<! ?<name>) is syntax, not a quantifier.
            if (pattern[i + 1] === '?') {
                if (pattern[i + 2] === '<') {
                    const close = /[=!]/.test(pattern[i + 3] ?? '') ? i + 3 : pattern.indexOf('>', i + 2);
                    i = close === -1 ? i + 1 : close;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if (c === ')') {
            const inner = containsQuantifier.pop() ?? false;
            const next = pattern[i + 1];
            const groupQuantified = next === '*' || next === '+' ||
                (next === '{' && quantifierAt(pattern.slice(i + 1)) > 0);
            if (inner && groupQuantified) return true;
            // A quantified group is itself a quantifier for its parent.
            if (containsQuantifier.length && (inner || groupQuantified)) {
                containsQuantifier[containsQuantifier.length - 1] = true;
            }
            continue;
        }
        if (c === '*' || c === '+' || c === '?' || c === '{') {
            if (containsQuantifier.length) containsQuantifier[containsQuantifier.length - 1] = true;
        }
    }
    return false;
}

/**
 * Build the line matcher ONCE per call (#3990). Previously the regex was
 * recompiled for every log file, and an invalid one fell back to substring
 * matching in silence — the caller believed its pattern had been applied.
 */
function buildMatcher(filter: string, warnings: string[]): LineMatcher {
    const substring = (line: string) => line.toLowerCase().includes(filter.toLowerCase());

    if (hasNestedQuantifier(filter)) {
        warnings.push(
            `filter '${filter}' looks like a catastrophic-backtracking pattern (nested quantifier) — ` +
            'matched as a literal substring instead of a regex.'
        );
        return { matches: substring };
    }
    try {
        const regex = new RegExp(filter, 'i');
        return { matches: (line) => regex.test(line) };
    } catch {
        warnings.push(
            `filter '${filter}' is not a valid regular expression — matched as a literal substring instead.`
        );
        return { matches: substring };
    }
}

/** readdir that reports the failure instead of silently returning nothing (#3990 defect 4). */
async function readDirSafe(dir: string, warnings: string[]): Promise<Dirent[]> {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
        warnings.push(`could not list ${dir}: ${(error as Error).message}`);
        return [];
    }
}

/**
 * Read the file, bounded (#3990 defect 2).
 *
 * Up to INLINE_READ_MAX_BYTES the file is read whole — the previous behaviour,
 * and what the unit tests exercise. Above it only the trailing TAIL_WINDOW_BYTES
 * window is read through a file handle, and the windowing is announced in the
 * response so a truncated search is never mistaken for a complete one.
 * When the size cannot be determined (mocked/odd filesystem) the whole-file
 * read is kept: no bound is claimed that the instrument cannot verify.
 */
async function readTailText(filePath: string, warnings: string[]): Promise<string> {
    let size = -1;
    try {
        const stats = await fs.stat(filePath);
        if (typeof stats?.size === 'number') size = stats.size;
    } catch { /* size unknown — fall back to the whole-file read */ }

    if (size > INLINE_READ_MAX_BYTES) {
        const start = size - TAIL_WINDOW_BYTES;
        const handle = await fs.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(TAIL_WINDOW_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, TAIL_WINDOW_BYTES, start);
            let data = buffer.subarray(0, bytesRead).toString('utf-8');
            // The window opens mid-file, so its first line is usually cut in half.
            const firstBreak = data.indexOf('\n');
            if (firstBreak !== -1) data = data.slice(firstBreak + 1);
            warnings.push(
                `${filePath} is ${(size / 1048576).toFixed(1)} MB — only the last ` +
                `${(TAIL_WINDOW_BYTES / 1048576).toFixed(0)} MB were searched (#3990).`
            );
            return data;
        } finally {
            await handle.close();
        }
    }
    return await fs.readFile(filePath, 'utf-8');
}

/** Render collected warnings alongside the result — a downgraded or partial search must be visible (#3990 defect 4). */
function withWarnings(text: string, warnings: string[]): string {
    if (warnings.length === 0) return text;
    return `${text}\n\n--- WARNINGS (${warnings.length}) ---\n${warnings.join('\n')}`;
}

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
async function readLastLines(
    filePath: string,
    lineCount: number,
    matcher: LineMatcher | undefined,
    warnings: string[]
): Promise<string> {
    try {
        const data = await readTailText(filePath, warnings);
        let lines = data.split(/\r?\n/).filter(line => line.trim() !== ''); // Handles both LF and CRLF
        if (matcher) {
            lines = lines.filter(line => matcher.matches(line));
        }
        return lines.slice(-lineCount).join('\n');
    } catch (error) {
        // #3990 defect 4: a read failure used to be returned AS log content, so
        // the caller read an error string where it expected log lines. It is a
        // warning now, and the response says the file could not be read.
        warnings.push(`could not read ${filePath}: ${(error as Error).message}`);
        return '';
    }
}

export const readVscodeLogs = {
    name: 'read_vscode_logs',
    description: 'Scans the VS Code log directory to read the logs of EVERY window of each recent session: Extension Host, Renderer, and Roo-Code Output Channels. A crashed window is not necessarily the latest one.',
    inputSchema: {
        type: 'object',
        properties: {
            lines: { type: 'number', description: 'Number of lines to read from the end of each log file.', default: 100 },
            filter: { type: 'string', description: 'A keyword or regex to filter log lines.' },
            maxSessions: { type: 'number', description: 'Maximum number of recent sessions to search. Default: 1, use 3-5 for MCP startup errors.', default: 1 },
        },
    },
    async handler(args: { lines?: number; filter?: string; maxSessions?: number }): Promise<CallToolResult> {
        const safeArgs = args || {};
        // #4002 — schema bounds lines/maxSessions, runtime guard catches NaN/float
        // routed around the schema layer (slice(-NaN) used to silently return []).
        const linesCheck = sanitizeInt('lines', safeArgs.lines, { min: 1, max: 10000, fallback: 100 });
        if (!linesCheck.ok) {
            return { isError: true, content: [{ type: 'text' as const, text: `read_vscode_logs: ${linesCheck.error}` }] };
        }
        const sessionsCheck = sanitizeInt('maxSessions', safeArgs.maxSessions, { min: 1, max: 100, fallback: 1 });
        if (!sessionsCheck.ok) {
            return { isError: true, content: [{ type: 'text' as const, text: `read_vscode_logs: ${sessionsCheck.error}` }] };
        }
        const lineCount = linesCheck.value;
        const { filter } = safeArgs;
        const maxSessions = sessionsCheck.value;
        const rootLogsPath = path.join(process.env.APPDATA || '', 'Code', 'logs');
        const debugLog: string[] = [`[DEBUG] Smart Log Search starting in: ${rootLogsPath}`];

        if (!process.env.APPDATA) {
            return { content: [{ type: 'text' as const, text: 'APPDATA environment variable not set. Cannot find logs directory.' }] };
        }

        // #3990 defect 1 — the filter is the only unbounded user input that
        // reaches the regex engine. An oversized one is refused outright, named
        // like the #4002 guards above rather than silently downgraded.
        if (typeof filter === 'string' && filter.length > MAX_FILTER_LENGTH) {
            return {
                isError: true,
                content: [{
                    type: 'text' as const,
                    text: `read_vscode_logs: filter is ${filter.length} characters long, over the ${MAX_FILTER_LENGTH}-character limit — a long pattern is a catastrophic-backtracking surface against multi-MB logs. Narrow it, or use a short anchored expression.`
                }]
            };
        }

        // Collected, then rendered in the response: a partial search or a
        // downgraded matcher must never read as a clean, complete result (#3990 defect 4).
        const warnings: string[] = [];
        const matcher = filter ? buildMatcher(filter, warnings) : undefined;

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
                const windowDirs = (await readDirSafe(sessionPath, warnings))
                    .filter(d => d.isDirectory() && d.name.startsWith('window'))
                    .sort((a, b) => (parseInt(a.name.slice(6), 10) || 0) - (parseInt(b.name.slice(6), 10) || 0)); // Numeric order: window2 before window10

                if (windowDirs.length > 0) {
                    debugLog.push(`[DEBUG] Processing session ${sessionsProcessed + 1}/${maxSessions}: ${sessionPath} (${windowDirs.length} windows: ${windowDirs.map(d => d.name).join(', ')})`);
                    sessionsProcessed++;

                    // Read EVERY window of the session: for crash diagnosis the interesting
                    // window is the one that died — not the highest-numbered or latest one (#3341)
                    for (const windowDir of windowDirs) {
                        const windowPath = path.join(sessionPath, windowDir.name);

                        const logTargets = [
                            { name: 'renderer', file: 'renderer.log' },
                            { name: 'exthost', file: 'exthost.log' },
                            { name: 'Main', file: 'main.log' }
                        ];

                        // Standard Logs
                        for (const target of logTargets) {
                            const logPath = path.join(windowPath, target.file);
                            try {
                                await fs.access(logPath); // Check if file exists
                                const content = await readLastLines(logPath, lineCount, matcher, warnings);
                                allLogsContent.push({ title: `${windowDir.name}/${target.name}`, path: logPath, content });
                                foundLogs = true;
                            } catch (e) { /* File doesn't exist, ignore */ }
                        }

                        // Roo-Code Output Log (special search)
                        const exthostPath = path.join(windowPath, 'exthost');

                        // Also read nested exthost/exthost.log (tests expect this)
                        try {
                            const nestedExthostLog = path.join(exthostPath, 'exthost.log');
                            await fs.access(nestedExthostLog);
                            const nestedContent = await readLastLines(nestedExthostLog, lineCount, matcher, warnings);
                            allLogsContent.push({ title: `${windowDir.name}/exthost`, path: nestedExthostLog, content: nestedContent });
                            foundLogs = true;
                        } catch (e) { /* ignore if not present */ }

                        const outputDirs = (await readDirSafe(exthostPath, warnings))
                            .filter(d => d.isDirectory() && d.name.startsWith('output_logging_'));

                        let latestRooLog = { path: '', mtime: new Date(0) };
                        for (const outputDir of outputDirs) {
                            const logFilesPath = path.join(exthostPath, outputDir.name);
                            const logFiles = await readDirSafe(logFilesPath, warnings);
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
                            const content = await readLastLines(latestRooLog.path, lineCount, matcher, warnings);
                            allLogsContent.push({ title: `${windowDir.name}/Roo-Code Output`, path: latestRooLog.path, content });
                            foundLogs = true;
                        }
                    }

                    // Continue to next session (removed break for multi-session search)
                }
            }

            if (sessionDirs.length === 0) {
                 return { content: [{ type: 'text' as const, text: 'No session log directory found' }] };
            }
            if (!foundLogs) {
                 // #3990 defect 4 — this used to be returned even when the cause
                 // was a failed listing, so the caller read a false negative.
                 return { content: [{ type: 'text' as const, text: withWarnings(`No relevant VS Code logs found.\n\n${debugLog.join('\n')}`, warnings) }] };
            }

            let resultText = allLogsContent.map(log =>
                `--- LOG: ${log.title} ---\nPath: ${log.path}\n\n${log.content}`
            ).join('\n\n');

            // Append debug log if filter is not set
            const finalResult = filter ? resultText : `${resultText}\n\n--- DEBUG LOG ---\n${debugLog.join('\n')}`;

            return { content: [{ type: 'text' as const, text: withWarnings(finalResult, warnings) }] };

        } catch (error) {
            // 🎯 CORRECTION SDDD: Gestion robuste des erreurs de filtrage
            // Si filter est undefined, ne pas essayer de l'utiliser dans le message d'erreur
            const errorMessage = `Failed to read VS Code logs: ${(error as Error).message}\n\nDEBUG LOG:\n${debugLog.join('\n')}`;
            console.error(errorMessage);
            return { content: [{ type: 'text' as const, text: errorMessage }] };
        }
    },
};