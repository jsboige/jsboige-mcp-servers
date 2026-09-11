/**
 * End-to-end tests for #3584 — RENTENTION + RETRAIT (the two limits PR #1144
 * left open), driving the PUBLIC tool actions:
 *
 *  - Limite 2 (transit LLM): condensation sends the intercom content to the LLM
 *    provider BEFORE writeDashboardFile masks the written output. The prompt
 *    builders must only ever see masked content.
 *  - Limite 3 (écritures d'archives directes): the condensation success/fallback
 *    archives, the pre-delete copy and the wt-cleanup copy are written by direct
 *    fs.writeFile, OUTSIDE writeDashboardFile — they must mask too.
 *  - Volet retrait: the `scrub` action must retroactively mask the LIVE dashboard
 *    (file + PG mirror) for secrets published before the #1144 guard existed.
 *
 * Pre-guard on-disk state is simulated by injecting the raw secret via direct
 * fs writes AFTER seeding the dashboard through the tool — exactly the state a
 * seat inherits from messages written before #1144.
 *
 * Harness mirrors dashboard-secret-redaction.test.ts (#1144): store mocked at
 * the module boundary; the OpenAI mock is two-mode — disabled (client init
 * throws → truncation fallback) and enabled (captures every prompt, the
 * assertion surface for the LLM-transit vector).
 *
 * The whole SUCCESS path is asserted from ONE condensation (prompts, archive,
 * live rewrite, no-over-redaction) — the suite stays light: timing-marginal
 * neighbours (#2463 vicious circle, #2719 telemetry) run in parallel in CI and
 * a heavy sibling file flips them over their 15 s timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockDualWriteDashboardSync, mockReadDashboardFromPg, llm } = vi.hoisted(() => ({
    mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
    mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
    llm: {
        enabled: false,
        create: vi.fn(),
    },
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
    readDashboardFromPg: mockReadDashboardFromPg,
    dualWriteDashboardSync: mockDualWriteDashboardSync,
    dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/openai', () => ({
    getChatOpenAIClient: () => {
        if (!llm.enabled) throw new Error('No chat API key configured');
        return { chat: { completions: { create: llm.create } } };
    },
    resetChatOpenAIClient: vi.fn(),
    getLLMModelId: () => 'test-model',
    getFallbackChatOpenAIClient: () => null,
    getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

const LEAKED_KEY = '89ed6fb1' + 'a1b2c3d4'.repeat(7);
const REDACTION = '<redacted:EMBEDDINGS_API_KEY>';
const GIT_SHA = 'b'.repeat(40);

const testTmpBase = path.join(os.tmpdir(), 'dashboard-retention-test-');
const OLD_DATE = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

/**
 * Seeds 6 small filler messages via the tool (~7 KB), then pads the NEWEST
 * message via a single fs write to cross the ~46 KB preemptive threshold.
 * Seeding past 46 KB via appends would trigger condensation MID-SEED and archive
 * FILLER-0 before the secret injection lands. With CONDENSE_KEEP_MIN=4, the two
 * OLDEST messages (FILLER-0, FILLER-1) are archived and FILLER-5 (the padded
 * one, newest) always stays in the keep window.
 */
async function seedFillerDashboardOverThreshold(): Promise<string> {
    const filler = 'F'.repeat(1100);
    for (let i = 0; i < 6; i++) {
        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: `FILLER-${i} ${filler}`,
            createIfNotExists: true,
        });
        expect(r.success).toBe(true);
    }
    const file = path.join(process.env.ROOSYNC_SHARED_PATH!, 'dashboards', 'workspace-test-workspace.md');
    const content = await readFile(file, 'utf8');
    const pad = 'P'.repeat(42 * 1024);
    await writeFile(file, content.replace('FILLER-5', `FILLER-5 ${pad}`), 'utf8');
    return file;
}

/** Applies all marker→replacement substitutions in ONE fs read-modify-write,
 *  simulating pre-#1144 on-disk content (secrets injected raw). */
async function injectIntoFile(filePath: string, subs: Array<[string, string]>): Promise<void> {
    let content = await readFile(filePath, 'utf8');
    for (const [marker, replacement] of subs) {
        expect(content.indexOf(marker)).toBeGreaterThan(-1);
        content = content.replace(marker, replacement);
    }
    await writeFile(filePath, content, 'utf8');
}

/** Ages the dashboard beyond DASHBOARD_PROTECTION_DAYS (7) via frontmatter. */
async function ageBeyondProtection(filePath: string): Promise<void> {
    const content = await readFile(filePath, 'utf8');
    await writeFile(filePath, content.replace(/^(lastModified:).*$/m, `$1 ${OLD_DATE}`), 'utf8');
}

async function readArchiveFiles(): Promise<Array<{ name: string; content: string }>> {
    const dir = path.join(process.env.ROOSYNC_SHARED_PATH!, 'dashboards', 'archive');
    const files = await readdir(dir);
    const out: Array<{ name: string; content: string }> = [];
    for (const f of files) {
        out.push({ name: f, content: await readFile(path.join(dir, f), 'utf8') });
    }
    return out;
}

describe('roosync_dashboard — secret retention: condensation egress (#3584 limites 2+3)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(testTmpBase);
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
        process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
        process.env.EMBEDDINGS_API_KEY = LEAKED_KEY;
        mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
        mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
        llm.enabled = false;
        llm.create.mockReset().mockImplementation(async (params: { messages: Array<{ role: string; content: string }> }) => {
            const sys = params.messages[0]?.content ?? '';
            if (sys.includes('synthèse de dashboards')) {
                return { choices: [{ message: { content: '## Status condensé (test)' } }] };
            }
            return { choices: [{ message: { content: '## Résumé des messages archivés (test)' } }] };
        });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.ROOSYNC_MACHINE_ID;
        delete process.env.ROOSYNC_WORKSPACE_ID;
        delete process.env.EMBEDDINGS_API_KEY;
    });

    it('SUCCESS path: prompts LLM, archive, and live intercom all masked — one condensation', async () => {
        llm.enabled = true;
        const file = await seedFillerDashboardOverThreshold();
        // FILLER-0/FILLER-1 will be ARCHIVED; FILLER-5 (newest, padded) stays KEPT.
        await injectIntoFile(file, [
            ['FILLER-0', `FILLER-0 [WARN] clé active : ${LEAKED_KEY}`],
            ['FILLER-1', `FILLER-1 gitlink ${GIT_SHA} sur main`],
            ['FILLER-5', `FILLER-5 [WARN] clé active : ${LEAKED_KEY}`],
        ]);

        // One more post crosses the 92% preemptive threshold → condenseIntercom
        // runs with the LLM available (success path).
        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'post déclencheur', createIfNotExists: true,
        });
        expect(r.success).toBe(true);
        expect(llm.create.mock.calls.length).toBeGreaterThan(0);

        // Limite 2 — the provider only ever sees masked content: every captured
        // prompt, system AND user, across both parallel calls (status + summary).
        for (const call of llm.create.mock.calls) {
            const msgs = call[0].messages as Array<{ role: string; content: string }>;
            expect(JSON.stringify(msgs)).not.toContain(LEAKED_KEY);
            expect(JSON.stringify(msgs)).toContain(REDACTION);
        }

        // Limite 3 — the condensation archive (direct fs.writeFile) is masked,
        // and the archived git SHA survives (no over-redaction).
        const archives = await readArchiveFiles();
        expect(archives.length).toBeGreaterThan(0);
        for (const a of archives) {
            expect(a.content, `archive ${a.name}`).not.toContain(LEAKED_KEY);
        }
        const success = archives.find(a => a.content.includes(REDACTION));
        expect(success).toBeDefined();
        expect(success!.name).not.toMatch(/-fallback\.md$/);
        expect(success!.content).toContain(GIT_SHA);

        // Auto-heal — the LIVE intercom is rewritten masked: the kept FILLER-5
        // (pre-guard secret) no longer carries the raw value.
        const after = await readFile(file, 'utf8');
        expect(after).not.toContain(LEAKED_KEY);
        expect(after).toContain(REDACTION);
    });

    it('FALLBACK path (LLM down): the truncation archive is masked, live intercom too', async () => {
        const file = await seedFillerDashboardOverThreshold();
        await injectIntoFile(file, [
            ['FILLER-0', `FILLER-0 [WARN] clé active : ${LEAKED_KEY}`],
        ]);

        await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'post déclencheur', createIfNotExists: true,
        });

        const archives = await readArchiveFiles();
        expect(archives.length).toBeGreaterThan(0);
        const fallback = archives.find(a => /-fallback\.md$/.test(a.name));
        expect(fallback).toBeDefined();
        expect(fallback!.content).not.toContain(LEAKED_KEY);
        expect(fallback!.content).toContain(REDACTION);

        const after = await readFile(file, 'utf8');
        expect(after).not.toContain(LEAKED_KEY);
    });

    it('pre-delete archive copy is masked (limite 3)', async () => {
        for (let i = 0; i < 2; i++) {
            await roosyncDashboard({
                action: 'append', type: 'workspace',
                content: `FILLER-${i} court`, createIfNotExists: true,
            });
        }
        const file = path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md');
        await injectIntoFile(file, [
            ['FILLER-0', `FILLER-0 [WARN] clé active : ${LEAKED_KEY}`],
        ]);
        await ageBeyondProtection(file);

        const r = await roosyncDashboard({ action: 'delete', type: 'workspace' });
        expect(r.success).toBe(true);

        const archives = await readArchiveFiles();
        const preDelete = archives.find(a => a.name.includes('-pre-delete-'));
        expect(preDelete).toBeDefined();
        expect(preDelete!.content).not.toContain(LEAKED_KEY);
        expect(preDelete!.content).toContain(REDACTION);
    });
});

describe('roosync_dashboard — scrub: retroactive withdrawal of the live dashboard (#3584 retrait)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(testTmpBase);
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
        process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
        process.env.EMBEDDINGS_API_KEY = LEAKED_KEY;
        mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
        mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
        llm.enabled = false;
        llm.create.mockReset();
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.ROOSYNC_MACHINE_ID;
        delete process.env.ROOSYNC_WORKSPACE_ID;
        delete process.env.EMBEDDINGS_API_KEY;
    });

    it('masks a pre-#1144 secret in the LIVE file AND the PG mirror, without waiting for condensation', async () => {
        // Seed through the tool, then inject the raw secret into a message AND the
        // status — the state a seat inherits from pre-guard writes.
        const r0 = await roosyncDashboard({
            action: 'write', type: 'workspace',
            content: '## État\n\nbaseline', createIfNotExists: true,
        });
        expect(r0.success).toBe(true);
        await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'message contenant du contexte', createIfNotExists: true,
        });
        const file = path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md');
        await injectIntoFile(file, [
            ['message contenant du contexte', `message contenant du contexte — clé: ${LEAKED_KEY}`],
            ['## État\n\nbaseline', `## État\n\nbaseline — clé: ${LEAKED_KEY}`],
        ]);
        // Sanity: the raw secret IS on disk before scrub (pre-guard state).
        expect(await readFile(file, 'utf8')).toContain(LEAKED_KEY);

        const r = await roosyncDashboard({ action: 'scrub', type: 'workspace' });
        expect(r.success).toBe(true);
        expect(r.message).toContain('1 message(s)');

        const after = await readFile(file, 'utf8');
        expect(after).not.toContain(LEAKED_KEY);
        expect(after.match(new RegExp(REDACTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))!.length).toBe(2);

        // The PG mirror is re-synced from the same masked object.
        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        expect(JSON.stringify(synced)).not.toContain(LEAKED_KEY);
        expect(synced.status.markdown).toContain(REDACTION);
        expect(synced.intercom.messages.some((m: { content: string }) => m.content.includes(REDACTION))).toBe(true);
    });

    it('leaves an already-clean dashboard content intact (rewrites, masks nothing)', async () => {
        await roosyncDashboard({
            action: 'write', type: 'workspace',
            content: '## État\n\npropre', createIfNotExists: true,
        });
        await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'aucun secret ici', createIfNotExists: true,
        });

        const r = await roosyncDashboard({ action: 'scrub', type: 'workspace' });
        expect(r.success).toBe(true);
        expect(r.message).toContain('0 message(s)');
        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        expect(synced.intercom.messages[0].content).toBe('aucun secret ici');
    });

    it('fails closed when the dashboard does not exist', async () => {
        const r = await roosyncDashboard({ action: 'scrub', type: 'workspace' });
        expect(r.success).toBe(false);
        expect(r.message).toContain('introuvable');
    });
});

describe('roosync_dashboard — wt-cleanup archive copy is masked (#3584 limite 3)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(testTmpBase);
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
        // workspace-wt-* keys are the ones cleanupStaleWorktreeDashboards targets.
        process.env.ROOSYNC_WORKSPACE_ID = 'wt-orphan-1';
        process.env.EMBEDDINGS_API_KEY = LEAKED_KEY;
        mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
        mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
        llm.enabled = false;
        llm.create.mockReset();
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.ROOSYNC_MACHINE_ID;
        delete process.env.ROOSYNC_WORKSPACE_ID;
        delete process.env.EMBEDDINGS_API_KEY;
    });

    it('archives a stale worktree dashboard with the secret masked', async () => {
        // Short status (<100 chars) + old lastModified + messages → cleanup-eligible.
        await roosyncDashboard({
            action: 'write', type: 'workspace',
            content: 'husk', createIfNotExists: true,
        });
        await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'message de travail', createIfNotExists: true,
        });
        const file = path.join(tmpDir, 'dashboards', 'workspace-wt-orphan-1.md');
        await injectIntoFile(file, [
            ['message de travail', `message de travail — clé: ${LEAKED_KEY}`],
        ]);
        await ageBeyondProtection(file);

        // `list` runs the cleanup pass (#1410 item 4).
        const r = await roosyncDashboard({ action: 'list' });
        expect(r.success).toBe(true);

        const archives = await readArchiveFiles();
        const wt = archives.find(a => a.name.includes('-wt-cleanup-'));
        expect(wt).toBeDefined();
        expect(wt!.content).not.toContain(LEAKED_KEY);
        expect(wt!.content).toContain(REDACTION);
    });
});
