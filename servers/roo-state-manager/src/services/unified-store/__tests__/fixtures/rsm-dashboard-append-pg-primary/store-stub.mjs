/**
 * #4915 test double for `build/services/unified-store/roosync-dashboard-store.js`
 * (the served-build module `rsm-dashboard-append.mjs` imports).
 *
 * No I/O beyond the call journal: the gate and the PG outcome are driven by
 * env, and each PG attempt records whether the target file ALREADY carries the
 * appended message id — that flag is the ordering witness (PG-first under the
 * gate vs file-first on the unchanged path).
 *
 * Re-review of #4915: the PG attempt also stands for the TIME during which a
 * concurrent append completes on the same key. With `RSM_APPEND_TEST_CONCURRENT`
 * set (`during-pg` | `same-id`), attempt 1 lands that append in the target file
 * — exactly what the other writer's own file-first fallback would write — and
 * journals `concurrent:append` at that point of the order.
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

const CONCURRENT = {
  id: 'myia-po-2024:listener:ic-20261124T115959-0000',
  timestamp: '2026-11-24T11:59:59.000Z',
  author: { machineId: 'myia-po-2024', workspace: 'listener' },
  content: '[WARN][LISTENER][#3761] temoin concurrent.',
};

function landConcurrentAppend(target) {
  const mode = process.env.RSM_APPEND_TEST_CONCURRENT;
  if (!mode) return;
  const m =
    mode === 'same-id'
      ? { ...CONCURRENT, id: process.env.RSM_APPEND_TEST_NEW_ID ?? CONCURRENT.id }
      : CONCURRENT;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      `---\ntype: machine\n---\n\n## Intercom\n\n### [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n[msg: ${m.id}]\n${m.content}\n`,
      'utf8'
    );
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