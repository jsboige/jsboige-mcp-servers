/**
 * Integration tests for the attachments phase of scripts/backfill-roosync-channel.mjs
 * (ai-01 arbitrage i-a/i-b, 30/09): non-uuid dirs under attachments/ are skipped
 * but counted and named ("foreign") and do NOT gate the INCOMPLETE exit; an
 * unreadable metadata.json inside a real uuid dir stays an ERROR.
 *
 * Runs the real script as a child process against a fixture pool (dry run,
 * --only attachments, ROOSYNC_SHARED_PATH pointed at a temp dir — process env
 * wins over the script's .env loader). No DB, no GDrive.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const RSM_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = path.join(RSM_ROOT, 'scripts', 'backfill-roosync-channel.mjs');

const tmpRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
});

async function makePool(dirs: Array<{ name: string; metadata?: string; payload?: string }>) {
  const root = await mkdtemp(path.join(tmpdir(), 'roosync-att-'));
  tmpRoots.push(root);
  const attRoot = path.join(root, 'attachments');
  for (const d of dirs) {
    await mkdir(path.join(attRoot, d.name), { recursive: true });
    if (d.metadata !== undefined) {
      await writeFile(path.join(attRoot, d.name, 'metadata.json'), d.metadata);
    }
    if (d.payload !== undefined) {
      await writeFile(path.join(attRoot, d.name, 'payload.bin'), d.payload);
    }
  }
  return root;
}

async function runScript(root: string) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [SCRIPT, '--dry-run', '--only', 'attachments'],
      {
        cwd: RSM_ROOT,
        env: { ...process.env, ROOSYNC_SHARED_PATH: root, UNIFIED_STORE_DUAL_WRITE: '' },
        timeout: 60_000,
      },
    );
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ''), code: err.code ?? 1 };
  }
}

const UUID = 'd7728b3f-0a88-434f-b786-e8a3e5bd2531';

describe('backfill-roosync-channel attachments phase (foreign dirs vs uuid errors)', () => {
  test('non-uuid dirs are skipped, counted and named — no gate, exit 0', async () => {
    const root = await makePool([
      {
        name: UUID,
        metadata: JSON.stringify({ uuid: UUID, originalName: 'payload.bin' }),
        payload: 'x',
      },
      { name: 'R485-capstone-360-po2025', payload: 'hand-dropped docs' },
      { name: 'dnn-recovery-1032', payload: 'bundle bytes' },
    ]);

    const { stdout, code } = await runScript(root);

    expect(code).toBe(0);
    expect(stdout).toContain('attachments: 1 uuid dirs');
    expect(stdout).toContain('foreign dirs (not uuid-named, not channel data — skipped, listed): 2');
    expect(stdout).toContain('- R485-capstone-360-po2025');
    expect(stdout).toContain('- dnn-recovery-1032');
    expect(stdout).toContain('foreign:   2');
    expect(stdout).toContain('errors:    0');
    expect(stdout).not.toContain('INCOMPLETE');
  });

  test('an empty metadata.json in a real uuid dir stays an ERROR and gates exit 1 (i-b)', async () => {
    const root = await makePool([
      { name: UUID, metadata: '', payload: 'orphaned payload' },
      { name: 'argumentum-mindmaps-0f83a8f5', payload: 'hand-dropped maps' },
    ]);

    const { stdout, code } = await runScript(root);

    expect(code).toBe(1);
    expect(stdout).toContain('foreign:   1');
    expect(stdout).toContain('errors:    1');
    expect(stdout).toContain(`attachments/${UUID}`);
    expect(stdout).toContain('INCOMPLETE');
  });
});