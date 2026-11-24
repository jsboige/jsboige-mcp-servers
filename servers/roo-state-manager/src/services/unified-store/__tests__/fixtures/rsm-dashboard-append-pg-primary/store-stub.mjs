/**
 * #4915 test double for `build/services/unified-store/roosync-dashboard-store.js`
 * (the served-build module `rsm-dashboard-append.mjs` imports).
 *
 * No I/O beyond the call journal: the gate and the PG outcome are driven by
 * env, and each PG attempt records whether the target file ALREADY carries the
 * appended message id — that flag is the ordering witness (PG-first under the
 * gate vs file-first on the unchanged path).
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs';

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
  const mode = process.env.RSM_APPEND_TEST_PG;
  if (mode === 'throw') throw new Error('connection terminated');
  if (mode === 'fail') return { ok: false, reason: 'exhausted' };
  if (mode === 'fail-once' && attempts === 1) return { ok: false, reason: 'exhausted' };
  return { ok: true };
}