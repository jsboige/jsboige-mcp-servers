/**
 * Trace snapshot + normalization for the mock-parity harness (#1320).
 *
 * A trace is the observable effect of a scenario run:
 *   - the file tree under the shared root (path → normalized content)
 *   - the normalized tool results the scenario captured
 *
 * Normalization erases only run-varying values (timestamps, generated ids,
 * durations, pids, uuids) — everything semantic MUST stay byte-identical
 * between the real-fs run and the in-memory run. A diff here means the mock
 * drifted from real filesystem behavior: that is the parity failure mode
 * this harness exists to catch.
 *
 * @module tests/mock-parity/trace
 * @version 1.0.0
 */

import type { BridgeState } from './in-memory-fs.js';

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const MSG_ID = /\bmsg-\d{8}T\d{6}(?:-[0-9a-fA-F]{2,})?/g;
const IC_ID = /\bic-\d{4}-\d{2}-\d{2}T\d+(?:-[0-9a-zA-Z]+)?/g;
const SNAPSHOT_TS = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z?/g;
const DURATION_MS = /\b\d+(?:\.\d+)?ms\b/g;
// JSON fields whose VALUE is a duration (unit lives in the key): totalMs, writeMs...
const DURATION_FIELD = /"(\w*(?:Ms|Millis|DurationLatency))":\s*\d+(?:\.\d+)?/g;
const PID = /"pid":\s*\d+/g;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

export function normalizeText(input: string): string {
  return input
    .replace(ISO_TS, '<TS>')
    .replace(MSG_ID, 'msg-<ID>')
    .replace(IC_ID, 'ic-<ID>')
    .replace(SNAPSHOT_TS, '<SNAPTS>')
    .replace(UUID, '<UUID>')
    .replace(PID, '"pid":<PID>')
    .replace(DURATION_FIELD, '"$1":<MS>')
    .replace(DURATION_MS, '<MS>');
}

export function normalizeResult(value: unknown): string {
  return normalizeText(JSON.stringify(value, replacer, 2));
}

/** Drop functions and undefined values before stringify (stable JSON). */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'function') return '[fn]';
  if (value === undefined) return null;
  return value;
}

export interface FileTree {
  [relativePath: string]: string;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Snapshot the shared root from REAL disk (backend='real' run). */
export function snapshotRealTree(root: string, realFs: typeof import('fs')): FileTree {
  const tree: FileTree = {};
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = realFs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry}`;
      if (realFs.statSync(full).isDirectory()) {
        walk(full);
      } else {
        const rel = norm(full).slice(norm(root).length + 1);
        // tmp staging files are unlinked right after copyFile by the writer;
        // a residue on real fs is AV-lock noise (Windows), not mock drift.
        if (rel.endsWith('.tmp')) continue;
        tree[rel] = normalizeText(realFs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)));
}

/** Snapshot the shared root from the in-memory bridge state (backend='memory' run). */
export function snapshotMemoryTree(root: string, state: BridgeState): FileTree {
  const prefix = norm(root).replace(/\/$/, '') + '/';
  const tree: FileTree = {};
  for (const [key, entry] of state.files) {
    if (key.startsWith(prefix)) {
      const rel = key.slice(prefix.length);
      if (rel.endsWith('.tmp')) continue;
      tree[rel] = normalizeText(entry.content);
    }
  }
  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)));
}
