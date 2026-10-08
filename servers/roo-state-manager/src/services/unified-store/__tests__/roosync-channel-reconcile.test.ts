/**
 * Tests for the periodic GDrive→PG channel reconcile (#3292).
 *
 * @module services/unified-store/__tests__/roosync-channel-reconcile
 * @issue #3292 — residual dual-write loss classes (hard kill, PG outage,
 * machine state regression); #3151 Phase B prerequisite.
 *
 * The core is exercised with REAL files in a temp mailbox (the per-file open
 * path is the cost center #3292 measured — the tests pin that only the
 * MISSING, IN-WINDOW files are opened) and an injected writer double. The
 * env gate is driven directly (save/restore in beforeEach/afterEach).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  reconcileChannelFromGDrive,
  cutoffIdFor,
  embeddedDateKeyFor,
  isChannelDualWriteArmed,
  UNDATED_CAP_PER_PASS,
  type ChannelReconcileResult,
} from '../roosync-channel-reconcile.js';
import type { IUnifiedStoreWriter } from '../UnifiedStoreWriter.js';
import type { RooSyncMessageRow } from '../types.js';

vi.unmock('fs');
vi.unmock('fs/promises');

/** Fixed clock: 2026-09-05T03:18:33Z (the #3292 incident week). */
const NOW = Date.UTC(2026, 8, 5, 3, 18, 33);
const LOOKBACK_DAYS = 7;

describe('roosync-channel-reconcile (#3292)', () => {
  let messagesRoot: string;
  let savedDualWrite: string | undefined;
  let savedPgUrl: string | undefined;
  /** Writer double — listing answers are scripted per test. */
  let listCalls: string[];
  let insertedRows: RooSyncMessageRow[];
  let listResponses: string[][];

  beforeEach(() => {
    messagesRoot = join(__dirname, '../../../__test-data__/reconcile-messages');
    for (const dir of ['inbox', 'sent', 'archive']) {
      const p = join(messagesRoot, dir);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
    savedDualWrite = process.env.UNIFIED_STORE_DUAL_WRITE;
    savedPgUrl = process.env.UNIFIED_STORE_PG_URL;
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://user:pass@pg.test:5432/store';
    listCalls = [];
    insertedRows = [];
    listResponses = [];
  });

  afterEach(() => {
    process.env.UNIFIED_STORE_DUAL_WRITE = savedDualWrite;
    process.env.UNIFIED_STORE_PG_URL = savedPgUrl;
    if (existsSync(messagesRoot)) {
      rmSync(messagesRoot, { recursive: true, force: true });
    }
  });

  const makeWriter = (): Pick<IUnifiedStoreWriter, 'insertRooSyncMessage' | 'listRooSyncMessageIds'> => ({
    async listRooSyncMessageIds(sinceId: string): Promise<string[]> {
      listCalls.push(sinceId);
      // Last scripted response sticks — a 2-call run (pre + post listing)
      // gets [before, after]; more calls reuse the last one.
      const idx = Math.min(listCalls.length - 1, listResponses.length - 1);
      return listResponses[Math.max(0, idx)] ?? [];
    },
    async insertRooSyncMessage(row: RooSyncMessageRow): Promise<void> {
      insertedRows.push(row);
    },
  });

  const writeMessage = (dir: 'inbox' | 'sent' | 'archive', id: string, overrides: Record<string, unknown> = {}) => {
    const message = {
      id,
      from: 'myia-po-2024:roo-extensions',
      to: 'myia-po-2026:roo-extensions',
      subject: `reconcile test ${id}`,
      body: 'body',
      priority: 'MEDIUM',
      status: 'unread',
      timestamp: '2026-09-04T12:00:00.000Z',
      tags: [],
      ...overrides,
    };
    writeFileSync(join(messagesRoot, dir, `${id}.json`), JSON.stringify(message, null, 2), 'utf-8');
  };

  const run = (writer = makeWriter()) =>
    reconcileChannelFromGDrive({ messagesRoot, lookbackDays: LOOKBACK_DAYS, now: NOW, writer });

  describe('cutoffIdFor', () => {
    test('formats the cutoff as an id (UTC, lexicographically comparable)', () => {
      // 7 days before 2026-09-05T03:18:33Z is 2026-08-29T03:18:33Z
      expect(cutoffIdFor(NOW, 7)).toBe('msg-20260829T031833');
    });

    test('pads single-digit fields', () => {
      expect(cutoffIdFor(Date.UTC(2026, 10, 3, 4, 5, 6), 1)).toBe('msg-20261102T040506');
    });
  });

  describe('env gate', () => {
    test('skips without touching the writer or the filesystem when dual-write is off', async () => {
      delete process.env.UNIFIED_STORE_DUAL_WRITE;
      expect(isChannelDualWriteArmed()).toBe(false);

      const result = await run();

      expect(result.status).toBe('skipped-not-armed');
      expect(listCalls).toHaveLength(0);
      expect(insertedRows).toHaveLength(0);
    });

    test('skips when the PG URL is missing (half-armed is not armed)', async () => {
      delete process.env.UNIFIED_STORE_PG_URL;

      const result = await run();

      expect(result.status).toBe('skipped-not-armed');
    });
  });

  describe('id-diff pass', () => {
    test('inserts ONLY the in-window missing ids — old files are never opened', async () => {
      // Older than the cutoff — must not even reach the candidate set.
      writeMessage('inbox', 'msg-20260801T000000-old');
      // In window, already in PG — must not be re-inserted nor opened.
      writeMessage('inbox', 'msg-20260904T100000-present');
      // In window, missing from PG — the one row this run must heal.
      writeMessage('inbox', 'msg-20260904T120000-missing');
      // Same message from the sender's copy — dedup, single insert.
      writeMessage('sent', 'msg-20260904T120000-missing');
      listResponses = [['msg-20260904T100000-present'], ['msg-20260904T100000-present', 'msg-20260904T120000-missing']];

      const result = await run();

      expect(result.status).toBe('ok');
      expect(result.candidates).toBe(3); // 3 in-window files (the old one is excluded)
      expect(result.candidateIds).toBe(2); // deduped
      expect(result.alreadyPresent).toBe(1);
      expect(result.reconciled).toBe(1);
      expect(result.errors).toBe(0);
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0].id).toBe('msg-20260904T120000-missing');
      expect(insertedRows[0].from_machine).toBe('myia-po-2024'); // mapMessageToRow applied
    });

    test('no candidates → zero PG roundtrips', async () => {
      writeMessage('inbox', 'msg-20260801T000000-old'); // out of window only

      const result = await run();

      expect(result.candidates).toBe(0);
      expect(listCalls).toHaveLength(0);
      expect(result.reconciled).toBe(0);
    });

    test('everything present → listing happens, nothing is opened or inserted', async () => {
      writeMessage('inbox', 'msg-20260904T110000-synced');
      listResponses = [['msg-20260904T110000-synced']];

      const result = await run();

      expect(result.alreadyPresent).toBe(1);
      expect(result.reconciled).toBe(0);
      expect(insertedRows).toHaveLength(0);
      expect(listCalls).toHaveLength(1); // no post-insert listing — no work done
    });

    test('phantom guard: a file whose content id mismatches its name is skipped, not imported', async () => {
      writeMessage('inbox', 'msg-20260904T140000-named', { id: 'msg-20260904T140000-other' });
      listResponses = [[]];

      const result = await run();

      expect(result.skipped).toBe(1);
      expect(insertedRows).toHaveLength(0);
    });

    test('0-byte husk counts as an error and never aborts the pass', async () => {
      writeFileSync(join(messagesRoot, 'inbox', 'msg-20260904T160000-empty.json'), '', 'utf-8');
      // Second in-window missing file — proves iteration continued past the husk.
      writeMessage('inbox', 'msg-20260904T170000-good');
      listResponses = [[], ['msg-20260904T170000-good']];

      const result = await run();

      expect(result.errors).toBe(1);
      expect(insertedRows.map((r) => r.id)).toEqual(['msg-20260904T170000-good']);
    });

    test('strips a UTF-8 BOM before parsing', async () => {
      const id = 'msg-20260904T180000-bom';
      const json = JSON.stringify({ id, from: 'myia-web1', to: 'myia-po-2026', subject: 'bom', body: 'b', priority: 'LOW', status: 'unread', timestamp: '2026-09-04T18:00:00.000Z' });
      writeFileSync(join(messagesRoot, 'inbox', `${id}.json`), `\uFEFF${json}`, 'utf-8');
      listResponses = [[], [id]];

      const result = await run();

      expect(result.reconciled).toBe(1);
      expect(insertedRows).toHaveLength(1);
    });

    test('reconciled is the VERIFIED count (post-insert listing), not the attempt count', async () => {
      writeMessage('inbox', 'msg-20260904T190000-lost');
      // Post-insert listing still empty — PG "refused" the insert (mock).
      listResponses = [[], []];

      const result = await run();

      expect(insertedRows).toHaveLength(1);   // attempt was made
      expect(result.reconciled).toBe(0);      // but the honest count is 0
    });

    test('a missing mailbox dir is tolerated (fresh install)', async () => {
      rmSync(join(messagesRoot, 'archive'), { recursive: true, force: true });
      listResponses = [[]];

      const result = await run();

      expect(result.status).toBe('ok');
    });
  });

  describe('failure semantics', () => {
    test('a failed PG listing rejects the run — "unreachable" must not read as "0 present"', async () => {
      writeMessage('inbox', 'msg-20260904T200000-any');
      const writer = {
        listRooSyncMessageIds: () => Promise.reject(new Error('Connection terminated unexpectedly')),
        insertRooSyncMessage: async () => {},
      };

      await expect(
        reconcileChannelFromGDrive({ messagesRoot, lookbackDays: LOOKBACK_DAYS, now: NOW, writer })
      ).rejects.toThrow('Connection terminated unexpectedly');
    });

    test('a per-file insert failure counts as an error and the pass continues', async () => {
      writeMessage('inbox', 'msg-20260904T210000-bad');
      writeMessage('inbox', 'msg-20260904T220000-good');
      let first = true;
      let listCall = 0;
      const writer = {
        listRooSyncMessageIds: async () => listResponses[listCall++] ?? [],
        insertRooSyncMessage: async () => {
          if (first) { first = false; throw new Error('PG insert failed'); }
        },
      };
      listResponses = [[], ['msg-20260904T220000-good']];

      const result: ChannelReconcileResult = await reconcileChannelFromGDrive({
        messagesRoot, lookbackDays: LOOKBACK_DAYS, now: NOW, writer,
      });

      expect(result.errors).toBe(1);
      expect(result.reconciled).toBe(1);
    });
  });

  describe('#4131 item 4 — window by embedded date, undated included under a cap', () => {
    test('embeddedDateKeyFor: msg-* unchanged, date anywhere, time optional/padded', () => {
      // msg-* ids: the key IS the embedded timestamp the old lexicographic
      // comparison read — behavior for them must not change.
      expect(embeddedDateKeyFor('msg-20260904T120000-abc123')).toBe('20260904T120000');
      // Date deeper in the name, HHMM time — padded right to HHMMSS.
      expect(embeddedDateKeyFor('hermes-relance-repair-20260919T0624')).toBe('20260919T062400');
      // Date only — midnight.
      expect(embeddedDateKeyFor('po2026-audit73-final-20260921')).toBe('20260921T000000');
      // Trailing Z tolerated.
      expect(embeddedDateKeyFor('adjoint-repair-16399-20260916T1551Z')).toBe('20260916T155100');
    });

    test('embeddedDateKeyFor: a digit run inside a SHA is not a date', () => {
      // The lookarounds reject a calendar-shaped run that is part of a longer
      // digit run; the month/day ranges reject non-calendar shapes.
      expect(embeddedDateKeyFor('adjoint-6d0db3c1-4d8f-4a1e-9c6e-08d94f57a2f3')).toBeNull();
      expect(embeddedDateKeyFor('ledger-stack-preflight-16564-16574-16575')).toBeNull();
      expect(embeddedDateKeyFor('dispatch-mgs-120261021-po2027')).toBeNull(); // 8 digits inside a run
      expect(embeddedDateKeyFor('collision-20261332')).toBeNull(); // month 13 is not a month
      expect(embeddedDateKeyFor('collision-20260231-x')).toBe('20260231T000000'); // pattern-strict: day 31 passes — documented
    });

    test('a non-msg id with an embedded date is windowed by that date — no longer skipped forever', async () => {
      // Both carry 2026-09-04, inside the 7-day window of NOW (2026-09-05).
      writeMessage('inbox', 'hermes-relance-repair-20260904T0624');
      // This one carries 2026-08-01 — provably old, must not be a candidate.
      writeMessage('sent', 'ai01-oldbatch-20260801T0900');
      listResponses = [[], []]; // full listing: absent; window listing: absent; post: absent

      const result = await run();

      expect(result.candidateIds).toBe(1);
      expect(result.undatedCandidates).toBe(0);
      expect(insertedRows.map((r) => r.id)).toEqual(['hermes-relance-repair-20260904T0624']);
    });

    test('a non-msg id OUTSIDE the window is skipped exactly like an old msg-* id', async () => {
      writeMessage('inbox', 'hermes-old-20260801T0900');
      // The pre-fix behavior for this file: permanently outside (sorted
      // before every msg-*). The fix must not swing to "never old".
      writeMessage('inbox', 'msg-20260801T090000-old');

      const result = await run();

      expect(result.candidateIds).toBe(0);
      expect(listCalls).toHaveLength(0); // zero PG roundtrips — nothing in window
    });

    test('an undated id is INCLUDED, counted, and reconciled', async () => {
      // The B8-shaped historical hole: no date anywhere in the name. Pre-fix
      // this id sorted before every msg-* and was skipped by every pass.
      writeMessage('inbox', 'adjoint-order-16297-16300-v2');
      // Call order with undated present: full listing, window listing, post.
      listResponses = [[], [], ['adjoint-order-16297-16300-v2']];

      const result = await run();

      expect(result.undatedCandidates).toBe(1);
      expect(result.undatedCapped).toBe(0);
      expect(insertedRows.map((r) => r.id)).toEqual(['adjoint-order-16297-16300-v2']);
      expect(result.reconciled).toBe(1); // verified via the FULL post listing
      expect(listCalls).toEqual(['', 'msg-20260829T031833', '']);
    });

    test('an undated id ALREADY in PG (full listing) is not re-opened', async () => {
      writeMessage('inbox', 'adjoint-vision-15159-c445-v2');
      listResponses = [['adjoint-vision-15159-c445-v2']]; // full listing: present

      const result = await run();

      expect(result.undatedCandidates).toBe(1);
      expect(insertedRows).toHaveLength(0);
      // Presence is filtered BEFORE candidacy (that is what lets the cap
      // advance), so the id never enters byId — alreadyPresent stays 0 and
      // the pass needs no window listing at all.
      expect(result.alreadyPresent).toBe(0);
      expect(listCalls).toEqual(['']); // no window listing needed — byId empty
    });

    test('the cap bounds undated opens per pass and SHEDS the excess visibly', async () => {
      // UNDATED_CAP_PER_PASS + 2 undated ids, all missing from PG. Call order:
      // full listing, window listing (byId holds the cap'd undated), post.
      const ids = Array.from(
        { length: UNDATED_CAP_PER_PASS + 2 },
        (_, i) => `adjoint-batch-${String(i).padStart(4, '0')}`
      );
      for (const id of ids) writeMessage('sent', id);
      listResponses = [[], [], ids.slice(0, UNDATED_CAP_PER_PASS)];

      const result = await run();

      expect(result.undatedCandidates).toBe(UNDATED_CAP_PER_PASS + 2);
      expect(result.undatedCapped).toBe(2);
      expect(insertedRows).toHaveLength(UNDATED_CAP_PER_PASS);
      // Sorted order — the shed 2 are the tail; next pass they are the head.
      expect(insertedRows[0].id).toBe('adjoint-batch-0000');
      expect(insertedRows[UNDATED_CAP_PER_PASS - 1].id).toBe(`adjoint-batch-${String(UNDATED_CAP_PER_PASS - 1).padStart(4, '0')}`);
    });

    test('the cap ADVANCES: a healed undated id stops consuming a slot', async () => {
      // Pass 1: 1 id, missing → healed. Pass 2 (same pool + 1 new): the healed
      // id is in the full listing, so the new one takes a slot despite being
      // alphabetically AFTER the healed one.
      writeMessage('inbox', 'adjoint-keep-0001');
      writeMessage('inbox', 'adjoint-keep-0002');
      // Pass 1 responses: full=[0001 present? no → missing]... simpler: run
      // pass 1 with 0001 missing (heals it), pass 2 with 0001 present.
      listResponses = [[], [], ['adjoint-keep-0001']];
      const r1 = await run();
      expect(r1.reconciled).toBe(1);

      listCalls = [];
      insertedRows = [];
      listResponses = [['adjoint-keep-0001'], [], ['adjoint-keep-0002']];
      const r2 = await run();
      expect(insertedRows.map((r) => r.id)).toEqual(['adjoint-keep-0002']);
      // The healed 0001 was presence-filtered before candidacy — exactly the
      // advance under test (it no longer occupies a cap slot).
      expect(r2.alreadyPresent).toBe(0);
    });
  });
});
