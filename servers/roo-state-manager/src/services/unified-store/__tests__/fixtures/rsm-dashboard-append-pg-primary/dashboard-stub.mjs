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
 * `readDashboardFile` returns a fixed WITNESS dashboard (one existing message)
 * so the gate-closed bytes are a stable golden.
 *
 * Re-review of #4915 (po-2028 04:48Z point 2, po-2024 05:00Z addendum), two
 * knobs:
 *   - `RSM_APPEND_TEST_CONCURRENT=during-pg|same-id`: the SECOND and later
 *     reads see the concurrent append that landed on the key while the CLI was
 *     inside its PG attempt (store-stub.mjs lands it in the target file during
 *     attempt 1). `during-pg` = a message from another lane (must survive the
 *     fallback rewrite); `same-id` = OUR stable id (the re-read must dedup,
 *     #4090).
 *   - `RSM_APPEND_TEST_RELOCK=deny`: every acquisition after the first is
 *     refused — the stolen-lock case. The CLI must proceed unserialized (and
 *     say so), never drop the escalation.
 */
import { appendFileSync } from 'node:fs';

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

const CONCURRENT = {
  id: 'myia-po-2024:listener:ic-20261124T115959-0000',
  timestamp: '2026-11-24T11:59:59.000Z',
  author: { machineId: 'myia-po-2024', workspace: 'listener' },
  content: '[WARN][LISTENER][#3761] temoin concurrent.',
};

const concurrentMessage = () =>
  process.env.RSM_APPEND_TEST_CONCURRENT === 'same-id'
    ? { ...CONCURRENT, id: process.env.RSM_APPEND_TEST_NEW_ID ?? CONCURRENT.id }
    : CONCURRENT;

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
  journal('read');
  reads += 1;
  const landed = reads > 1 && Boolean(process.env.RSM_APPEND_TEST_CONCURRENT);
  const messages = landed ? [WITNESS, concurrentMessage()] : [WITNESS];
  const last = messages[messages.length - 1];
  return {
    key,
    type: 'machine',
    status: { markdown: '*Aucun contenu.*' },
    lastModified: last.timestamp,
    lastModifiedBy: last.author,
    intercom: { messages, totalMessages: messages.length },
  };
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