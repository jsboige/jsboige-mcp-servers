/**
 * #4915 test double for `build/tools/roosync/dashboard.js` — exactly the seven
 * names the CLI imports. Everything is in-memory or inside the temp root.
 *
 * The renderer is a faithful twin of the ONE contract the CLI relies on
 * (`buildDashboardMarkdown`): no stamp → no `mirrorExportAt` key (byte-for-byte
 * the pre-#4915 rendering), stamp → the key lands in the frontmatter. The real
 * generator is pinned separately by `dashboard-export-stamp.test.ts`; here the
 * subject is the CLI's write ORDER and its stamping decision.
 *
 * REVIEW ms#1919 (ai-01, 25/11) — `readDashboardFile` used to answer from a
 * fixed in-memory WITNESS, which hid the priority the review is about: the real
 * one answers from PG as soon as the key has a readable row there
 * (`dashboard.ts:2651-2672`) and only falls back to the file. A double that
 * always answers "the file" cannot show an append that exists ONLY in the file
 * being lost. So:
 *   - `RSM_APPEND_TEST_PG_READ=pg` → the PG view answers every read (`read:pg`):
 *     the witness alone, WITHOUT whatever landed in the file meanwhile. That is
 *     the measurable difference between the two sources.
 *   - default → the FILE view answers (`read:file`): the real target parsed by
 *     the served parser's twin (`dashboard-markdown-stub.mjs`), i.e. exactly
 *     what `readDashboardFromGdrive` + `parseDashboardMarkdown` would produce.
 *   - `RSM_APPEND_TEST_RETIRED=reread` → the second and later reads answer null
 *     (`read:retired`): the key was retired while the CLI was inside its PG
 *     attempt (#3782 — a retired key must not be resurrected). With
 *     `RSM_APPEND_TEST_RETIRED_MARK` unset the same null is journaled
 *     `read:undetermined`: the file exists, `readDashboardFile` answers null
 *     and NOTHING confirms the retirement — the tier-2 review's second case
 *     (ai-01, 26/11), where the base is unknown rather than empty.
 *   - `RSM_APPEND_TEST_PG_READ=pg-ahead` → the PG view answers (`read:pg`) with
 *     a status and a `lastModified` NEWER than the file's: the ordinary state
 *     of a mirror between two exports. The mirror must still be written there.
 *   - a DIRECTORY target is the harness' "the file half is unreadable" setup:
 *     it answers `read:unreadable` with the witness view, which keeps the rest
 *     of the flow exercised without depending on fs error shapes (the CLI's own
 *     `readFileHalf` is what has to report unreadability).
 *
 * Re-review knobs kept from #4915:
 *   - `RSM_APPEND_TEST_CONCURRENT=during-pg|same-id`: attempt 1 of the PG write
 *     lands a concurrent append in the target file (store-stub.mjs).
 *   - `RSM_APPEND_TEST_RELOCK=deny`: every acquisition after the first is
 *     refused — the stolen-lock case.
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { parseDashboardMarkdown } from './dashboard-markdown.js';

const journal = (line) => {
  if (process.env.RSM_APPEND_TEST_JOURNAL) {
    appendFileSync(process.env.RSM_APPEND_TEST_JOURNAL, `${line}\n`, 'utf8');
  }
};

const WITNESS = {
  id: 'myia-po-2023:listener:ic-20261123T080000-ab12',
  timestamp: '2026-11-23T08:00:00.000Z',
  author: { machineId: 'myia-po-2023', workspace: 'listener' },
  content: '[WARN][LISTENER][#3761] temoin.',
};

const witnessView = (key) => ({
  key,
  type: 'machine',
  status: { markdown: '*Aucun contenu.*' },
  lastModified: WITNESS.timestamp,
  lastModifiedBy: WITNESS.author,
  intercom: { messages: [WITNESS], totalMessages: 1 },
});

// `pg-ahead`: the PG row as a status update left it after the last export.
const PG_AHEAD_STATUS = '*Statut écrit dans PG après le dernier export.*';
const PG_AHEAD_STAMP = '2026-11-24T11:30:00.000Z';

let reads = 0;

export function buildDashboardKey(type, machineId, workspace) {
  return workspace ? `${type}-${machineId}-${workspace}` : `${type}-${machineId}`;
}

export function createEmptyDashboard(type, key, author) {
  return {
    key,
    type,
    status: { markdown: '*Aucun contenu.*' },
    lastModified: null,
    lastModifiedBy: author,
    intercom: { messages: [], totalMessages: 0 },
  };
}

export async function readDashboardFile(key) {
  reads += 1;
  const target = process.env.RSM_APPEND_TEST_TARGET ?? '';

  if (process.env.RSM_APPEND_TEST_RETIRED === 'reread' && reads > 1) {
    // Same null, two different stories: a CONFIRMED retirement (the CLI must
    // not resurrect the key) or an undetermined absence (the CLI must not
    // replace a file it cannot account for).
    journal(process.env.RSM_APPEND_TEST_RETIRED_MARK === '1' ? 'read:retired' : 'read:undetermined');
    return null;
  }

  // Pre-review ms#1919 (ai-01, 26/11 constat 1): the FIRST read answers null
  // while the file exists — a key PG holds no readable row for, whose file
  // still carries content. The mirror must not be built from a one-message
  // state and erase it.
  if (process.env.RSM_APPEND_TEST_ABSENT === 'first' && reads === 1) {
    journal('read:absent');
    return null;
  }

  // PG first, as `dashboard.ts` does: a readable row answers, the file is only
  // the fallback. The PG view never carries the concurrent append.
  const pgRead = process.env.RSM_APPEND_TEST_PG_READ;
  if (pgRead === 'pg' || pgRead === 'pg-ahead') {
    journal('read:pg');
    if (pgRead === 'pg-ahead') {
      // PG moved ahead of its last export: same read priority, NEWER status and
      // stamp than the file's. That is the ordinary state of a mirror between
      // two exports — a stale file is mirrored, it is not "a newer status".
      return { ...witnessView(key), status: { markdown: PG_AHEAD_STATUS }, lastModified: PG_AHEAD_STAMP };
    }
    return witnessView(key);
  }

  let isFile = false;
  let exists = true;
  try {
    isFile = statSync(target).isFile();
  } catch {
    exists = false;
    isFile = false;
  }
  if (!exists) {
    journal('read:null'); // absent: the CLI creates an empty base
    return null;
  }
  if (!isFile) {
    journal('read:unreadable'); // a directory: the harness' unreadable-half setup
    return witnessView(key);
  }

  journal('read:file');
  return parseDashboardMarkdown(readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), key);
}

export function getDashboardPath() {
  journal('path');
  return process.env.RSM_APPEND_TEST_TARGET;
}

export function buildDashboardMarkdown(dashboard, exportStamp) {
  const stamp = exportStamp && typeof exportStamp.mirrorExportAt === 'string' ? exportStamp.mirrorExportAt : null;
  journal(`markdown:${stamp === null ? 'none' : `stamp:${stamp}`}`);
  const frontmatter = [
    'type: machine',
    `lastModified: ${dashboard.lastModified}`,
    `totalMessages: ${dashboard.intercom.totalMessages}`,
  ];
  if (stamp !== null) frontmatter.push(`mirrorExportAt: ${stamp}`);
  const body = dashboard.intercom.messages
    .map((m) => `### [${m.timestamp}] ${m.author.machineId}|${m.author.workspace}\n[msg: ${m.id}]\n${m.content}\n`)
    .join('\n');
  return `---\n${frontmatter.join('\n')}\n---\n\n## Intercom\n\n${body}`;
}

let acquires = 0;

export async function acquireAppendLock(key, holder) {
  acquires += 1;
  const refused = process.env.RSM_APPEND_TEST_RELOCK === 'deny' && acquires > 1;
  journal(`lock:acquire${refused ? ':refused' : ''}:${key}:${holder.workspace}`);
  return !refused;
}

export async function releaseAppendLock(key) {
  journal(`lock:release:${key}`);
  return true;
}
