/**
 * Tests for #1855 HUD statusline: detail="full" extension of roosync_get_status
 *
 * Tests parseHudDataFromDashboard and the full detail mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('os');
vi.unmock('../../../services/RooSyncService.js');
vi.unmock('../../../services/ConfigService.js');

import { parseHudDataFromDashboard } from '../get-status.js';

describe('#1855 HUD: parseHudDataFromDashboard', () => {
  it('should extract CLAIMED messages with issue numbers', () => {
    const now = new Date().toISOString();
    const content = `---
type: workspace
key: workspace-roo-extensions
---

## Status

Active.

## Intercom

### [${now}] myia-po-2023|roo-extensions

## [CLAIMED] #1863 Phase A — 3 tool fusions — myia-po-2023

Machine: myia-po-2023 | ETA: 4h

### [${now}] myia-po-2025|roo-extensions

## [DONE] #1861 — SDDD reliability fix

Completed.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeClaims).toHaveLength(1);
    expect(result.activeClaims[0].machineId).toBe('myia-po-2023');
    expect(result.activeClaims[0].issue).toBe('#1863');
    expect(result.activeClaims[0].timestamp).toBe(now);
  });

  it('should extract pipeline stage tags [PLAN], [EXEC], [VERIFY], [FIX], [BLOCKED]', () => {
    const now = new Date().toISOString();
    const content = `---
type: workspace
---

## Intercom

### [${now}] myia-po-2024|roo-extensions

## [EXEC] Implementing feature X

Working on it.

### [${now}] myia-po-2025|roo-extensions

## [VERIFY] Running tests for #1861

Tests passing.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeStages).toHaveLength(2);
    expect(result.activeStages[0].stage).toBe('EXEC');
    expect(result.activeStages[0].machineId).toBe('myia-po-2024');
    expect(result.activeStages[1].stage).toBe('VERIFY');
    expect(result.activeStages[1].machineId).toBe('myia-po-2025');
  });

  it('should filter out messages older than 2 hours', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const content = `---
type: workspace
---

## Intercom

### [${threeHoursAgo}] myia-po-2023|roo-extensions

## [CLAIMED] #1234 — Old claim

Should be filtered out.

### [${now}] myia-po-2024|roo-extensions

## [CLAIMED] #5678 — Fresh claim

Should be kept.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeClaims).toHaveLength(1);
    expect(result.activeClaims[0].issue).toBe('#5678');
  });

  it('should return empty arrays when no intercom section', () => {
    const content = `---
type: workspace
---

## Status

No intercom here.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeClaims).toHaveLength(0);
    expect(result.activeStages).toHaveLength(0);
  });

  it('should return empty arrays when intercom says *Aucun message.*', () => {
    const content = `---
type: workspace
---

## Intercom

*Aucun message.*`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeClaims).toHaveLength(0);
    expect(result.activeStages).toHaveLength(0);
  });

  it('should handle DONE and INFO tags without extracting them as claims or stages', () => {
    const now = new Date().toISOString();
    const content = `---
type: workspace
---

## Intercom

### [${now}] myia-po-2023|roo-extensions

## [DONE] Completed task #1863

All done.

### [${now}] myia-po-2025|roo-extensions

## [INFO] Starting work

Info only.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeClaims).toHaveLength(0);
    expect(result.activeStages).toHaveLength(0);
  });

  it('should extract issue "unknown" when no #NNN pattern in CLAIMED message', () => {
    const now = new Date().toISOString();
    const content = `---
type: workspace
---

## Intercom

### [${now}] myia-po-2023|roo-extensions

## [CLAIMED] Starting investigation

No issue number here.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeClaims).toHaveLength(1);
    expect(result.activeClaims[0].issue).toBe('unknown');
  });

  it('should handle multiple stages in a single message', () => {
    const now = new Date().toISOString();
    const content = `---
type: workspace
---

## Intercom

### [${now}] myia-po-2023|roo-extensions

## [EXEC] Working on fix, then [VERIFY] tests

Combined stages in one message.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeStages).toHaveLength(2);
    expect(result.activeStages[0].stage).toBe('EXEC');
    expect(result.activeStages[1].stage).toBe('VERIFY');
  });

  it('should handle BLOCKED stage tag', () => {
    const now = new Date().toISOString();
    const content = `---
type: workspace
---

## Intercom

### [${now}] myia-po-2023|roo-extensions

## [BLOCKED] Waiting for dependency

Cannot proceed.`;

    const result = parseHudDataFromDashboard(content);

    expect(result.activeStages).toHaveLength(1);
    expect(result.activeStages[0].stage).toBe('BLOCKED');
  });
});
