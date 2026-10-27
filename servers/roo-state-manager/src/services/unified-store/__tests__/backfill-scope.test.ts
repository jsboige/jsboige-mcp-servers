/**
 * Full-scope verdict + foreign-file classification (#4131, review ms#1540 RE2).
 *
 * The completeness marker opens the DEFAULT PG read fleet-wide, so it may
 * only be written by a run that covered the WHOLE scope. These pure helpers
 * are what the two backfill scripts ask before writing the marker.
 */

import { describe, test, expect } from 'vitest';
import {
  CHANNEL_ALL_PHASES,
  CHANNEL_DEFAULT_DIRS,
  decideMarkerWrite,
  evaluateChannelScope,
  evaluateDashboardScope,
  isForeignMessageFileName,
} from '../backfill-scope.js';

describe('evaluateChannelScope (#4131, ms#1540 RE2)', () => {
  test('the default run (no option) is FULL scope', () => {
    const verdict = evaluateChannelScope({});
    expect(verdict.fullScope).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  test('an explicit default set is still FULL scope', () => {
    const verdict = evaluateChannelScope({
      dirs: ['inbox', 'sent', 'archive'],
      phases: ['messages', 'attachments'],
    });
    expect(verdict.fullScope).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  test('--limit is NOT full scope (a smoke test leaves the store incomplete)', () => {
    const verdict = evaluateChannelScope({ limit: 100 });
    expect(verdict.fullScope).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('--limit 100');
  });

  test('--limit 0 does not restrict anything (the loop never breaks on it)', () => {
    expect(evaluateChannelScope({ limit: 0 }).fullScope).toBe(true);
  });

  test('--dirs inbox (a subset) is NOT full scope', () => {
    const verdict = evaluateChannelScope({ dirs: ['inbox'] });
    expect(verdict.fullScope).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('--dirs inbox');
  });

  test('--dirs missing one default dir is NOT full scope', () => {
    expect(evaluateChannelScope({ dirs: ['inbox', 'sent'] }).fullScope).toBe(false);
  });

  test('--only attachments (the messages phase is dropped) is NOT full scope', () => {
    const verdict = evaluateChannelScope({ phases: ['attachments'] });
    expect(verdict.fullScope).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('--only attachments');
  });

  test('every reason is reported, not just the first', () => {
    const verdict = evaluateChannelScope({ limit: 5, dirs: ['inbox'], phases: ['messages'] });
    expect(verdict.fullScope).toBe(false);
    expect(verdict.reasons).toHaveLength(3);
  });
});

describe('evaluateDashboardScope (#4131, ms#1540 RE2)', () => {
  test('the default run is FULL scope', () => {
    const verdict = evaluateDashboardScope({});
    expect(verdict.fullScope).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  test('--limit is NOT full scope', () => {
    expect(evaluateDashboardScope({ limit: 10 }).fullScope).toBe(false);
  });

  test('--key (a key filter) is NOT full scope', () => {
    const verdict = evaluateDashboardScope({ keyFilter: 'workspace-' });
    expect(verdict.fullScope).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('--key workspace-');
  });
});

describe('isForeignMessageFileName (#4131, ms#1540 RE2)', () => {
  test('a msg-* file is a channel message (it gates the marker on failure)', () => {
    expect(isForeignMessageFileName('msg-20260908T114008-9phols.json')).toBe(false);
    expect(isForeignMessageFileName('MSG-20260908T114008-9phols.json')).toBe(false);
  });

  test('the foreign artifacts of the shared tree are NOT messages', () => {
    expect(isForeignMessageFileName('consumed-20261011-msg-20261009T044930-gnsjfh.json')).toBe(true);
    expect(isForeignMessageFileName('adjoint-16180-ai01-20260915 (1).json')).toBe(true);
    expect(isForeignMessageFileName('correl-235624Z-rsm-deepseek.json')).toBe(true);
    expect(isForeignMessageFileName('po2025-c2244-21756-lc-evidence.json')).toBe(true);
  });

  test('a file that merely CONTAINS msg- is still foreign', () => {
    expect(isForeignMessageFileName('consumed-msg-2026.json')).toBe(true);
  });
});

describe('the scope constants are the ones the scripts default to', () => {
  test('channel defaults', () => {
    expect(CHANNEL_DEFAULT_DIRS).toEqual(['inbox', 'sent', 'archive']);
    expect(CHANNEL_ALL_PHASES).toEqual(['messages', 'attachments']);
  });
});

describe('decideMarkerWrite (#4131, ms#1540 RE2 — the marker gate)', () => {
  const full = evaluateChannelScope({});

  test('LIVE + 0 error + full scope ⇒ the marker is written', () => {
    const decision = decideMarkerWrite({ liveMode: true, errors: 0, scope: full });
    expect(decision.write).toBe(true);
    expect(decision.reason).toBe('');
  });

  test('a dry run never writes the marker', () => {
    const decision = decideMarkerWrite({ liveMode: false, errors: 0, scope: full });
    expect(decision.write).toBe(false);
    expect(decision.reason).toContain('dry run');
  });

  test('one error withholds the marker', () => {
    const decision = decideMarkerWrite({ liveMode: true, errors: 1, scope: full });
    expect(decision.write).toBe(false);
    expect(decision.reason).toContain('1 error');
  });

  test('a partial run withholds the marker and says why', () => {
    const decision = decideMarkerWrite({
      liveMode: true,
      errors: 0,
      scope: evaluateChannelScope({ limit: 100 }),
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toContain('--limit 100');
  });

  test('a partial run with errors reports the error first', () => {
    const decision = decideMarkerWrite({
      liveMode: true,
      errors: 3,
      scope: evaluateChannelScope({ dirs: ['inbox'] }),
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toContain('3 error');
  });

  test('the dashboards verdict feeds the same gate', () => {
    expect(
      decideMarkerWrite({ liveMode: true, errors: 0, scope: evaluateDashboardScope({}) }).write,
    ).toBe(true);
    expect(
      decideMarkerWrite({
        liveMode: true,
        errors: 0,
        scope: evaluateDashboardScope({ keyFilter: 'workspace-' }),
      }).write,
    ).toBe(false);
  });
});
