/**
 * #4003: dashboard minors — orphan .tmp staging + tag validation/persistence.
 *
 * Part 1 (tmp): the two staging write sites (#3782 writeDashboardFile +
 * appendDashboardIncremental) must clean their `*.md.<pid>.tmp` on EVERY exit
 * path (try/finally static guard), and sweepOrphanDashboardTmpFiles must
 * remove only old + dead-PID staging (age gate protects cross-machine PID
 * collisions on the fleet-shared store, liveness gate protects local writers).
 *
 * Part 2 (tags): canonical spellings normalized (case/brackets folded),
 * unsafe-to-persist tags dropped (not fatal), free-form audience tags kept,
 * tags persisted in the `[tags: …]` meta line on BOTH emitters
 * (incremental append + full rewrite) and read back by the parser. The
 * scheduler-cycle detection (#1442) matches EXACT normalized tags instead of
 * the old substring probe (`'UNDONE'` used to record a successful cycle).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, utimes } from 'fs/promises';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
  recordSchedulerRunAsync: vi.fn(),
}));

import { roosyncDashboard, sweepOrphanDashboardTmpFiles } from '../dashboard.js';
import { parseDashboardMarkdown } from '../dashboard-markdown.js';
import { normalizeDashboardTags, normalizeDashboardTag } from '../dashboard-schemas.js';
import { recordSchedulerRunAsync } from '../heartbeat-activity.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-tags-tmp-');
const sourcePath = path.join(__dirname, '..', 'dashboard.ts');

/** Spawn a short-lived child and resolve with its pid once exited — a guaranteed-dead pid. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid!));
  });
}

/**
 * The scheduler-cycle recording is fire-and-forget behind a dynamic import
 * (`import('./heartbeat-activity.js').then(...)`): it settles a few microtasks
 * AFTER the awaited tool call resolves. Flush the queue before asserting.
 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('dashboard #4003 — tmp staging hygiene', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('static drift-guard: both staging write sites unlink the tmp in a finally', async () => {
    const src = await readFile(sourcePath, 'utf8');
    // Each copyFile is immediately followed by the finally that owns the unlink.
    const guarded = src.match(/fs\.copyFile\(tmpPath, filePath\);\r?\n\s*\} finally \{/g) ?? [];
    expect(guarded.length).toBe(2);
    const finallyUnlinks = src.match(/await fs\.unlink\(tmpPath\)\.catch/g) ?? [];
    expect(finallyUnlinks.length).toBe(2);
  });

  it('sweep removes old+dead-PID tmp only; live-PID, young and non-matching files survive', async () => {
    const dashDir = path.join(tmpDir, 'dashboards');
    await mkdir(dashDir, { recursive: true });
    const pid = await deadPid();
    const old = new Date(Date.now() - 20 * 60_000);

    const deadOld = `workspace-x.md.${pid}.tmp`;              // swept
    const deadYoung = `workspace-x.md.${pid + 1}.tmp`;        // too young → kept (age gate)
    const liveOld = `workspace-x.md.${process.pid}.tmp`;      // own PID → kept
    await writeFile(path.join(dashDir, deadOld), 'stale');
    await writeFile(path.join(dashDir, deadYoung), 'fresh');
    await writeFile(path.join(dashDir, liveOld), 'mine');
    await utimes(path.join(dashDir, deadOld), old, old);
    await utimes(path.join(dashDir, liveOld), old, old);
    // Noise that must never be touched by the sweep
    await writeFile(path.join(dashDir, 'global.md'), '# canonical');
    await writeFile(path.join(dashDir, 'plain.tmp'), 'no md/pid pattern');
    await writeFile(path.join(dashDir, 'workspace-x.md'), '# dashboard');

    const result = await sweepOrphanDashboardTmpFiles();

    expect(result.swept).toEqual([deadOld]);
    expect(result.skipped.sort()).toEqual([deadYoung, liveOld].sort());
    const remaining = (await readdir(dashDir)).sort();
    expect(remaining).toContain('global.md');
    expect(remaining).toContain('workspace-x.md');
    expect(remaining).toContain('plain.tmp');
    expect(remaining).toContain(deadYoung);
    expect(remaining).toContain(liveOld);
    expect(remaining).not.toContain(deadOld);
  });

  it('sweep is a silent no-op when the dashboards dir does not exist', async () => {
    const result = await sweepOrphanDashboardTmpFiles();
    expect(result.swept).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('dashboard #4003 — tags normalization + persistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    vi.mocked(recordSchedulerRunAsync).mockClear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('normalizeDashboardTag: brackets/case folded on canonical, free-form kept, unsafe dropped', () => {
    expect(normalizeDashboardTag('[done]')).toBe('DONE');
    expect(normalizeDashboardTag('done')).toBe('DONE');
    expect(normalizeDashboardTag('  [BLOCKED] ')).toBe('BLOCKED');
    expect(normalizeDashboardTag('claude-interactive')).toBe('claude-interactive');
    expect(normalizeDashboardTag('')).toBeNull();
    expect(normalizeDashboardTag('[]')).toBeNull();
    expect(normalizeDashboardTag('a,b')).toBeNull(); // would corrupt the comma-joined meta line
    expect(normalizeDashboardTag('a]b')).toBeNull(); // would terminate the meta line early
    expect(normalizeDashboardTags(['[done]', 'done', '', 'claude-interactive', 'a,b']))
      .toEqual(['DONE', 'claude-interactive']);
  });

  it('append persists normalized tags in the [tags:] meta line and round-trips via the parser', async () => {
    // First append lands on the absent-file path (writeDashboardFile emitter)
    const first = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'premier message',
      tags: ['[done]', 'claude-interactive'],
    });
    expect(first.success).toBe(true);
    expect((first as any).tags).toEqual(['DONE', 'claude-interactive']);

    // Second append exercises the incremental emitter (appendDashboardIncremental)
    const second = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'second message',
      tags: ['[blocked]'],
    });
    expect(second.success).toBe(true);
    expect((second as any).tags).toEqual(['BLOCKED']);

    const filePath = path.join(tmpDir, 'dashboards', `${first.key}.md`);
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('[tags: DONE, claude-interactive]');
    expect(raw).toContain('[tags: BLOCKED]');

    // Parser round-trip: a full re-read reconstructs the tags
    const parsed = parseDashboardMarkdown(raw.replace(/\r\n/g, '\n'), first.key);
    const tagsById = new Map(parsed.intercom.messages.map(m => [m.content, m.tags]));
    expect(tagsById.get('premier message')).toEqual(['DONE', 'claude-interactive']);
    expect(tagsById.get('second message')).toEqual(['BLOCKED']);
  });

  it('a full rewrite (status update) keeps the persisted tags — condensation cannot strip them', async () => {
    const appendRes = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'message tagge',
      tags: ['ASK', 'cron-worker'],
    });
    expect(appendRes.success).toBe(true);

    const rewrite = await roosyncDashboard({
      action: 'write', type: 'workspace', content: 'status remplace',
    });
    expect(rewrite.success).toBe(true);

    const filePath = path.join(tmpDir, 'dashboards', `${appendRes.key}.md`);
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('[tags: ASK, cron-worker]');
    expect(raw).toContain('message tagge');
  });

  it('unsafe-to-persist tags are dropped silently, not fatal', async () => {
    const res = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'contenu',
      tags: ['OK,AVEC-VIRGULE', 'INFO'],
    });
    expect(res.success).toBe(true);
    expect((res as any).tags).toEqual(['INFO']);
  });

  it('schema rejects empty tags, oversized tags and more than 8 tags', async () => {
    await expect(roosyncDashboard({
      action: 'append', type: 'workspace', content: 'x', tags: [''],
    })).rejects.toThrow(/Invalid arguments/);
    await expect(roosyncDashboard({
      action: 'append', type: 'workspace', content: 'x', tags: ['a'.repeat(65)],
    })).rejects.toThrow(/Invalid arguments/);
    await expect(roosyncDashboard({
      action: 'append', type: 'workspace', content: 'x',
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    })).rejects.toThrow(/Invalid arguments/);
  });

  it('read_archive strips [ack:] before [tags:] — acknowledged tagged messages do not leak meta lines (#1280 review)', async () => {
    // Emit order is [msg:]→[reply-to:]→[ack:]→[tags:]. The archive parser
    // used to skip [ack:] in a comment only: on an acknowledged message the
    // [tags:] anchor missed and BOTH meta lines leaked into the content.
    const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    await mkdir(archiveDir, { recursive: true });
    const key = 'workspace-test-workspace';
    const archiveFile = `${key}-20261001T0000.md`;
    await writeFile(path.join(archiveDir, archiveFile), [
      '---',
      'type: workspace',
      `originalKey: ${key}`,
      'archivedAt: 2026-10-01T00:00:00.000Z',
      'messageCount: 1',
      '---',
      '',
      '### [2026-10-01T00:00:00.000Z] test-machine|test-workspace',
      '[msg: test-machine:test-workspace:ic-1]',
      '[reply-to: myia-ai-01:roo-extensions:ic-0]',
      '[ack: myia-ai-01:2026-10-01T01:00:00.000Z]',
      '[tags: ASK, claude-interactive]',
      '',
      'contenu réel du message archivé',
      '',
    ].join('\n'), 'utf8');

    const res = await roosyncDashboard({ action: 'read_archive', type: 'workspace', archiveFile });
    expect(res.success).toBe(true);
    const msgs = (res as any).archiveData.messages as Array<{ content: string; tags?: string[]; reply_to?: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].tags).toEqual(['ASK', 'claude-interactive']);
    expect(msgs[0].reply_to).toBe('myia-ai-01:roo-extensions:ic-0');
    expect(msgs[0].content).toBe('contenu réel du message archivé');
    expect(msgs[0].content).not.toContain('[ack:');
    expect(msgs[0].content).not.toContain('[tags:');
  });
});

describe('dashboard #4003 — scheduler-cycle detection is exact-match (#1442)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    vi.mocked(recordSchedulerRunAsync).mockClear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it("['[done]'] (brackets, lowercase) records a SUCCESS cycle", async () => {
    const res = await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'cycle termine', tags: ['[done]'],
    });
    expect(res.success).toBe(true);
    await flushAsync();
    expect(recordSchedulerRunAsync).toHaveBeenCalledWith('test-machine', true, { error: undefined });
  });

  it("['IDLE'] records a failed idle cycle", async () => {
    await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'rien a faire', tags: ['IDLE'],
    });
    await flushAsync();
    expect(recordSchedulerRunAsync).toHaveBeenCalledWith('test-machine', false, { error: 'idle-cycle' });
  });

  it("free-form and substring-bearing tags do NOT record a cycle (old substring bug)", async () => {
    await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'un', tags: ['claude-interactive'],
    });
    await flushAsync();
    expect(recordSchedulerRunAsync).not.toHaveBeenCalled();

    await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'deux', tags: ['UNDONE'],
    });
    await flushAsync();
    expect(recordSchedulerRunAsync).not.toHaveBeenCalled();

    await roosyncDashboard({
      action: 'append', type: 'workspace', content: 'trois',
    });
    await flushAsync();
    expect(recordSchedulerRunAsync).not.toHaveBeenCalled();
  });
});
