/**
 * #4131 — scripts/send-roosync-message.mjs resolves the backfill marker
 * BEFORE the send decides PG-primary vs G:.
 *
 * A fresh process starts with the marker unresolved ('unknown' ⇒ the default
 * PG-primary gate is closed), so a CLI send that skipped the resolution took
 * the G: path every time: the worker reports of every seat kept the G:
 * `messages/` tree written past the end of dual-write (ai-01, 02/11 04:59:52Z).
 *
 * These tests run the REAL script (copied, byte for byte, into a temp
 * RSM root) against a stub build whose modules trace the call order. They
 * pin the wiring itself — not the script's text:
 *   1. the marker is resolved, and AWAITED, before sendMessage runs;
 *   2. the printed mode is measured from the G: inbox, not assumed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, '../../../../scripts');

const STUBS: Record<string, string> = {
  'utils/shared-state-path.js': `
    export function getSharedStatePath() { return process.env.ROOSYNC_SHARED_PATH; }
  `,
  'services/unified-store/pg-backfill-marker.js': `
    import { appendFileSync } from 'node:fs';
    export async function ensureBackfillMarkersFresh(options) {
      appendFileSync(process.env.SEND_CLI_TRACE, 'ensure-start timeoutMs=' + options?.timeoutMs + '\\n');
      if (process.env.SEND_CLI_STUB_MARKER_THROWS === '1') throw new Error('stub marker failure');
      await new Promise((resolve) => setTimeout(resolve, 30));
      globalThis.__markerResolved = true;
      appendFileSync(process.env.SEND_CLI_TRACE, 'ensure-end\\n');
    }
  `,
  'services/MessageManager.js': `
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    export function getMessageManager() {
      return {
        async sendMessage() {
          appendFileSync(process.env.SEND_CLI_TRACE, 'send resolved=' + (globalThis.__markerResolved === true) + '\\n');
          const message = { id: 'msg-stub-1' };
          if (process.env.SEND_CLI_STUB_GDRIVE === '1') {
            const inbox = path.join(process.env.ROOSYNC_SHARED_PATH, 'messages', 'inbox');
            mkdirSync(inbox, { recursive: true });
            writeFileSync(path.join(inbox, message.id + '.json'), '{}');
          }
          return message;
        },
      };
    }
  `,
  'services/unified-store/roosync-channel-dual-write.js': `
    import { appendFileSync } from 'node:fs';
    export async function dualWriteRooSyncMessageToStore() {
      appendFileSync(process.env.SEND_CLI_TRACE, 'dual\\n');
    }
  `,
  'services/unified-store/writer-factory.js': `
    class LiveWriter { async close() {} }
    class NullUnifiedStoreWriter { async close() {} }
    export function getUnifiedStoreWriter() {
      return process.env.SEND_CLI_STUB_LIVE === '1' ? new LiveWriter() : new NullUnifiedStoreWriter();
    }
  `,
};

let root: string;
let trace: string;
let shared: string;

function runCli(
  stub: { gdrive: boolean; live: boolean; markerThrows?: boolean },
  extraEnv: NodeJS.ProcessEnv = {}
) {
  // A scrubbed env: nothing inherited can reach a real store.
  const env: NodeJS.ProcessEnv = {
    ...extraEnv,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ROOSYNC_SHARED_PATH: shared,
    SEND_CLI_TRACE: trace,
    SEND_CLI_STUB_GDRIVE: stub.gdrive ? '1' : '0',
    SEND_CLI_STUB_LIVE: stub.live ? '1' : '0',
    SEND_CLI_STUB_MARKER_THROWS: stub.markerThrows ? '1' : '0',
  };
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'send-roosync-message.mjs'),
      '--from', 'myia-test:probe', '--to', 'myia-other', '--subject', 's', '--body', 'b'],
    { env, encoding: 'utf-8', timeout: 30_000 }
  );
  const lines = existsSync(trace) ? readFileSync(trace, 'utf-8').trim().split('\n') : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines };
}

describe('send-roosync-message.mjs — marker resolved before the send (#4131)', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rsm-send-cli-test-'));
    mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(path.join(SCRIPTS, 'send-roosync-message.mjs'), path.join(root, 'scripts', 'send-roosync-message.mjs'));
    copyFileSync(path.join(SCRIPTS, 'lib', 'resolve-build-dir.mjs'), path.join(root, 'scripts', 'lib', 'resolve-build-dir.mjs'));
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const [rel, source] of Object.entries(STUBS)) {
      const file = path.join(root, 'build', rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    shared = path.join(root, 'shared');
    mkdirSync(shared);
    trace = path.join(root, 'trace.log');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the marker is resolved, and awaited, before sendMessage decides', () => {
    const run = runCli({ gdrive: false, live: true });
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines.slice(0, 3)).toEqual(['ensure-start timeoutMs=15000', 'ensure-end', 'send resolved=true']);
  });

  test('the lookup budget follows the writer pool when the seat configures it', () => {
    // ai-01 02/11 07:10:26Z: the default 3 s connect timed out during a PG busy
    // burst and the worker report went to G:, while the writer pool connected
    // right after. A seat that widens the pool widens the lookup with it; a
    // value that is not a positive number keeps the 15 s default.
    const widened = runCli({ gdrive: false, live: true }, { UNIFIED_STORE_CONNECT_TIMEOUT_MS: '60000' });
    expect(widened.status, widened.stderr).toBe(0);
    expect(widened.lines[0]).toBe('ensure-start timeoutMs=60000');
    rmSync(trace, { force: true });
    const invalid = runCli({ gdrive: false, live: true }, { UNIFIED_STORE_CONNECT_TIMEOUT_MS: 'abc' });
    expect(invalid.lines[0]).toBe('ensure-start timeoutMs=15000');
  });

  test('a marker resolution that throws never blocks the send: delivered on G:, exit 0', () => {
    const run = runCli({ gdrive: true, live: true, markerThrows: true });
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines).toContain('send resolved=false');
    expect(run.stdout).toContain('SENT msg-stub-1 (gdrive+pg)');
    expect(run.stderr).toContain('marker resolution failed');
  });

  test('a send that wrote no G: inbox file prints pg-primary', () => {
    const run = runCli({ gdrive: false, live: true });
    expect(run.stdout).toContain('SENT msg-stub-1 (pg-primary)');
  });

  test('a send that landed on G: with a live writer prints gdrive+pg', () => {
    const run = runCli({ gdrive: true, live: true });
    expect(run.stdout).toContain('SENT msg-stub-1 (gdrive+pg)');
    expect(run.lines).toContain('dual');
  });

  test('a send that landed on G: without a live writer prints gdrive-only', () => {
    const run = runCli({ gdrive: true, live: false });
    expect(run.stdout).toContain('SENT msg-stub-1 (gdrive-only)');
    expect(run.lines).not.toContain('dual');
  });
});
