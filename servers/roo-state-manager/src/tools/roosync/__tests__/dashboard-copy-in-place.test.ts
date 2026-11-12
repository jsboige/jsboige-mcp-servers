/**
 * #3782: The Drive store must be replaced in place (copyFile), never via
 * rename-over-existing — DriveFS parks the replaced version at the Drive
 * root (machine-*.md orphans, 4/24h measured 28/09) or forks it to ` (N).md`
 * (#3482). Behavior: the canonical lands and no staging .tmp survives.
 * Static: the write path never regresses to fs.rename over the tmp.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-copy-in-place-');
const sourcePath = path.join(__dirname, '..', 'dashboard.ts');

describe('dashboard copy-in-place #3782', () => {
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

  async function dashboardsDirFiles(): Promise<string[]> {
    return readdir(path.join(tmpDir, 'dashboards'));
  }

  it('write then append: canonical lands, no staging .tmp survives', async () => {
    const writeResult = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: 'status initial',
      createIfNotExists: true,
    });
    expect(writeResult.success).toBe(true);

    const appendResult = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'message un',
      tags: ['INFO'],
    });
    expect(appendResult.success).toBe(true);

    const files = await dashboardsDirFiles();
    expect(files).toContain(`${writeResult.key}.md`);
    const leftovers = files.filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);

    const content = await readFile(
      path.join(tmpDir, 'dashboards', `${writeResult.key}.md`),
      'utf8'
    );
    expect(content).toContain('message un');
  });

  it('full rewrite of an existing dashboard replaces content in place', async () => {
    const writeResult = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: 'premiere version',
      createIfNotExists: true,
    });
    const key = writeResult.key;

    const rewrite = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: 'version remplacee',
      createIfNotExists: false,
    });
    expect(rewrite.success).toBe(true);

    const files = await dashboardsDirFiles();
    expect(files.filter(f => f.includes('.tmp'))).toEqual([]);
    expect(files).toContain(`${key}.md`);

    const content = await readFile(path.join(tmpDir, 'dashboards', `${key}.md`), 'utf8');
    expect(content).toContain('version remplacee');
  });

  it('static drift-guard: the write path never renames the tmp over the canonical', async () => {
    const src = await readFile(sourcePath, 'utf8');

    // #4643 — writeArchiveAtomically is a sanctioned tmp→final rename, for
    // ARCHIVES (write-once artifacts; temp+rename is the requested anti-husk
    // mechanic, dispatch ai-01 12/11). Strip its block so the guard below
    // stays about the CANONICAL dashboard write path. The strip MUST remove
    // something — a helper renamed or reshaped fails loudly instead of
    // silently scanning nothing.
    const canonicalSrc = src.replace(
      /export async function writeArchiveAtomically\([\s\S]*?\r?\n\}\r?\n/,
      ''
    );
    expect(canonicalSrc.length).toBeLessThan(src.length);

    // The exact regression: fs.rename(tmpPath, filePath) on either write site.
    expect(canonicalSrc).not.toContain('fs.rename(tmpPath');

    // The replacement mechanic and the staging naming must both be present on
    // the two write sites (writeDashboardFile + appendDashboardIncremental).
    // #4286 — the staging is per-CALL now (`<pid>.<seq>`): two writers of the
    // SAME process (deferred file mirror + the condensation chained by the
    // same handleAppend) must not share a staging path (po-2023 finding). Both
    // sites go through the one helper, and the #4003 sweep recognises both
    // shapes (`\.md\.(\d+)(?:\.\d+)?\.tmp$` — see the sweep tests).
    expect(src.match(/fs\.copyFile\(tmpPath, filePath\)/g)?.length).toBe(2);
    // `await` — the helper is async (it mkdirs the out-of-tree staging dir).
    expect(src.match(/await nextDashboardStagingPath\(filePath\)/g)?.length).toBe(2);
    // Drive-root fix (#4003/#3782): the staging is OUT of the synced store, in
    // the machine-local tmpdir, with the dashboard basename kept in the name so
    // the #4003 sweep still recognises it.
    expect(src).toContain("path.join(os.tmpdir(), 'rsm-dashboard-staging')");
    expect(src).toContain('`${path.basename(filePath)}.${process.pid}.${++dashboardStagingSeq}.tmp`');

    // Two sanctioned renames in the store layer, both ARCHIVE-side (new path
    // or write-once artifact — never rename-over-existing on the canonical):
    // the archive move and writeArchiveAtomically's temp→final (#4643).
    const renames = src.match(/fs\.rename\(/g) ?? [];
    expect(renames.length).toBe(2);
  });
});
