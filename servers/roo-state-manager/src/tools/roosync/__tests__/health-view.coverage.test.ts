/**
 * #833 C3 (po-2024 c.132) — formatMarkdown cold-arm coverage
 *
 * Source: src/tools/roosync/health-view.ts L417-483 (`formatMarkdown`, PURE exported).
 * Methodology #2642: `%` is a weak signal; target untested CONTRACTS on a PURE EXPORTED
 * FUNCTION. The sibling `health-view.test.ts` Part B covers the icon + Qdrant 4-way +
 * Embeddings-DEGRADED + drift-cap + Not-checked arms, but 4 string-literal ternary arms
 * were never asserted — silent-swap class #728 (a value swap like 'MISSING'→'DOWN' or a
 * join separator change passes `100%F` coverage undetected). These tests lock the exact
 * rendered strings for the UX that the fleet coordinator reads off the dashboard.
 *
 * All cold arms are in `formatMarkdown` itself — pure (input → string), no IO, no mocks:
 *   - L427-429: `systemHealth.flags` non-empty → renders `- **Flags:** a, b` (join ', ')
 *   - L433: `capabilities.sharedPath === false` → `SharedPath: MISSING`
 *   - L440: `capabilities.embeddings === false` → `Embeddings: MISSING (not configured)`
 *   - L441: `capabilities.embeddingsReachable === true` → `Embeddings: OK (configured + reachable)`
 *     (the only untested arm of the 4-way #2547 embeddings ternary)
 */

import { describe, it, expect } from 'vitest';
import { formatMarkdown, type HealthViewResult } from '../health-view.js';

/** Minimal HEALTHY baseline. Overridden per-test via spread. Mirrors the sibling test's base. */
const base: HealthViewResult = {
  status: 'HEALTHY',
  score: 100,
  timestamp: '2026-07-03T00:00:00.000Z',
  localMachine: 'myia-po-2024',
  systemHealth: { machinesOnline: 6, machinesUnknown: 0, machinesTotal: 6, flags: [] },
  capabilities: { sharedPath: true, qdrant: true, embeddings: true },
  drift: { checked: true, baselineSource: 'remote (via GDrive inventory)', critical: 0, important: 0, warning: 0, info: 0, items: [] },
  envCheck: { checked: true, missing: [], present: ['QDRANT_URL'] },
  recommendations: ['All systems nominal'],
};

describe('formatMarkdown — cold-arm coverage (#833 C3 c.132)', () => {
  describe('systemHealth.flags non-empty branch (L427-429)', () => {
    it('renders a Flags line joining items with ", " when flags is non-empty', () => {
      // Source L427-429: `if (flags.length > 0) lines.push(\`- **Flags:** ${flags.join(', ')}\`)`.
      // Locks BOTH the conditional render AND the ', ' separator (silent-swap if join changed).
      const md = formatMarkdown({
        ...base,
        systemHealth: { ...base.systemHealth, flags: ['DASHBOARDS_DIR_MISSING', 'STALE_HEARTBEAT'] },
      });
      expect(md).toContain('- **Flags:** DASHBOARDS_DIR_MISSING, STALE_HEARTBEAT');
    });

    it('omits the Flags line entirely when flags is empty', () => {
      // Source L427: the `if` is skipped when length === 0 — no Flags line rendered.
      const md = formatMarkdown({ ...base, systemHealth: { ...base.systemHealth, flags: [] } });
      expect(md).not.toContain('**Flags:**');
    });

    it('renders a single flag without trailing separator', () => {
      // Source L428: join of a 1-element array yields the element alone (no stray comma).
      const md = formatMarkdown({
        ...base,
        systemHealth: { ...base.systemHealth, flags: ['QDRANT_DOWN'] },
      });
      expect(md).toContain('- **Flags:** QDRANT_DOWN');
      expect(md).not.toMatch(/\*\*Flags:\*\* QDRANT_DOWN,/);
    });
  });

  describe('capabilities.sharedPath === false (L433)', () => {
    it('renders SharedPath: MISSING when sharedPath is false', () => {
      // Source L433: \`- SharedPath: ${sharedPath ? 'OK' : 'MISSING'}\`. The 'OK' arm is hit by
      // every baseline test; the 'MISSING' arm was cold. Locks the exact UX string.
      const md = formatMarkdown({ ...base, capabilities: { ...base.capabilities, sharedPath: false } });
      expect(md).toContain('- SharedPath: MISSING');
      expect(md).not.toContain('SharedPath: OK');
    });

    it('renders SharedPath: OK when sharedPath is true', () => {
      // Mirror assertion confirming the true arm still renders 'OK' (regression guard).
      const md = formatMarkdown({ ...base, capabilities: { ...base.capabilities, sharedPath: true } });
      expect(md).toContain('- SharedPath: OK');
    });
  });

  describe('capabilities.embeddings === false (L440)', () => {
    it('renders Embeddings: MISSING (not configured) when embeddings is false', () => {
      // Source L440: \`!embeddings ? 'MISSING (not configured)' : ...\`. The sibling tests
      // always set embeddings:true (DEGRADED / default arms), so the not-configured arm was cold.
      const md = formatMarkdown({ ...base, capabilities: { ...base.capabilities, embeddings: false } });
      expect(md).toContain('- Embeddings: MISSING (not configured)');
      expect(md).not.toMatch(/Embeddings: (OK|DEGRADED)/);
    });
  });

  describe('capabilities.embeddingsReachable === true (L441) — 4-way #2547 ternary', () => {
    it('renders Embeddings: OK (configured + reachable) when embeddingsReachable is true', () => {
      // Source L441: \`embeddingsReachable === true ? 'OK (configured + reachable)' : ...\`.
      // Sibling tests drive the false→DEGRADED arm and the undefined→'OK (configured)' default,
      // but never the explicit true arm. This completes the 4-way ternary matrix.
      const md = formatMarkdown({
        ...base,
        capabilities: { ...base.capabilities, embeddings: true, embeddingsReachable: true },
      });
      expect(md).toContain('- Embeddings: OK (configured + reachable)');
      // Distinguish from the undefined-default 'OK (configured)' arm (no 'reachable').
      expect(md).not.toMatch(/Embeddings: OK \(configured\)$/m);
    });
  });
});
