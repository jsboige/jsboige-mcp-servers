/**
 * #4131 B14 — smoke test for the read-roosync-inbox.mjs CLI shell.
 *
 * The read logic is covered by cli-inbox-read-4131.test.ts (in-process,
 * mocked reader factory). What only a subprocess can pin is the shell
 * contract the PowerShell worker will rely on: --help exits 0 with usage,
 * missing --machine exits 1 with a stderr message. Both paths exit BEFORE
 * the build/ import, so this test needs no build and no PG.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../../scripts/read-roosync-inbox.mjs');

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      // --help and the arg guard read nothing from the environment that
      // matters; a clean env keeps the test hermetic.
      env: { ...process.env, UNIFIED_STORE_CHANNEL_READ_PG: undefined, UNIFIED_STORE_PG_URL: undefined },
    });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

describe('read-roosync-inbox.mjs shell (#4131 B14)', () => {
  it('--help exits 0 and prints usage with the exit-code contract', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: node scripts/read-roosync-inbox.mjs --machine');
    expect(stdout).toContain("3 = {source:'file',reason:...}");
    // #4131 B17 — the mark-read mode and its extra exit code are part of the
    // contract the PowerShell worker keys on.
    expect(stdout).toContain('--mark-read');
    expect(stdout).toContain('4 = --mark-read');
  });

  it('missing --machine exits 1 before any PG or build dependency', () => {
    const { status } = run([]);
    expect(status).toBe(1);
  });

  // --- #4131 B17: the value guard fires before any build/PG dependency.
  it('--mark-read without a message id exits 1 (trailing flag and next-flag forms)', () => {
    expect(run(['--machine', 'myia-ai-01', '--mark-read']).status).toBe(1);
    expect(run(['--machine', 'myia-ai-01', '--mark-read', '--pretty']).status).toBe(1);
  });

  // --- #4131 B17: the exit-code mapping the PowerShell side will branch on.
  // 0 = persisted (already-read included), 4 = PG answered but nothing written.
  it('--mark-read maps helper outcomes to exit codes 0 / 4 via a build stub', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-cli-b17-'));
    try {
      fs.mkdirSync(path.join(root, 'build', 'services', 'unified-store'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      fs.writeFileSync(
        path.join(root, 'build', 'services', 'unified-store', 'roosync-channel-read.js'),
        `export async function readCliInboxFromPg() {\n` +
          `  return { source: 'pg', messages: [] };\n` +
          `}\n` +
          `export async function markCliMessageReadInPg(machine, workspace, id) {\n` +
          `  if (id === 'msg-ok') return { source: 'pg', written: true, alreadyRead: true };\n` +
          `  if (id === 'msg-refused') return { source: 'pg', written: false, reason: 'denied' };\n` +
          `  return { source: 'file', reason: 'gate-off' };\n` +
          `}\n`
      );
      const env = { ...process.env, RSM_ROOT: root };

      const ok = execFileSync('node', [CLI, '--machine', 'myia-ai-01', '--mark-read', 'msg-ok'], {
        encoding: 'utf-8', timeout: 30_000, env,
      });
      expect(JSON.parse(ok)).toEqual({ source: 'pg', written: true, alreadyRead: true });

      const refused = runStub(['--machine', 'myia-ai-01', '--mark-read', 'msg-refused'], env);
      expect(refused.status).toBe(4);
      expect(JSON.parse(refused.stdout)).toEqual({ source: 'pg', written: false, reason: 'denied' });

      const gateOff = runStub(['--machine', 'myia-ai-01', '--mark-read', 'msg-x'], env);
      expect(gateOff.status).toBe(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    function runStub(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string } {
      try {
        const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 30_000, env });
        return { status: 0, stdout };
      } catch (error) {
        const err = error as { status?: number; stdout?: string };
        return { status: err.status ?? -1, stdout: err.stdout ?? '' };
      }
    }
  });

  // --- review head cad920f5 (Hermes) — F3: process.exit() does not drain a
  // piped stdout; an inbox above the 64 KiB pipe buffer left a TRUNCATED JSON
  // with exit 0, which the worker would parse as a valid empty answer. This
  // subprocess test pins the fix: RSM_ROOT points at a fixture build stub
  // serving ~120 KiB, the child's stdout is a pipe (execFileSync), and the
  // whole payload must arrive parseable.
  it('payload above the 64 KiB pipe buffer arrives complete on a piped stdout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-cli-f3-'));
    try {
      fs.mkdirSync(path.join(root, 'build', 'services', 'unified-store'), { recursive: true });
      // The fixture stub is ESM (`export`) and lives where no package.json
      // exists, so its module type falls back to Node's syntax detection —
      // which is VERSION-DEPENDENT: on by default in Node 25 (green locally),
      // still off in CI's 20.18.0, where the same stub loaded as CommonJS and
      // died on "Unexpected token 'export'" (red run 39717607484). Declare
      // the type explicitly so the test does not encode the runner's Node.
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      const messages = Array.from({ length: 30 }, (_, i) => ({
        id: `msg-${i}`,
        subject: '[TASK] filler',
        body: 'A'.repeat(4000),
      }));
      fs.writeFileSync(
        path.join(root, 'build', 'services', 'unified-store', 'roosync-channel-read.js'),
        `export async function readCliInboxFromPg() {\n` +
          `  return { source: 'pg', messages: ${JSON.stringify(messages)} };\n` +
          `}\n`
      );

      const stdout = execFileSync('node', [CLI, '--machine', 'myia-po-2024'], {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, RSM_ROOT: root },
      });

      expect(Buffer.byteLength(stdout, 'utf-8')).toBeGreaterThan(65_536);
      const parsed = JSON.parse(stdout);
      expect(parsed.source).toBe('pg');
      expect(parsed.messages).toHaveLength(30);
      expect(parsed.messages[29].id).toBe('msg-29');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
