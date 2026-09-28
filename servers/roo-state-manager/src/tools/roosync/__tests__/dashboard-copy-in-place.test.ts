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

    // The exact regression: fs.rename(tmpPath, filePath) on either write site.
    expect(src).not.toContain('fs.rename(tmpPath');

    // The replacement mechanic and the pid-suffixed staging must both be present
    // on the two write sites (writeDashboardFile + appendDashboardIncremental).
    expect(src.match(/fs\.copyFile\(tmpPath, filePath\)/g)?.length).toBe(2);
    expect(src.match(/`\$\{filePath\}\.\$\{process\.pid\}\.tmp`/g)?.length).toBe(2);

    // The only rename left in the store layer is the archive move (new path,
    // not rename-over-existing) — assert it stays the sole one.
    const renames = src.match(/fs\.rename\(/g) ?? [];
    expect(renames.length).toBe(1);
  });
});
