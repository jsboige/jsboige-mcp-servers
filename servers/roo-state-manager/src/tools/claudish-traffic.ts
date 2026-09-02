/**
 * claudish_traffic — reliable reading of claudish proxy traces (#3391).
 *
 * Incident 02/09 (po-2023): manual grep over `docker logs` with a window that
 * straddled a fleet reboot read OLD traffic as CURRENT — a false "leak
 * persists" alert pushed to two machines while the traffic had stopped at
 * 13:52:23Z, 5h earlier. #2609 pattern (falling back to grep = tool failure)
 * applied to a corpus no RSM tool could reach.
 *
 * Reliability is by CONSTRUCTION, not by caller discipline:
 *   1. Histogram is mandatory and rendered up to NOW, never up to the last
 *      log line — an empty trailing bucket is the answer, not a missing one.
 *   2. Observed span + exact collection command always rendered; gap between
 *      requested window and observed span is stated (restart/rotation).
 *   3. `GAP: traffic STOPPED at <ts>` declarative line as soon as the last
 *      request is older than max(2×bucket, 30 min).
 *   4. Cron/interactive split per machine (workload/cron token in ua=).
 *   5. Zero requests ≠ failure: docker down / container absent / silent
 *      NOMINAL sidecar (correct by construction) are distinguished.
 *   6. Never throws; max_output_length bounds the output for real (#3171).
 *
 * Format contract (producer read firsthand: claudish
 * packages/cli/src/fork/middleware/request-logger.ts + response-capture.ts):
 *   - Request line (the ONLY machine-attributed line — x-claudish-machine header):
 *       [claudish] [Request] model=<m> handler=<Class> src=<ip> stream|sync
 *                  msgs=<n> max_tokens=<n>  [machine=<id>]  ua=<ua ≤80 chars>
 *   - handler=NativeHandler is the ONLY Anthropic-billed path; ComposedHandler
 *     (and any other handler class) is remapped upstream, NOT billed.
 *   - reqN is a per-process counter reset at each lifecycle banner
 *     (`Server started on port <p>`); reqN alone is never globally unique.
 *   - `[resp]` / `[ttft]` lines carry NO machine=; their label is the PARSER
 *     (anthropic/openai/gemini/ollama), not the provider — which is why this
 *     histogram is request-based, never response-based.
 */
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';

// #3391: docker logs maxBuffer. Node default is 1 MB; the hub emits 5-6k
// lines/h (~14 MB for --since 12h). 128 MB keeps --since 12h+ safe.
const DOCKER_LOGS_MAX_BUFFER = 128 * 1024 * 1024;
const DOCKER_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 20_000;
const DEFAULT_CONTAINER = 'claudish-proxy';
const DEFAULT_SINCE = '2h';

// ── Parsing ────────────────────────────────────────────────────────────────

const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)/;
const REQUEST_RE =
    /\[Request\] model=(\S+) handler=(\S+) src=(\S+) (stream|sync) msgs=(\d+) max_tokens=(\S+)(?: machine=(\S+))? ua=(.*)$/;
const BANNER_RE = /Server started on port \d+/;
const UA_WORKLOAD_RE = /workload\/([a-zA-Z0-9_-]+)/;

export interface ClaudishRequest {
    ts: number;
    tsIso: string;
    model: string;
    handler: string;
    src: string;
    mode: string;
    machine: string | null;
    ua: string;
    workload: string; // 'cron' | 'interactive' | other workload token
}

export interface ClaudishParseResult {
    requests: ClaudishRequest[];
    lifecycleBanners: { ts: number; tsIso: string; line: string }[];
    firstLineTs: number | null;
    lastLineTs: number | null;
    totalLines: number;
}

/** Pure parser over `docker logs --timestamps` output (one entry per line). */
export function parseClaudishLogLines(lines: string[]): ClaudishParseResult {
    const res: ClaudishParseResult = {
        requests: [],
        lifecycleBanners: [],
        firstLineTs: null,
        lastLineTs: null,
        totalLines: 0,
    };
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        res.totalLines++;
        const tsMatch = DOCKER_TS_RE.exec(line);
        const ts = tsMatch ? Date.parse(tsMatch[1]) : NaN;
        if (!Number.isNaN(ts)) {
            if (res.firstLineTs === null || ts < res.firstLineTs) res.firstLineTs = ts;
            if (res.lastLineTs === null || ts > res.lastLineTs) res.lastLineTs = ts;
        }
        const body = tsMatch ? line.slice(tsMatch[0].length).trim() : line;
        const banner = BANNER_RE.test(body);
        if (banner && !Number.isNaN(ts)) {
            res.lifecycleBanners.push({ ts, tsIso: toIso(ts), line: body });
        }
        const m = REQUEST_RE.exec(body);
        if (m) {
            const ua = m[8] ?? '';
            const wl = UA_WORKLOAD_RE.exec(ua);
            res.requests.push({
                ts,
                tsIso: toIso(ts),
                model: m[1],
                handler: m[2],
                src: m[3],
                mode: m[4],
                machine: m[7] ?? null,
                ua,
                workload: wl ? wl[1] : 'interactive',
            });
        }
    }
    return res;
}

function toIso(ts: number): string {
    return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Relative (`1h30m`, `45s`, `2d`) or absolute ISO `--since` → epoch ms. Null if unparseable. */
export function parseSinceToEpoch(since: string, now: number = Date.now()): number | null {
    const trimmed = since.trim();
    // Relative: sequence of <n><unit>, must consume the whole string
    if (/^\d+[smhd]([0-9]+[smhd])*$/.test(trimmed)) {
        let ms = 0;
        for (const part of trimmed.matchAll(/(\d+)([smhd])/g)) {
            const mult = part[2] === 's' ? 1000 : part[2] === 'm' ? 60_000 : part[2] === 'h' ? 3_600_000 : 86_400_000;
            ms += parseInt(part[1], 10) * mult;
        }
        return now - ms;
    }
    const abs = Date.parse(trimmed);
    return Number.isNaN(abs) ? null : abs;
}

// ── Argument validation (shell-injection guard — exec runs through a shell) ─

const SINCE_RE = /^[0-9a-zA-Z:@.\/+-]+$/; // 30m, 1h30m, ISO, @epoch
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/; // container / docker context names

export function validateClaudishArgs(args: {
    since?: unknown;
    container?: unknown;
    docker_context?: unknown;
}): string | null {
    if (args.since !== undefined && (typeof args.since !== 'string' || !SINCE_RE.test(args.since))) {
        return `Invalid 'since' (shell metacharacters rejected): ${JSON.stringify(args.since)}`;
    }
    if (args.container !== undefined && (typeof args.container !== 'string' || !NAME_RE.test(args.container))) {
        return `Invalid 'container' (shell metacharacters rejected): ${JSON.stringify(args.container)}`;
    }
    if (args.docker_context !== undefined && (typeof args.docker_context !== 'string' || !NAME_RE.test(args.docker_context as string))) {
        return `Invalid 'docker_context' (shell metacharacters rejected): ${JSON.stringify(args.docker_context)}`;
    }
    return null;
}

// ── Report rendering (pure) ────────────────────────────────────────────────

export interface RenderOptions {
    bucketMinutes: number;
    since: string;
    container: string;
    machineFilter?: string;
    command: string;
    maxOutputLength: number;
    now: number;
}

function fmtAge(ms: number): string {
    if (ms < 0) ms = 0;
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function fmtClock(ts: number): string {
    return new Date(ts).toISOString().slice(11, 19) + 'Z'; // HH:MM:SSZ
}

/**
 * Builds the full text report. Invariants (see file header): histogram up to
 * `now`, span + collection mode always rendered, GAP declarative line,
 * nominal-silence distinguished from failure, output hard-bounded.
 */
export function renderTrafficReport(parse: ClaudishParseResult, opts: RenderOptions): string {
    const { bucketMinutes, now, maxOutputLength } = opts;
    const bucketMs = Math.max(1, bucketMinutes) * 60_000;
    const windowStart = parseSinceToEpoch(opts.since, now);
    const gapThresholdMs = Math.max(2 * bucketMs, 30 * 60_000);

    let requests = parse.requests;
    if (opts.machineFilter) {
        requests = requests.filter(r => r.machine === opts.machineFilter);
    }

    const native = requests.filter(r => r.handler === 'NativeHandler').length;
    const remapped = requests.length - native;

    // Per-machine aggregate
    const byMachine = new Map<string, { total: number; native: number; cron: number; interactive: number; lastTs: number }>();
    for (const r of requests) {
        const key = r.machine ?? '(unattributed)';
        let e = byMachine.get(key);
        if (!e) { e = { total: 0, native: 0, cron: 0, interactive: 0, lastTs: 0 }; byMachine.set(key, e); }
        e.total++;
        if (r.handler === 'NativeHandler') e.native++;
        if (r.workload === 'cron') e.cron++; else e.interactive++;
        if (r.ts > e.lastTs) e.lastTs = r.ts;
    }

    const sections: string[] = [];
    sections.push(`claudish traffic — container=${opts.container}${opts.machineFilter ? ` (machine filter: ${opts.machineFilter})` : ''}`);
    sections.push(`Collection: ${opts.command}`);
    sections.push(`Requested window: --since ${opts.since}${windowStart !== null ? ` (from ${toIso(windowStart)} to now ${toIso(now)})` : ''}`);
    sections.push(
        parse.totalLines > 0
            ? `Observed log span: ${toIso(parse.firstLineTs ?? 0)} → ${toIso(parse.lastLineTs ?? 0)} (${parse.totalLines} lines, ${parse.lifecycleBanners.length} process lifecycle banner(s))`
            : `Observed log span: EMPTY — container produced no output in the window`
    );

    // Requested-vs-observed gap (invariant 2): rotation/restart ate the head of the window
    if (windowStart !== null && parse.firstLineTs !== null && parse.firstLineTs - windowStart > 120_000) {
        sections.push(
            `⚠ Requested ${opts.since} but oldest log line is ${toIso(parse.firstLineTs)} — ${fmtAge(parse.firstLineTs - windowStart)} missing at the head (container restarted/created, or rotation). Pre-head traffic is UNKNOWABLE from this corpus.`
        );
    }
    if (parse.lifecycleBanners.length > 0) {
        const times = parse.lifecycleBanners.slice(-5).map(b => b.tsIso);
        sections.push(`reqN resets at each banner — process restarted at: ${times.join(', ')}${parse.lifecycleBanners.length > 5 ? ' (+older)' : ''}`);
    }

    // Verdict (invariant 3) — the incident question answered without a second call
    const lastReq = requests.length > 0 ? requests.reduce((a, r) => (r.ts > a.ts ? r : a)) : null;
    if (lastReq) {
        const age = now - lastReq.ts;
        if (age > gapThresholdMs) {
            sections.push(`GAP: traffic STOPPED at ${lastReq.tsIso} — ${fmtAge(age)} before now. Any tail-read suggesting "still flowing" is STALE.`);
        } else {
            sections.push(`VERDICT: traffic ACTIVE — last request ${fmtAge(age)} ago (${lastReq.tsIso})`);
        }
    } else if (parse.totalLines > 0) {
        sections.push(`NOMINAL (silent): 0 requests in window on a reachable container. A silent claudish — hub or sidecar — is CORRECT BY CONSTRUCTION; silence is not a failure.`);
    } else {
        sections.push(`NOMINAL (no output): 0 log lines at all in window — idle since before the window, or freshly created. Not an error.`);
    }

    sections.push(`Requests parsed: ${requests.length} (NativeHandler ${native} = Anthropic-billed · ${remapped} remapped/not-billed)`);

    // By-machine table (invariant 4)
    const machineLines: string[] = [];
    for (const [key, e] of [...byMachine.entries()].sort((a, b) => b[1].total - a[1].total)) {
        machineLines.push(`  ${key.padEnd(24)} ${String(e.total).padStart(4)} req · native ${String(e.native).padStart(3)} · interactive ${String(e.interactive).padStart(4)} · cron ${String(e.cron).padStart(4)} · last ${e.lastTs ? fmtClock(e.lastTs) : '-'}`);
    }
    if (machineLines.length > 0) {
        sections.push(`By machine (cron = ua workload/cron; [resp] lines carry no machine=, so counts are request-based):`);
        sections.push(...machineLines);
    }

    // Histogram (invariant 1): from max(windowStart, firstLineTs) bucket → NOW, always
    const buckets = new Map<number, { total: number; native: number; cron: number }>();
    for (const r of requests) {
        const b = Math.floor(r.ts / bucketMs) * bucketMs;
        let e = buckets.get(b);
        if (!e) { e = { total: 0, native: 0, cron: 0 }; buckets.set(b, e); }
        e.total++;
        if (r.handler === 'NativeHandler') e.native++;
        if (r.workload === 'cron') e.cron++;
    }
    const histStartBase = Math.max(
        windowStart ?? (parse.firstLineTs ?? now - bucketMs),
        parse.firstLineTs ?? -Infinity
    );
    const histStart = Math.floor(histStartBase / bucketMs) * bucketMs;
    const rows: string[] = [];
    const maxCount = Math.max(1, ...[...buckets.values()].map(b => b.total));
    const scale = Math.max(1, Math.ceil(maxCount / 24));
    for (let b = histStart; b < now; b += bucketMs) {
        const e = buckets.get(b);
        const bar = '#'.repeat(Math.min(24, Math.ceil((e?.total ?? 0) / scale)));
        rows.push(
            `  ${fmtClock(b)}-${fmtClock(Math.min(b + bucketMs, now))}  ${bar.padEnd(24)} ${String(e?.total ?? 0).padStart(4)}  (native ${e?.native ?? 0} · cron ${e?.cron ?? 0})`
        );
    }
    sections.push(`Histogram (bucket=${bucketMinutes}m, 1 # ≈ ${scale} req, rendered to now ${fmtClock(now)} — empty trailing buckets are the answer):`);
    sections.push(...rows);

    return sections.join('\n');
}

/** Bounds the report for real (#3171): drop oldest histogram buckets first, then hard-truncate with an honest marker. */
export function boundOutput(text: string, maxOutputLength: number): string {
    if (text.length <= maxOutputLength) return text;
    const lines = text.split('\n');
    // Keep head (metadata/verdict) and tail (recent buckets); drop middle histogram rows first
    const histIdx = lines.findIndex(l => l.startsWith('Histogram (bucket='));
    if (histIdx >= 0) {
        for (let i = histIdx + 1; i < lines.length && text.length > maxOutputLength; i++) {
            if (lines[i].startsWith('  ') && /  \d+  \(native/.test(lines[i])) {
                lines.splice(i, 1);
                i--;
            }
        }
        text = lines.join('\n');
    }
    if (text.length <= maxOutputLength) return text;
    const marker = `\n[TRUNCATED at max_output_length=${maxOutputLength} — narrow 'since' or raise the budget for full buckets]`;
    return text.slice(0, Math.max(0, maxOutputLength - marker.length)) + marker;
}

// ── Docker exec ────────────────────────────────────────────────────────────

function execDockerLogs(command: string): Promise<{ stdout: string; stderr: string; errMsg: string | null }> {
    return new Promise(resolve => {
        exec(
            command,
            { maxBuffer: DOCKER_LOGS_MAX_BUFFER, windowsHide: true, timeout: DOCKER_EXEC_TIMEOUT_MS, encoding: 'utf8' },
            (error, stdout, stderr) => {
                resolve({ stdout: stdout ?? '', stderr: stderr ?? '', errMsg: error ? error.message || String(error) : null });
            }
        );
    });
}

function classifyDockerFailure(errMsg: string, stderr: string): string {
    const all = `${errMsg}\n${stderr}`;
    if (/Cannot connect to the Docker daemon/i.test(all)) return 'DOCKER_DAEMON_UNREACHABLE';
    if (/No such container/i.test(all)) return 'CONTAINER_NOT_FOUND';
    if (/context .* not found|no such context/i.test(all)) return 'DOCKER_CONTEXT_INVALID';
    if (/not recognized|not found.*docker|ENOENT/i.test(all)) return 'DOCKER_CLI_MISSING';
    return 'DOCKER_EXEC_ERROR';
}

// ── Tool ───────────────────────────────────────────────────────────────────

export const claudishTraffic = {
    name: 'claudish_traffic',
    description:
        'Lecture fiable des traces du proxy claudish (docker logs --timestamps) : histogramme de trafic TOUJOURS rendu jusqu\u2019à l\u2019heure courante, split cron/interactif par machine, ligne déclarative "GAP: traffic STOPPED at <ts>" quand le trafic est arrêté — répond "ce trafic persiste-t-il ?" sans second appel ni grep (#3391, #3174). handler=NativeHandler = seul chemin facturé Anthropic (ComposedHandler = remappé, non facturé). reqN est remis à zéro à chaque bannière de démarrage process. [resp]/[ttft] ne portent pas machine= — les comptages sont request-based. Zéro requête sur conteneur joignable = sidecar NOMINAL silencieux, PAS une panne. Ne throw jamais.',
    inputSchema: {
        type: 'object',
        properties: {
            bucket_minutes: { type: 'number', description: 'REQUIRED. Histogram bucket size in minutes (e.g. 5, 30). Buckets are rendered up to the current time.' },
            since: { type: 'string', description: 'docker logs --since window: "30m", "2h", "1h30m", or absolute ISO timestamp. Default "2h". Hub emits 5-6k lines/h.' },
            container: { type: 'string', description: 'Container name. Default "claudish-proxy".' },
            machine: { type: 'string', description: 'Filter to a single machine tag (x-claudish-machine header value).' },
            docker_context: { type: 'string', description: 'EXPERIMENTAL (#3391, not yet fleet-validated): docker --context to query a remote hub from another machine.' },
            max_output_length: { type: 'number', description: 'Hard bound on rendered output characters (default 20000).' },
        },
        required: ['bucket_minutes'],
    },
    async handler(args: {
        bucket_minutes?: number;
        since?: string;
        container?: string;
        machine?: string;
        docker_context?: string;
        max_output_length?: number;
    }): Promise<CallToolResult> {
        try {
            const invalid = validateClaudishArgs(args);
            if (invalid) {
                return { content: [{ type: 'text' as const, text: `claudish_traffic: ${invalid}` }] };
            }
            const bucketMinutes = args.bucket_minutes ?? 30;
            if (!Number.isFinite(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 24 * 60) {
                return { content: [{ type: 'text' as const, text: `claudish_traffic: bucket_minutes must be an integer of minutes in [1, 1440], got ${args.bucket_minutes}` }] };
            }
            const since = args.since ?? DEFAULT_SINCE;
            const container = args.container ?? DEFAULT_CONTAINER;
            const maxOutputLength = Math.max(500, args.max_output_length ?? DEFAULT_MAX_OUTPUT_LENGTH);
            const contextArg = args.docker_context ? `--context ${args.docker_context} ` : '';
            const command = `docker ${contextArg}logs --timestamps --since ${since} ${container}`;

            const { stdout, stderr, errMsg } = await execDockerLogs(command);
            if (errMsg && stdout.trim() === '') {
                const kind = classifyDockerFailure(errMsg, stderr);
                const detail = (stderr || errMsg).split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
                return {
                    content: [{
                        type: 'text' as const,
                        text: `claudish_traffic: collection FAILED (${kind}) — zero-request states are distinguished from this:\nCommand: ${command}\n${detail}\nNote: ${kind === 'DOCKER_CLI_MISSING' ? 'docker CLI not available here — use docker_context to target the hub remotely (experimental).' : 'This is an infrastructure failure, NOT a silent-but-nominal sidecar.'}`,
                    }],
                };
            }

            const parse = parseClaudishLogLines(stdout.split('\n'));
            const report = boundOutput(
                renderTrafficReport(parse, {
                    bucketMinutes,
                    since,
                    container,
                    machineFilter: args.machine,
                    command,
                    maxOutputLength,
                    now: Date.now(),
                }),
                maxOutputLength
            );
            return { content: [{ type: 'text' as const, text: report }] };
        } catch (error) {
            // Invariant 6: never throw
            return { content: [{ type: 'text' as const, text: `claudish_traffic: unexpected failure (no throw by contract): ${(error as Error).message}` }] };
        }
    },
};
