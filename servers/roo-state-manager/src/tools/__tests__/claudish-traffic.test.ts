/**
 * Tests for claudish-traffic.ts (#3391).
 *
 * The log-format fixtures mirror the producer read firsthand in claudish:
 * packages/cli/src/fork/middleware/request-logger.ts (request line, banner)
 * and response-capture.ts ([resp] marker). If claudish drifts, these fixtures
 * break here too — that is the point of pinning the contract on BOTH sides.
 *
 * Reliability invariants under test (issue #3391):
 *   1. Histogram rendered up to NOW (not up to last log line).
 *   3. Declarative `GAP: traffic STOPPED at <ts>` — the 02/09 incident replay.
 *   4. cron/interactive split per machine (workload/cron in ua=).
 *   5. Zero requests ≠ failure (nominal silence distinguished).
 *   6. Never throws; max_output_length bounds for real.
 *   7. Partial collection declared — GAP confidence reduced explicitly (review F1 #1080).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The handler under test imports 'child_process'; mock it BEFORE importing the module.
vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

import {
    claudishTraffic,
    parseClaudishLogLines,
    parseSinceToEpoch,
    renderTrafficReport,
    boundOutput,
    validateClaudishArgs,
} from '../claudish-traffic.js';
import { exec } from 'child_process';

// ── Fixtures (producer format, docker --timestamps prefix) ─────────────────

const REQ = (ts: string, model: string, handler: string, machine: string | null, ua: string) =>
    `${ts} [claudish] [Request] model=${model} handler=${handler} src=192.168.0.44 stream msgs=12 max_tokens=32000${machine ? ` machine=${machine}` : ''} ua=${ua}`;

const UA_CLI = 'claude-cli/2.1.51 (external, cli)';
const UA_CRON = 'claude-cli/2.1.51 (external, cli) workload/cron';

const RESP = (ts: string) =>
    `${ts}   [resp] anthropic model=glm-5.2 reqN=42 events~=38 bytes=12345 closed=true stop=end_turn 5432ms -> /captures/resp-123-0042.sse`;

const TTFT = (ts: string) =>
    `${ts}   [ttft] anthropic model=glm-5.2 reqN=42 headers=210ms firstEvent=340ms total=550ms`;

const BANNER = (ts: string) => `${ts} [Proxy] Server started on port 3000`;

// Incident replay corpus: fleet reboot straddled the window; traffic from two
// machines until 13:52:23Z, then silence.
const INCIDENT_LINES = [
    BANNER('2026-09-02T08:00:00.000000000Z'),
    REQ('2026-09-02T13:40:00.000000000Z', 'claude-opus-5', 'NativeHandler', 'myia-po-2024', UA_CLI),
    REQ('2026-09-02T13:45:10.000000000Z', 'glm-5.2', 'ComposedHandler', 'myia-po-2024', UA_CRON),
    REQ('2026-09-02T13:52:23.000000000Z', 'claude-opus-5', 'NativeHandler', 'myia-po-2023', UA_CLI),
    RESP('2026-09-02T13:52:30.000000000Z'),
    TTFT('2026-09-02T13:52:24.000000000Z'),
];

const NOW = Date.parse('2026-09-02T19:00:00.000Z'); // 5h07m after the last request

function renderIncident() {
    const parse = parseClaudishLogLines(INCIDENT_LINES);
    return renderTrafficReport(parse, {
        bucketMinutes: 30,
        since: '12h',
        container: 'claudish-proxy',
        command: 'docker logs --timestamps --since 12h claudish-proxy',
        maxOutputLength: 20000,
        now: NOW,
    });
}

// ── Parser ─────────────────────────────────────────────────────────────────

describe('parseClaudishLogLines', () => {
    it('parses requests: machine tag, handler class, cron workload from ua=', () => {
        const parse = parseClaudishLogLines(INCIDENT_LINES);
        expect(parse.requests).toHaveLength(3);
        const [r1, r2, r3] = parse.requests;
        expect(r1.machine).toBe('myia-po-2024');
        expect(r1.handler).toBe('NativeHandler');
        expect(r1.workload).toBe('interactive');
        expect(r2.workload).toBe('cron');
        expect(r2.handler).toBe('ComposedHandler');
        expect(r3.machine).toBe('myia-po-2023');
    });

    it('keeps requests without machine= as unattributed (machine=null)', () => {
        const parse = parseClaudishLogLines([REQ('2026-09-02T10:00:00.000000000Z', 'glm-5.2', 'ComposedHandler', null, UA_CLI)]);
        expect(parse.requests).toHaveLength(1);
        expect(parse.requests[0].machine).toBeNull();
    });

    it('does NOT count [resp]/[ttft] markers as requests (no machine= on them)', () => {
        const parse = parseClaudishLogLines([RESP('2026-09-02T10:00:00.000000000Z'), TTFT('2026-09-02T10:00:01.000000000Z')]);
        expect(parse.requests).toHaveLength(0);
    });

    it('detects process lifecycle banners (reqN reset boundaries)', () => {
        const parse = parseClaudishLogLines(INCIDENT_LINES);
        expect(parse.lifecycleBanners).toHaveLength(1);
        expect(parse.lifecycleBanners[0].tsIso).toBe('2026-09-02T08:00:00Z');
    });

    it('computes the observed span from docker timestamps', () => {
        const parse = parseClaudishLogLines(INCIDENT_LINES);
        expect(parse.firstLineTs).toBe(Date.parse('2026-09-02T08:00:00.000Z'));
        expect(parse.lastLineTs).toBe(Date.parse('2026-09-02T13:52:30.000Z'));
        expect(parse.totalLines).toBe(6);
    });
});

// ── since parsing ──────────────────────────────────────────────────────────

describe('parseSinceToEpoch', () => {
    it('parses compound relative windows', () => {
        const before = Date.now();
        const got = parseSinceToEpoch('1h30m')!;
        expect(got).toBeGreaterThan(before - 90 * 60_000 - 50);
        expect(got).toBeLessThan(before - 90 * 60_000 + 50);
    });
    it('parses absolute ISO timestamps', () => {
        expect(parseSinceToEpoch('2026-09-02T13:52:23Z')).toBe(Date.parse('2026-09-02T13:52:23Z'));
    });
    it('returns null on garbage (no false window)', () => {
        expect(parseSinceToEpoch('forever')).toBeNull();
    });
});

// ── Report invariants ──────────────────────────────────────────────────────

describe('renderTrafficReport — incident 02/09 replay', () => {
    const report = renderIncident();

    it('answers the incident question declaratively: GAP with the stop timestamp', () => {
        expect(report).toContain('GAP: traffic STOPPED at 2026-09-02T13:52:23Z');
    });

    it('renders the histogram up to NOW, not up to the last log line', () => {
        // A bucket covering `now` (19:00Z) MUST exist even though the last log line is 13:52Z
        expect(report).toMatch(/18:3\d:00Z-19:00:00Z/);
        expect(report).toContain('rendered to now 19:00:00Z');
    });

    it('always renders the collection mode and the observed span', () => {
        expect(report).toContain('Collection: docker logs --timestamps --since 12h claudish-proxy');
        expect(report).toContain('Observed log span: 2026-09-02T08:00:00Z → 2026-09-02T13:52:30Z');
    });

    it('states the requested-vs-observed head gap (reboot/rotation awareness)', () => {
        expect(report).toMatch(/Requested 12h but oldest log line/);
    });

    it('renders the reqN reset banner (window straddling a reboot)', () => {
        expect(report).toMatch(/process restarted at: 2026-09-02T08:00:00Z/);
    });

    it('splits native (billed) vs remapped, and cron vs interactive per machine', () => {
        expect(report).toContain('NativeHandler 2 = Anthropic-billed · 1 remapped/not-billed');
        expect(report).toMatch(/myia-po-2024\s+2 req · native\s+1 · interactive\s+1 · cron\s+1/);
        expect(report).toMatch(/myia-po-2023\s+1 req · native\s+1 · interactive\s+1 · cron\s+0/);
    });
});

describe('renderTrafficReport — states', () => {
    const baseOpts = {
        bucketMinutes: 30,
        since: '2h',
        container: 'claudish-proxy',
        command: 'docker logs --timestamps --since 2h claudish-proxy',
        maxOutputLength: 20000,
    };

    it('ACTIVE verdict when the last request is fresh (< max(2×bucket, 30min))', () => {
        const now = Date.parse('2026-09-02T19:00:00.000Z');
        const parse = parseClaudishLogLines([
            REQ('2026-09-02T18:58:00.000000000Z', 'glm-5.2', 'ComposedHandler', 'myia-po-2024', UA_CLI),
        ]);
        const report = renderTrafficReport(parse, { ...baseOpts, now });
        expect(report).toContain('VERDICT: traffic ACTIVE');
        expect(report).not.toContain('GAP: traffic STOPPED');
    });

    it('zero requests on a reachable container = NOMINAL silent, not an error', () => {
        const now = Date.parse('2026-09-02T19:00:00.000Z');
        const parse = parseClaudishLogLines([RESP('2026-09-02T18:00:00.000000000Z'), BANNER('2026-09-02T17:00:00.000000000Z')]);
        const report = renderTrafficReport(parse, { ...baseOpts, now });
        expect(report).toContain('NOMINAL (silent)');
        expect(report).toContain('CORRECT BY CONSTRUCTION');
    });

    it('empty corpus = NOMINAL no-output, still not an error', () => {
        const now = Date.parse('2026-09-02T19:00:00.000Z');
        const report = renderTrafficReport(parseClaudishLogLines([]), { ...baseOpts, now });
        expect(report).toContain('NOMINAL (no output)');
    });

    it('machine filter removes other machines from every section', () => {
        const now = Date.parse('2026-09-02T19:00:00.000Z');
        const parse = parseClaudishLogLines(INCIDENT_LINES);
        const report = renderTrafficReport(parse, { ...baseOpts, since: '12h', machineFilter: 'myia-po-2023', now });
        expect(report).toContain('machine filter: myia-po-2023');
        expect(report).not.toContain('myia-po-2024 ');
        expect(report).toContain('GAP: traffic STOPPED at 2026-09-02T13:52:23Z');
    });
});

// ── Output bounding (#3171) ────────────────────────────────────────────────

describe('boundOutput', () => {
    it('bounds over-budget output for real, with an honest marker', () => {
        const big = 'x'.repeat(10_000);
        const out = boundOutput(big, 500);
        expect(out.length).toBeLessThanOrEqual(500);
        expect(out).toContain('[TRUNCATED at max_output_length=500');
    });
    it('passes through under-budget output untouched', () => {
        expect(boundOutput('short', 500)).toBe('short');
    });

    // Review F2 (#1080): the budget is re-evaluated as rows drop. The frozen
    // `text.length` condition spliced EVERY histogram row on a marginal overflow.
    const f2Row = (i: number) =>
        `  2026-09-02T1${i}:00:00Z-1${i}:30:00Z  ${'#'.repeat(24)} ${String(i).padStart(4)}  (native ${i} · cron 0)`;
    it('drops only the oldest rows needed — recent buckets survive a marginal overflow', () => {
        const head = 'header line\nCollection: docker logs …\nHistogram (bucket=30m, rendered to now):';
        const text = [head, ...Array.from({ length: 50 }, (_, i) => f2Row(i))].join('\n');
        const budget = text.length - 80; // ~1 row of overflow
        const out = boundOutput(text, budget);
        expect(out.length).toBeLessThanOrEqual(budget);
        expect(out).toContain(f2Row(49)); // newest kept
        expect(out).toContain(f2Row(48));
        expect(out).not.toContain(f2Row(0)); // oldest dropped
        const remainingRows = out.match(/  \d+  \(native/g)?.length ?? 0;
        expect(remainingRows).toBeGreaterThan(40); // the bulk survives — not ALL dropped
    });
    it('still hard-truncates with the honest marker when rows alone cannot fit', () => {
        // Incompressible head: even dropping ALL rows cannot reach the budget
        const text = ['H'.repeat(400), 'Histogram (bucket=30m):', ...Array.from({ length: 5 }, (_, i) => f2Row(i))].join('\n');
        const out = boundOutput(text, 300);
        expect(out.length).toBeLessThanOrEqual(300);
        expect(out).toContain('[TRUNCATED at max_output_length=300');
    });
});

// ── Collection warning (review F1, #1080) ──────────────────────────────────

describe('renderTrafficReport — collection INCOMPLETE', () => {
    it('declares partial collection next to the command line, report still renders', () => {
        const parse = parseClaudishLogLines(INCIDENT_LINES);
        const report = renderTrafficReport(parse, {
            bucketMinutes: 30,
            since: '12h',
            container: 'claudish-proxy',
            command: 'docker logs --timestamps --since 12h claudish-proxy',
            maxOutputLength: 20000,
            now: NOW,
            collectionWarning: '⚠ collection INCOMPLETE (exec: Command timed out after 60000 milliseconds) — tail of the window may be missing; GAP verdict confidence reduced.',
        });
        expect(report).toContain('⚠ collection INCOMPLETE');
        expect(report).toContain('GAP verdict confidence reduced');
        // Partial data is still data — the incident verdict renders, now with reduced confidence
        expect(report).toContain('GAP: traffic STOPPED at 2026-09-02T13:52:23Z');
    });
    it('no warning line when collection was clean', () => {
        const report = renderIncident();
        expect(report).not.toContain('collection INCOMPLETE');
    });
});

// ── Argument validation (shell-injection guard) ────────────────────────────

describe('validateClaudishArgs', () => {
    it('rejects shell metacharacters in container / since / docker_context', () => {
        expect(validateClaudishArgs({ container: 'foo; rm -rf /' })).toContain('Invalid');
        expect(validateClaudishArgs({ since: '2h && curl evil' })).toContain('Invalid');
        expect(validateClaudishArgs({ docker_context: 'ctx`id`' })).toContain('Invalid');
    });
    it('accepts legitimate values', () => {
        expect(validateClaudishArgs({ since: '1h30m', container: 'claudish-proxy', docker_context: 'hub-po-2023' })).toBeNull();
    });
});

// ── Handler (exec mocked — never throws, distinguishes failures) ───────────

describe('claudishTraffic.handler', () => {
    beforeEach(() => {
        vi.mocked(exec).mockReset();
    });

    it('classifies docker daemon down as an infrastructure failure (≠ nominal silence)', async () => {
        vi.mocked(exec).mockImplementation(((_cmd: string, _opts: any, cb: any) => {
            cb(new Error('command failed'), '', 'Error response from daemon: Cannot connect to the Docker daemon');
            return {} as any;
        }) as any);
        const res = await claudishTraffic.handler({ bucket_minutes: 30 });
        const text = (res.content as any)[0].text as string;
        expect(text).toContain('DOCKER_DAEMON_UNREACHABLE');
        expect(text).toContain('infrastructure failure, NOT a silent-but-nominal sidecar');
    });

    it('renders the incident GAP report from docker logs stdout', async () => {
        vi.mocked(exec).mockImplementation(((_cmd: string, _opts: any, cb: any) => {
            cb(null, INCIDENT_LINES.join('\n'), '');
            return {} as any;
        }) as any);
        const res = await claudishTraffic.handler({ bucket_minutes: 30, since: '12h' });
        const text = (res.content as any)[0].text as string;
        expect(text).toContain('GAP: traffic STOPPED at 2026-09-02T13:52:23Z');
        expect(text).toContain('Collection: docker logs --timestamps --since 12h claudish-proxy');
    });

    it('rejects an injected container name without executing anything', async () => {
        const res = await claudishTraffic.handler({ bucket_minutes: 30, container: 'x; rm -rf /' });
        const text = (res.content as any)[0].text as string;
        expect(text).toContain('Invalid');
        expect(exec).not.toHaveBeenCalled();
    });

    it('flags collection INCOMPLETE when exec fails with partial stdout (review F1, #1080)', async () => {
        // 60s timeout / 128MB maxBuffer kill exec AFTER stdout was emitted — the corpus
        // tail is missing and a GAP verdict on it is unreliable. Before the fix, this
        // rendered as a complete report (the incident failure mode, inverted).
        vi.mocked(exec).mockImplementation(((_cmd: string, _opts: any, cb: any) => {
            cb(new Error('maxBuffer length exceeded'), INCIDENT_LINES.join('\n'), '');
            return {} as any;
        }) as any);
        const res = await claudishTraffic.handler({ bucket_minutes: 30, since: '12h' });
        const text = (res.content as any)[0].text as string;
        expect(text).toContain('⚠ collection INCOMPLETE (exec: maxBuffer length exceeded)');
        expect(text).toContain('GAP verdict confidence reduced');
        expect(text).toContain('GAP: traffic STOPPED at 2026-09-02T13:52:23Z');
    });

    it('rejects non-integer bucket_minutes — the message promise is now enforced', async () => {
        const res = await claudishTraffic.handler({ bucket_minutes: 2.5 });
        const text = (res.content as any)[0].text as string;
        expect(text).toContain('bucket_minutes must be an integer');
        expect(exec).not.toHaveBeenCalled();
    });

    it('never throws — unexpected exec crash is returned as text', async () => {
        vi.mocked(exec).mockImplementation((() => {
            throw new Error('boom');
        }) as any);
        const res = await claudishTraffic.handler({ bucket_minutes: 30 });
        const text = (res.content as any)[0].text as string;
        expect(text).toContain('unexpected failure');
    });
});
