/**
 * Global dashboard notification state — #3226 (a) : notify instead of imposing a read
 *
 * Cursor `lastGlobalSeenAt` per (machineId, workspace). It advances ONLY on an
 * effective read of the `global` dashboard (action:"read", type:"global", section
 * intercom|all) — never on emitting the notification, otherwise it would erase
 * itself and the agent would never see the same missed signal twice.
 *
 * §4 filter — the filter is part of the deliverable, not a refinement:
 *   Notify on:
 *     - ERROR still unmatched after N minutes (default 15, GLOBAL_NOTIF_ERROR_DELAY_MIN)
 *     - ASK, PROPOSAL, BLOCKED, WAKE-*
 *     - CLUSTER-HEALTH (deduped per tour T#NN)
 *   Never notify on:
 *     - INFO, ACK, and every unlisted tag (default-deny — noise kills the channel,
 *       which is exactly what happened to the machine dashboards)
 *     - a DONE closing an ERROR we were never notified about (ERROR/DONE watchdog
 *       pairs resolve in <5 min; notifying both would be two interruptions for
 *       an already-resolved incident)
 *
 * Storage: local JSON file `<serverRoot>/.roo-state-manager/global-notif-cursor.json`.
 * The issue named the unified PG store (#2957/#3151) as the natural home, but PG
 * dual-write is user-gated and not deployed; the cursor is per-reader state anyway
 * (each (machineId, workspace) tracks ITS OWN reading), so a local file is both
 * architecturally correct and live today. Migration to PG when #2957 lands keeps
 * the same key semantics.
 *
 * @module notifications/GlobalNotifState
 * @issue #3226
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IntercomMessage } from '../tools/roosync/dashboard-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Server root (build/notifications → root, or src/notifications → root under vitest). */
function stateDir(): string {
  return process.env.GLOBAL_NOTIF_STATE_DIR || path.resolve(__dirname, '..', '..', '.roo-state-manager');
}

function cursorFilePath(): string {
  return path.join(stateDir(), 'global-notif-cursor.json');
}

function readerKey(machineId: string, workspace: string): string {
  return `${machineId}|${workspace}`;
}

interface CursorFileShape {
  /** readerKey → ISO timestamp of the last effective global read */
  lastGlobalSeenAt: Record<string, string>;
}

/** In-process write serialization for the tiny cursor file (multi-workspace hosts). */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => undefined);
  return next;
}

async function readCursorFile(): Promise<CursorFileShape> {
  try {
    const raw = await readFile(cursorFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.lastGlobalSeenAt === 'object' && parsed.lastGlobalSeenAt !== null) {
      return parsed as CursorFileShape;
    }
  } catch {
    /* absent or corrupt — treat as empty */
  }
  return { lastGlobalSeenAt: {} };
}

async function writeCursorFileAtomic(shape: CursorFileShape): Promise<void> {
  const file = cursorFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(shape, null, 2), 'utf8');
  await rename(tmp, file);
}

/**
 * Advance the cursor for a reader. Monotonic: never moves backwards
 * (a stale concurrent read cannot resurrect already-seen messages).
 */
export async function advanceGlobalSeenCursor(
  machineId: string,
  workspace: string,
  seenUpToIso: string
): Promise<void> {
  await enqueueWrite(async () => {
    const shape = await readCursorFile();
    const key = readerKey(machineId, workspace);
    const current = shape.lastGlobalSeenAt[key];
    if (current && current >= seenUpToIso) return; // monotonic guard
    shape.lastGlobalSeenAt[key] = seenUpToIso;
    await writeCursorFileAtomic(shape);
  });
}

/**
 * Get the cursor for a reader. First call ever bootstraps to NOW
 * (persisted) — a fresh install must not replay the whole backlog as
 * notifications; that burst is exactly the noise this design refuses.
 */
export async function getGlobalSeenCursor(machineId: string, workspace: string): Promise<string> {
  const key = readerKey(machineId, workspace);
  const shape = await readCursorFile();
  const existing = shape.lastGlobalSeenAt[key];
  if (existing) return existing;
  const now = new Date().toISOString();
  await enqueueWrite(async () => {
    const fresh = await readCursorFile();
    fresh.lastGlobalSeenAt[key] = fresh.lastGlobalSeenAt[key] ?? now;
    await writeCursorFileAtomic(fresh);
  });
  return now;
}

/** Reset in-process queue hook for tests. */
export function resetGlobalNotifQueueForTests(): void {
  writeQueue = Promise.resolve();
}

// ============================================================================
// §4 filter — pure, no I/O
// ============================================================================

/** Default grace period before an unmatched ERROR becomes notifiable (minutes). */
export const DEFAULT_ERROR_DELAY_MIN = 15;

/** Tags that close an ERROR. */
const RESOLUTION_TAGS = new Set(['DONE', 'RESOLVED', 'FIXED']);

/** Scan window at the head of a message for [TAG] markers (tags live at the start). */
const TAG_SCAN_CHARS = 300;
const TAG_RE = /\[([A-Z][A-Z0-9_-]{1,30})\]/g;

/** Extract [TAG] markers from the head of a message content. */
export function extractTags(content: string): string[] {
  const head = content.slice(0, TAG_SCAN_CHARS);
  const out: string[] = [];
  for (const m of head.matchAll(TAG_RE)) out.push(m[1]);
  return out;
}

/** Extract the tour label (T#NN) from a CLUSTER-HEALTH message, if any. */
function extractTour(content: string): string | null {
  const m = content.match(/T#(\d+)/);
  return m ? `T#${m[1]}` : null;
}

export interface GlobalNotifSummary {
  /** Total notifiable message count (footer header figure). */
  count: number;
  /** Unmatched ERRORs older than the delay. */
  errors: number;
  /** Distinct CLUSTER-HEALTH tour labels (one per tour). */
  clusterHealthTours: string[];
  asks: number;
  proposals: number;
  blocked: number;
  /** Distinct WAKE-* tags present. */
  wakes: string[];
}

export interface GlobalNotifFilterOptions {
  /** Messages authored by this machine are never notifiable (self-exclusion). */
  selfMachineId?: string;
  /** Unmatched-ERROR grace period in minutes (default 15, env override upstream). */
  errorDelayMin?: number;
}

/**
 * Does `candidate` resolve `errorMsg`? Same author machine, later timestamp,
 * carrying a resolution tag. Cross-machine DONEs do NOT close an ERROR —
 * they are unrelated cycle reports, and over-matching would silence real
 * incidents (#3226 §4: the filter makes or breaks the channel).
 */
function isResolvedBy(errorMsg: IntercomMessage, messages: IntercomMessage[]): boolean {
  return messages.some(other => {
    if (other === errorMsg) return false;
    if (other.author.machineId !== errorMsg.author.machineId) return false;
    if (other.timestamp <= errorMsg.timestamp) return false;
    const tags = extractTags(other.content);
    return tags.some(t => RESOLUTION_TAGS.has(t));
  });
}

/**
 * Apply the §4 filter to a global dashboard intercom snapshot.
 * Pure — deterministic on (messages, cursor, now).
 */
export function filterNotifiableGlobalMessages(
  messages: IntercomMessage[],
  cursorIso: string,
  nowMs: number,
  options: GlobalNotifFilterOptions = {}
): GlobalNotifSummary {
  const errorDelayMin = options.errorDelayMin ?? DEFAULT_ERROR_DELAY_MIN;
  const selfMachineId = options.selfMachineId;

  // Messages already seen (timestamp <= cursor) are never notified again —
  // but they still participate in ERROR resolution matching (a DONE newer
  // than the cursor resolves an ERROR newer than the cursor).
  const unseen = messages.filter(m => m.timestamp > cursorIso && m.author.machineId !== selfMachineId);

  const summary: GlobalNotifSummary = {
    count: 0,
    errors: 0,
    clusterHealthTours: [],
    asks: 0,
    proposals: 0,
    blocked: 0,
    wakes: []
  };

  for (const msg of unseen) {
    const tags = extractTags(msg.content);

    for (const tag of tags) {
      if (tag.startsWith('WAKE-')) {
        if (!summary.wakes.includes(tag)) summary.wakes.push(tag);
        summary.count += 1;
        break; // one notification per message, not per tag
      }
    }

    if (tags.includes('ERROR')) {
      const ageMin = (nowMs - Date.parse(msg.timestamp)) / 60_000;
      if (ageMin >= errorDelayMin && !isResolvedBy(msg, messages)) {
        summary.errors += 1;
        summary.count += 1;
      }
      continue;
    }

    if (tags.includes('CLUSTER-HEALTH')) {
      const tour = extractTour(msg.content) ?? msg.id;
      if (!summary.clusterHealthTours.includes(tour)) {
        summary.clusterHealthTours.push(tour);
        summary.count += 1;
      }
      continue;
    }

    if (tags.includes('ASK')) {
      summary.asks += 1;
      summary.count += 1;
    } else if (tags.includes('PROPOSAL')) {
      summary.proposals += 1;
      summary.count += 1;
    } else if (tags.includes('BLOCKED')) {
      summary.blocked += 1;
      summary.count += 1;
    }
    // INFO, ACK, DONE, TASK, CLAIMED, REPLY, WARN, and everything unlisted:
    // default-deny. The channel dies of noise, not of silence (#3226 §4).
  }

  return summary;
}

function pluralFr(n: number, singular: string, plural: string): string {
  return `${n} ${n > 1 ? plural : singular}`;
}

/**
 * Build the global [NOTIF] footer block per the issue §3 shape:
 *
 *   [NOTIF] 3 nouveau(x) sur global depuis ta dernière lecture
 *           (1 ERROR non résolu, 1 CLUSTER-HEALTH T#55).
 *           Lire : roosync_dashboard action:"read" type:"global"
 *
 * Returns null when there is nothing notifiable (cost: zero tokens).
 */
export function buildGlobalFooter(summary: GlobalNotifSummary): string | null {
  if (summary.count === 0) return null;

  const details: string[] = [];
  if (summary.errors > 0) {
    details.push(pluralFr(summary.errors, 'ERROR non résolu', 'ERROR non résolus'));
  }
  if (summary.clusterHealthTours.length === 1) {
    const tour = summary.clusterHealthTours[0];
    details.push(tour.startsWith('T#') ? `1 CLUSTER-HEALTH ${tour}` : '1 CLUSTER-HEALTH');
  } else if (summary.clusterHealthTours.length > 1) {
    details.push(`${summary.clusterHealthTours.length} CLUSTER-HEALTH`);
  }
  if (summary.wakes.length > 0) {
    for (const w of summary.wakes) details.push(`1 ${w}`);
  }
  if (summary.asks > 0) details.push(pluralFr(summary.asks, 'ASK', 'ASK'));
  if (summary.proposals > 0) details.push(pluralFr(summary.proposals, 'PROPOSAL', 'PROPOSAL'));
  if (summary.blocked > 0) details.push(pluralFr(summary.blocked, 'BLOCKED', 'BLOCKED'));

  return (
    `\n[NOTIF] ${summary.count} nouveau(x) sur global depuis ta dernière lecture` +
    `\n        (${details.join(', ')}).` +
    `\n        Lire : roosync_dashboard action:"read" type:"global"`
  );
}
