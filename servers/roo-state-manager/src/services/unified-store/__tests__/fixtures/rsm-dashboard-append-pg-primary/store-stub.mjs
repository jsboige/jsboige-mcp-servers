/**
 * #4915 test double for `build/services/unified-store/roosync-dashboard-store.js`
 * (the served-build module `rsm-dashboard-append.mjs` imports).
 *
 * No I/O beyond the call journal and the one concurrent write: the gate and the
 * PG outcome are driven by env, and each PG attempt records whether the target
 * file ALREADY carries the appended message id — that flag is the ordering
 * witness (PG-first under the gate vs file-first on the unchanged path).
 *
 * Re-review of #4915: the PG attempt also stands for the TIME during which a
 * concurrent append completes on the same key. With `RSM_APPEND_TEST_CONCURRENT`
 * set (`during-pg` | `same-id`), attempt 1 lands that append in the target file
 * — a FULL rewrite, exactly what the other writer's own file-first fallback
 * would leave behind (the witness it read, then its own message). Writing only
 * its own block would make the CLI's re-read look like a fresh dashboard.
 *
 * REVIEW ms#1919 (ai-01, 25/11): because that landed file now really exists and
 * the read double parses it, the two review findings are OBSERVABLE here —
 * a PG-answered re-read (RSM_APPEND_TEST_PG_READ=pg) does not see this message,
 * and a late PG success still faces it on disk.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const journal = (line) => {
  if (process.env.RSM_APPEND_TEST_JOURNAL) {
    appendFileSync(process.env.RSM_APPEND_TEST_JOURNAL, `${line}\n`, 'utf8');
  }
};

// The witness reads the target: only a REGULAR file counts (a directory is the
// harness' "file write must fail" setup and must not throw here).
const isRegularFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const WITNESS_BLOCK =
  '### [2026-11-23T08:00:00.000Z] myia-po-2023|listener\n' +
  '[msg: myia-po-2023:listener:ic-20261123T080000-ab12]\n' +
  '[WARN][LISTENER][#3761] temoin.\n';

const CONCURRENT = {
  id: 'myia-po-2024:listener:ic-20261124T115959-0000',
  timestamp: '2026-11-24T11:59:59.000Z',
  author: { machineId: 'myia-po-2024', workspace: 'listener' },
  content: '[WARN][LISTENER][#3761] temoin concurrent.',
};

/** Byte-identical to the harness' `concurrentFile()` expectation. */
function concurrentFileText(m) {
  return [
    '---',
    'type: machine',
    'lastModified: 2026-11-24T11:59:59.000Z',
    'totalMessages: 2',
    '---',
    '',
    '## Intercom',
    '',
    WITNESS_BLOCK,
    `### [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n[msg: ${m.id}]\n${m.content}\n`,
  ].join('\n');
}

function landConcurrentAppend(target) {
  const mode = process.env.RSM_APPEND_TEST_CONCURRENT;
  if (!mode) return;
  const m =
    mode === 'same-id'
      ? { ...CONCURRENT, id: process.env.RSM_APPEND_TEST_NEW_ID ?? CONCURRENT.id }
      : CONCURRENT;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, concurrentFileText(m), 'utf8');
    journal('concurrent:append');
  } catch {
    // A directory target is the harness' "write must fail" setup: nothing lands.
  }
}

export function isDashboardPgPrimary() {
  const open = process.env.RSM_APPEND_TEST_GATE === 'open';
  journal(`gate:${open ? 'open' : 'closed'}`);
  return open;
}

let attempts = 0;

export async function dualWriteDashboardSyncChecked(dashboard) {
  const target = process.env.RSM_APPEND_TEST_TARGET ?? '';
  const newId = process.env.RSM_APPEND_TEST_NEW_ID ?? '\u0000';
  const fileHasNew = target !== '' && isRegularFile(target) && readFileSync(target, 'utf8').includes(newId);
  journal(`pg:sync:fileHasNew=${fileHasNew}:messages=${dashboard.intercom.messages.length}:attempt=${++attempts}`);
  if (attempts === 1) landConcurrentAppend(target);
  const mode = process.env.RSM_APPEND_TEST_PG;
  if (mode === 'throw') throw new Error('connection terminated');
  if (mode === 'fail') return { ok: false, reason: 'exhausted' };
  if (mode === 'fail-once' && attempts === 1) return { ok: false, reason: 'exhausted' };
  return { ok: true };
}
