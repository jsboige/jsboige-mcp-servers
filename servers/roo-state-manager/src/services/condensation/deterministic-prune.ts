/**
 * #4335 (grain 1) — deterministic pre-extraction for condensation LLM input.
 *
 * Pattern source: pi-vcc "compaction zéro-LLM" / pi-context-prune "élagage
 * récupérable" (étude #2416 §6-§7, lead n°1). The condensation LLM calls
 * (`generateLLMSummary` / `generateStatusUpdate` in tools/roosync/dashboard.ts)
 * submit the full verbatim content of archived intercom messages; the dominant
 * bulk of that input is fenced code blocks (logs, JSON, command outputs) whose
 * exact bytes the summarizer does not need to restate.
 *
 * This module is PURE: zero I/O, no env, no fs, no globals. It takes messages,
 * extracts verbatim fenced code blocks at or above a byte threshold into a
 * side-store (keyed by content hash), and replaces each extracted block with a
 * single-line recoverable pointer. `restoreFromSideStore` re-injects the
 * originals byte-exactly — the lossless-on-demand contract of the lead.
 *
 * Grain 1 delivers the algorithm only. Flag-gated integration into
 * condenseIntercom (off by default, env flag documented in .env.example per
 * #2427) and the persisted side-store are the following grains.
 */

import { createHash } from 'crypto';

/** Minimal message shape — IntercomMessage satisfies this structurally. */
export interface PruneableMessage {
  id: string;
  content: string;
}

export type ExtractedKind = 'code-block';

export interface SideStoreEntry {
  /** Stable, content-derived: `dp-` + first 8 hex of sha256(original). */
  pointerId: string;
  /** Message the block was extracted from (same id as the pruned message). */
  messageId: string;
  kind: ExtractedKind;
  /** Verbatim block INCLUDING its fence marker lines. */
  original: string;
  bytes: number;
  /** Full sha256 hex of `original` — pointer integrity check. */
  hash: string;
}

export interface PruneStats {
  messageCount: number;
  inputBytes: number;
  outputBytes: number;
  extractedCount: number;
  sideStoreBytes: number;
  reductionBytes: number;
  /** 0..100, rounded to one decimal; 0 when inputBytes is 0. */
  reductionPct: number;
}

export interface PruneResult {
  prunedMessages: PruneableMessage[];
  sideStore: SideStoreEntry[];
  stats: PruneStats;
}

export interface PruneOptions {
  /** Blocks strictly below this size stay inline. Default 200. */
  minBlockBytes?: number;
}

const DEFAULT_MIN_BLOCK_BYTES = 200;

/** Opening or closing fence line: optional indent, three or more backticks. */
const FENCE_LINE_RE = /^\s*`{3,}/;

/**
 * A pointer line emitted by this module. Kept pure ASCII so no encoding drift
 * can break the match between prune and restore. Exported for tests and for
 * the future integration's diagnostics.
 */
export const POINTER_LINE_RE = /^\[pruned:dp-([0-9a-f]{8}) \d+o code-block side-store#4335\]$/;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Scan one content string line by line. A fence opens on a line matching
 * FENCE_LINE_RE and closes on the NEXT line matching it; a fence still open at
 * EOF is NOT extracted (malformed markdown must never be lost). Only closed
 * blocks whose byte length (fences included) is >= minBlockBytes AND strictly
 * greater than the pointer line that replaces them are extracted.
 */
const pruneContent = (
  content: string,
  messageId: string,
  minBlockBytes: number,
  sideStore: Map<string, SideStoreEntry>,
  out: string[]
): void => {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!FENCE_LINE_RE.test(lines[i])) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    // Fence opened at i — find the closing fence line.
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (FENCE_LINE_RE.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      // Unclosed fence: emit everything verbatim, extract nothing.
      out.push(...lines.slice(i));
      return;
    }
    const block = lines.slice(i, close + 1).join('\n');
    const bytes = Buffer.byteLength(block, 'utf8');
    const pointerId = `dp-${sha256Hex(block).slice(0, 8)}`;
    const pointerLine = `[pruned:${pointerId} ${bytes}o code-block side-store#4335]`;
    if (bytes < minBlockBytes || bytes <= pointerLine.length) {
      // Too small to be worth a pointer — keep verbatim.
      out.push(...lines.slice(i, close + 1));
      i = close + 1;
      continue;
    }
    if (!sideStore.has(pointerId)) {
      sideStore.set(pointerId, {
        pointerId,
        messageId,
        kind: 'code-block',
        original: block,
        bytes,
        hash: sha256Hex(block),
      });
    }
    out.push(pointerLine);
    i = close + 1;
  }
};

/**
 * Deterministically prune verbatim code blocks out of message content.
 * Idempotent: a pointer line contains no fence, so pruning already-pruned
 * content is a no-op. Message order and ids are preserved.
 */
export function deterministicPrune(
  messages: PruneableMessage[],
  opts?: PruneOptions
): PruneResult {
  const minBlockBytes = opts?.minBlockBytes ?? DEFAULT_MIN_BLOCK_BYTES;
  const sideStore = new Map<string, SideStoreEntry>();
  const inputBytes = messages.reduce((acc, m) => acc + Buffer.byteLength(m.content, 'utf8'), 0);

  const prunedMessages = messages.map((m) => {
    const out: string[] = [];
    pruneContent(m.content, m.id, minBlockBytes, sideStore, out);
    return { id: m.id, content: out.join('\n') };
  });

  const entries = [...sideStore.values()];
  const outputBytes = prunedMessages.reduce((acc, m) => acc + Buffer.byteLength(m.content, 'utf8'), 0);
  const sideStoreBytes = entries.reduce((acc, e) => acc + e.bytes, 0);
  const reductionBytes = inputBytes - outputBytes;

  return {
    prunedMessages,
    sideStore: entries,
    stats: {
      messageCount: messages.length,
      inputBytes,
      outputBytes,
      extractedCount: entries.length,
      sideStoreBytes,
      reductionBytes,
      reductionPct: inputBytes === 0 ? 0 : Math.round((reductionBytes / inputBytes) * 1000) / 10,
    },
  };
}

/**
 * Re-inject side-store originals at their pointer lines. Byte-exact lossless
 * contract: `restoreFromSideStore(prune(x).prunedMessages, prune(x).sideStore)`
 * deep-equals x. A pointer whose id is absent from the side-store THROWS —
 * silent degradation would turn "recoverable" into "lost".
 */
export function restoreFromSideStore(
  prunedMessages: PruneableMessage[],
  sideStore: SideStoreEntry[]
): PruneableMessage[] {
  const byId = new Map(sideStore.map((e) => [e.pointerId, e]));
  return prunedMessages.map((m) => {
    // Fast path: no pointer line in this message.
    if (!m.content.includes('[pruned:dp-')) {
      return { ...m };
    }
    const lines = m.content.split('\n');
    const rebuilt: string[] = [];
    for (const line of lines) {
      const match = POINTER_LINE_RE.exec(line);
      if (!match) {
        rebuilt.push(line);
        continue;
      }
      // POINTER_LINE_RE captures the bare hash; side-store keys carry the
      // `dp-` prefix — re-attach it before lookup.
      const entry = byId.get(`dp-${match[1]}`);
      if (!entry) {
        throw new Error(
          `deterministic-prune: pointer ${match[1]} has no side-store entry — content not recoverable`
        );
      }
      rebuilt.push(entry.original);
    }
    return { id: m.id, content: rebuilt.join('\n') };
  });
}
