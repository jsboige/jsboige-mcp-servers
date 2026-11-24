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
  return {
    key,
    type: 'machine',
    status: { markdown: '*Aucun contenu.*' },
    lastModified: WITNESS.timestamp,
    lastModifiedBy: WITNESS.author,
    intercom: { messages: [WITNESS], totalMessages: 1 },
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

export async function acquireAppendLock(key, holder) {
  journal(`lock:acquire:${key}:${holder.workspace}`);
  return true;
}

export async function releaseAppendLock(key) {
  journal(`lock:release:${key}`);
  return true;
}