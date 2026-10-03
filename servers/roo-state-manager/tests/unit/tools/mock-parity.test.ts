/**
 * Mock parity harness (#1320 — claw-code pattern: "mock parity harness",
 * adapted from rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs).
 *
 * Runs the REAL dashboard + message tool handlers through scripted scenarios
 * twice — once against the real filesystem (temp dir, no GDrive), once
 * against the in-memory fs bridge — then diffs the observable effects:
 * the file tree under the shared root and the normalized tool results.
 *
 * A diff means the in-memory mock drifted from real filesystem behavior.
 * That mock is what lets CI script storage scenarios deterministically
 * (no GDrive dependency, no DriveFS quirks) — parity is what makes it
 * trustworthy.
 *
 * Isolation rules that make the two runs comparable:
 * - Same logical ROOSYNC_SHARED_PATH for both runs; only the fs backend
 *   differs (the transport, not the truth).
 * - PG gates explicitly OFF (env scrubbed): the file path IS the parity
 *   surface, dual-write degrades to Null writer by design.
 * - vi.resetModules() + dynamic re-import per run: every module singleton
 *   (MessageManager, circuit breakers, caches) is rebuilt fresh.
 *
 * @module tests/unit/tools/mock-parity.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { runAllScenarios } from '../../mock-parity/scenarios.js';
import { normalizeResult, snapshotMemoryTree, snapshotRealTree } from '../../mock-parity/trace.js';
import type { BridgeState } from '../../mock-parity/in-memory-fs.js';

// Hoisted: shared by the vi.mock factories and this test file, OUTSIDE the
// resettable module graph so resetModules() cannot orphan the bridge.
const bridge = vi.hoisted(() => ({
  backend: 'real' as 'real' | 'memory',
  files: new Map<string, { content: string; mtimeMs: number }>(),
  dirs: new Set<string>(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const { buildPromisesModule, bindBridgeState } = await import('../../mock-parity/in-memory-fs.js');
  bindBridgeState(bridge as BridgeState);
  return buildPromisesModule(bridge as BridgeState, actual);
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const { buildSyncModule, bindBridgeState } = await import('../../mock-parity/in-memory-fs.js');
  bindBridgeState(bridge as BridgeState);
  return buildSyncModule(bridge as BridgeState, actual);
});

const SHARED_ROOT = path.join(os.tmpdir(), `mock-parity-${process.pid}`, 'shared');

beforeAll(() => {
  // PG gates OFF: file path is the parity surface; Null writer degradation
  // is the designed behavior without these env vars. Scrub so a developer
  // machine with a live .env cannot make the two backends diverge via PG.
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.PG_PRIMARY;
  delete process.env.DATABASE_URL;
  process.env.ROOSYNC_SHARED_PATH = SHARED_ROOT;
});

interface RunTrace {
  tree: Record<string, string>;
  outcomes: ReturnType<typeof normalizeResult>;
  rawOutcomes: Array<{ name: string; results: unknown[] }>;
}

async function runOnce(backend: 'real' | 'memory'): Promise<RunTrace> {
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  bridge.backend = backend;
  bridge.files.clear();
  bridge.dirs.clear();
  if (backend === 'real') {
    realFs.rmSync(SHARED_ROOT, { recursive: true, force: true });
    realFs.mkdirSync(SHARED_ROOT, { recursive: true });
  } else {
    // Semantic twin of the real mkdirSync above: root must exist for the
    // assertSharedStoreAccessible probe before any file lands under it.
    bridge.dirs.add(SHARED_ROOT.replace(/\\/g, '/'));
  }

  vi.resetModules();
  const dashboard = await import('../../../src/tools/roosync/dashboard.js');
  const messages = await import('../../../src/tools/roosync/messages.js');

  const outcomes = await runAllScenarios({ dashboard, messages });

  const tree =
    backend === 'real'
      ? snapshotRealTree(SHARED_ROOT, realFs)
      : snapshotMemoryTree(SHARED_ROOT, bridge as BridgeState);
  return { tree, outcomes: normalizeResult(outcomes), rawOutcomes: outcomes };
}

describe('mock parity harness (#1320)', () => {
  test(
    'in-memory fs is behaviorally identical to real fs across all scripted scenarios',
    async () => {
      const real = await runOnce('real');
      const memory = await runOnce('memory');

      // Vacuity guards: both sides empty would "pass" trivially.
      expect(Object.keys(real.tree).length).toBeGreaterThanOrEqual(2);
      // Le snapshot d'arbre mappe chemin relatif -> contenu fichier : chaque
      // valeur doit être une chaîne non vide (un contenu vide ou non-chaîne
      // serait un snapshot menteur, pas une absence).
      expect(
        Object.values(real.tree).every((c) => typeof c === 'string' && c.length > 0)
      ).toBe(true);

      expect(memory.tree).toEqual(real.tree);
      expect(memory.outcomes).toBe(real.outcomes);
    },
    120_000
  );

  test('scenarios exercised real semantics (dedup + roundtrip)', async () => {
    // Fresh real-backend run to assert on semantics (not just parity).
    const real = await runOnce('real');
    const parsed = real.rawOutcomes;

    // Chaque scénario produit exactement 2 résultats (scenarios.ts:79-94,
    // 96-109) — l'indexation results[1] ci-dessous l'exige, on l'asserte.
    const dedup = parsed.find((o) => o.name === 'dashboard_append_idempotent_same_messageId');
    expect(dedup?.results).toHaveLength(2);
    const second = dedup!.results[1] as { deduplicated?: boolean };
    expect(second.deduplicated).toBe(true);

    const roundtrip = parsed.find((o) => o.name === 'messages_send_then_inbox_roundtrip');
    expect(roundtrip?.results).toHaveLength(2);
    const inbox = roundtrip!.results[1] as { content?: Array<{ type: string; text: string }> };
    const text = inbox.content?.find((c) => c.type === 'text')?.text ?? '';
    const inboxJson = JSON.parse(text) as { messages?: Array<{ id: string }> };
    expect(Array.isArray(inboxJson.messages)).toBe(true);
    expect(inboxJson.messages!.some((m) => m.id === 'parity-msg-1')).toBe(true);
  });
});
