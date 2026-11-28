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
 *
 * Tier-2 review ms#1919 (ai-01, 26/11): `RSM_APPEND_TEST_CONCURRENT=status`
 * lands a STATUS update alone (same intercom, newer `lastModified`), and
 * `getDashboardRetirement` is doubled so the CLI can tell a CONFIRMED
 * retirement from an unconfirmed null (`RSM_APPEND_TEST_RETIRED_MARK`).
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
function dashFileText(lastModified, totalMessages, blocks) {
  return [
    '---',
    'type: machine',
    `lastModified: ${lastModified}`,
    `totalMessages: ${totalMessages}`,
    '---',
    '',
    '## Intercom',
    '',
    ...blocks,
  ].join('\n');
}

function blockText(m) {
  return `### [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n[msg: ${m.id}]\n${m.content}\n`;
}

function concurrentFileText(m) {
  return dashFileText('2026-11-24T11:59:59.000Z', 2, [WITNESS_BLOCK, blockText(m)]);
}

/**
 * Follow-up (re-review ms#1919, web1 27/11) `status-then-append`: attempt 2 —
 * the status CARRY — is a PG attempt like any other, so it can be late too. A
 * file-first writer whose own PG attempt failed lands its append during it.
 * Byte-identical to the harness' `FILE_ONLY_SEED`.
 */
const FILE_ONLY_DURING_CARRY = {
  id: 'myia-po-2025:listener:ic-20261124T100000-0000',
  timestamp: '2026-11-24T10:00:00.000Z',
  author: { machineId: 'myia-po-2025', workspace: 'listener' },
  content: '[WARN][LISTENER][#3761] ajout uniquement fichier.',
};

function fileOnlyFileText() {
  return dashFileText('2026-11-24T10:00:00.000Z', 2, [WITNESS_BLOCK, blockText(FILE_ONLY_DURING_CARRY)]);
}

/** Byte-identical to the harness' `STATUS_CHANGED_FILE` expectation. */
const STATUS_CHANGED = {
  lastModified: '2026-11-24T11:59:59.000Z',
  status: '*Statut changé pendant l’essai PG.*',
};

function statusChangedFileText() {
  return [
    '---',
    'type: machine',
    `lastModified: ${STATUS_CHANGED.lastModified}`,
    'totalMessages: 1',
    '---',
    '',
    '## Status',
    '',
    STATUS_CHANGED.status,
    '',
    '## Intercom',
    '',
    WITNESS_BLOCK,
  ].join('\n');
}

function landStatusChange(target) {
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, statusChangedFileText(), 'utf8');
    journal('concurrent:status');
  } catch {
    // Directory target: the write must fail, nothing lands.
  }
}

function landFileOnlyAppend(target) {
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fileOnlyFileText(), 'utf8');
    journal('concurrent:file-only');
  } catch {
    // A directory target is the harness' "write must fail" setup: nothing lands.
  }
}

/**
 * Review ms#1946 (ai-01, 27/11 — blocking): `status-then-backdated-status`
 * lands, DURING the carry (attempt 2), a status whose `lastModified` is
 * EARLIER than our own message's stamp (12:00:00Z) — a seat whose clock is
 * behind. By date it looks "behind PG"; in time it landed after the carry was
 * built. Byte-identical to the harness' `BACKDATED_STATUS_FILE`.
 */
const STATUS_BACKDATED = {
  lastModified: '2026-11-24T11:30:00.000Z',
  status: '*Statut d’un tiers à l’horloge en retard.*',
};

function statusBackdatedFileText() {
  return [
    '---',
    'type: machine',
    `lastModified: ${STATUS_BACKDATED.lastModified}`,
    'totalMessages: 1',
    '---',
    '',
    '## Status',
    '',
    STATUS_BACKDATED.status,
    '',
    '## Intercom',
    '',
    WITNESS_BLOCK,
  ].join('\n');
}

function landBackdatedStatus(target) {
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, statusBackdatedFileText(), 'utf8');
    journal('concurrent:status-backdated');
  } catch {
    // A directory target is the harness' "write must fail" setup: nothing lands.
  }
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

/**
 * #4915 (ai-01 follow-up, 28/11) — the DATA-gated mode.
 *
 * `RSM_APPEND_TEST_GATE=data` resolves the gate the way the real
 * `resolvePrimaryGate` does: `getBackfillMarkerState('dashboard') === 'complete'`.
 * The state comes from the marker double the CLI imports — read through the
 * registry by PATH, so the two share one cache only if they resolved the SAME
 * file. A CLI that warmed a different copy leaves this `'unknown'` and the
 * gate CLOSED: that is the witness.
 *
 * The other modes keep their env-driven answer — the existing witnesses must
 * not drift.
 */
export function isDashboardPgPrimary() {
  if (process.env.RSM_APPEND_TEST_GATE === 'data') {
    const state = readMarkerState();
    const open = state === 'complete';
    journal(`gate:${open ? 'open' : 'closed'}:${state}`);
    return open;
  }
  const open = process.env.RSM_APPEND_TEST_GATE === 'open';
  journal(`gate:${open ? 'open' : 'closed'}`);
  return open;
}

/**
 * The marker double's cached state, read through the registry the double
 * publishes (keyed by the double's own file path). Absent double → the gate
 * reads as the real one does with no marker: `'unknown'`, i.e. CLOSED.
 */
function readMarkerState() {
  const registry = globalThis.__rsmAppendTestMarkerRegistry;
  if (!registry) return 'unknown';
  const key = (p) => p.replace(/\//g, '\\').toLowerCase();
  // The double lives at build/node_modules/@vibesync/core/dist/services/
  // unified-store/pg-backfill-marker.js; the store stub sits at
  // build/services/unified-store/.
  const expected = key(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'node_modules',
      '@vibesync',
      'core',
      'dist',
      'services',
      'unified-store',
      'pg-backfill-marker.js'
    )
  );
  const entry = registry[expected];
  return entry ? entry.state : 'unknown';
}

let attempts = 0;

export async function dualWriteDashboardSyncChecked(dashboard) {
  const target = process.env.RSM_APPEND_TEST_TARGET ?? '';
  const newId = process.env.RSM_APPEND_TEST_NEW_ID ?? '\u0000';
  const fileHasNew = target !== '' && isRegularFile(target) && readFileSync(target, 'utf8').includes(newId);
  journal(`pg:sync:fileHasNew=${fileHasNew}:messages=${dashboard.intercom.messages.length}:attempt=${++attempts}`);
  // Re-review ms#1919 (web1, 27/11): the ids each attempt CARRIES, in order —
  // the witness that a refused second attempt replays the base of the first
  // instead of an empty state.
  if (process.env.RSM_APPEND_TEST_SYNC_IDS === '1') {
    journal(`pg:sync-ids:${dashboard.intercom.messages.map((m) => m.id).join(',')}`);
  }
  // Follow-up (re-review ms#1919, web1 27/11): the STATUS each attempt carries —
  // the witness that a carry reports the FILE's status into PG (attempt 2),
  // while every other attempt carries the base's.
  if (process.env.RSM_APPEND_TEST_SYNC_STATUS === '1') {
    const status = dashboard.status && typeof dashboard.status.markdown === 'string'
      ? dashboard.status.markdown
      : null;
    journal(`pg:sync-status:${JSON.stringify(status)}`);
  }
  if (attempts === 1) {
    // Tier-2 review (ai-01, 26/11 blocker 1): `status` lands a STATUS update
    // instead — same intercom, newer `lastModified`. No message comparison can
    // see it. `status-then-append` lands one here too, then a file-only append
    // during the carry (attempt 2).
    const concurrent = process.env.RSM_APPEND_TEST_CONCURRENT;
    if (
      concurrent === 'status' ||
      concurrent === 'status-then-append' ||
      concurrent === 'status-then-backdated-status'
    )
      landStatusChange(target);
    else landConcurrentAppend(target);
  } else if (attempts === 2) {
    // `status-then-append` only: the carry is a PG attempt too, so it can be late.
    if (process.env.RSM_APPEND_TEST_CONCURRENT === 'status-then-append') landFileOnlyAppend(target);
    // `status-then-backdated-status`: the same window, but the writer's stamp is
    // EARLIER than ours (clock skew) — the case the second check misjudged.
    if (process.env.RSM_APPEND_TEST_CONCURRENT === 'status-then-backdated-status')
      landBackdatedStatus(target);
  }
  const mode = process.env.RSM_APPEND_TEST_PG;
  if (mode === 'throw') throw new Error('connection terminated');
  if (mode === 'fail') return { ok: false, reason: 'exhausted' };
  if (mode === 'fail-once' && attempts === 1) return { ok: false, reason: 'exhausted' };
  if (mode === 'fail-again' && attempts > 1) return { ok: false, reason: 'exhausted' };
  return { ok: true };
}

/**
 * #3782 retirement mark, as `roosync-dashboard-store.ts` serves it: an ACTIVE
 * mark, or null — which the real one also answers when the lookup fails or
 * times out (fail-open). `RSM_APPEND_TEST_RETIRED_MARK=1` confirms the
 * retirement; unset, the null the read double answered is UNCONFIRMED.
 */
export async function getDashboardRetirement(key) {
  const confirmed = process.env.RSM_APPEND_TEST_RETIRED_MARK === '1';
  journal(`retirement:${confirmed ? 'mark' : 'none'}`);
  return confirmed
    ? { sourceKey: key, targetKey: 'machine-myia-ai-01', retiredBy: 'myia-ai-01', retiredAt: '2026-11-24T11:00:00.000Z' }
    : null;
}
