/**
 * #4131 B17 — markCliMessageReadInPg, the worker-side mark-read contract.
 *
 * The scheduled worker reads its inbox as a BARE machine id (no workspace)
 * while the lane's interactive session marks read as machine:workspace — two
 * distinct per-reader states. Without a worker-side write, a PG [TASK] the
 * worker served re-fires every cycle (6 servings in 30 h measured on ai-01).
 * The contract under test (must mirror MessageManager.markAsRead's PG branch):
 *   - gate off          → {source:'file', reason:'gate-off'}
 *   - unknown row       → {source:'pg', written:false, reason:'not-found'}
 *   - already read      → {source:'pg', written:true, alreadyRead:true} — no write
 *   - guard rejected    → {source:'pg', written:false, reason:'denied'} (#2287)
 *   - update persisted  → {source:'pg', written:true} with the same field
 *                          selection as the MCP path (read_by / read_by_workspace
 *                          / global flip + read_at, options carried)
 *   - update a no-op    → {source:'pg', written:false, reason:'update-not-persisted'}
 *   - reader closed exactly once on every acquired path
 *
 * Same fake-reader seam as cli-inbox-read-4131.test.ts; the PG UPDATE is
 * stubbed by mocking roosync-channel-write.js (the only symbol channel-read
 * imports from it).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RooSyncMessageRow } from '../../../../src/services/unified-store/types.js';

const { mockGetUnifiedStoreReader, mockResetReaderInstance, mockMessageById, mockClose, mockUpdatePrimary } =
  vi.hoisted(() => ({
    mockGetUnifiedStoreReader: vi.fn(),
    mockResetReaderInstance: vi.fn(),
    /** Row the PG reader returns for getRooSyncMessageById(id). */
    mockMessageById: vi.fn(),
    /** close() on the fake reader — the helper must call it before returning. */
    mockClose: vi.fn(),
    /** updateRooSyncMessagePrimary stub — false means the UPDATE wrote nothing. */
    mockUpdatePrimary: vi.fn(),
  }));

vi.mock('../../../../src/services/unified-store/reader-factory.js', () => ({
  getUnifiedStoreReader: () =>
    mockGetUnifiedStoreReader() ?? {
      isNull: () => false,
      getRooSyncMessageById: async (id: string) =>
        (await mockMessageById(id)) as RooSyncMessageRow | null,
      close: mockClose,
    },
  resetReaderInstance: mockResetReaderInstance,
}));

vi.mock('../../../../src/services/unified-store/roosync-channel-write.js', () => ({
  // channel-read only imports updateRooSyncMessagePrimary from this module;
  // the real file's other exports are irrelevant to the contract under test.
  updateRooSyncMessagePrimary: mockUpdatePrimary,
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { markCliMessageReadInPg } from '../../../../src/services/unified-store/roosync-channel-read.js';
import { setBackfillMarkerState } from '../../../../src/services/unified-store/pg-backfill-marker.js';

const MACHINE = 'myia-ai-01';

function row(overrides: Partial<RooSyncMessageRow> & Pick<RooSyncMessageRow, 'id' | 'to_machine'>): RooSyncMessageRow {
  return {
    thread_id: null,
    from_machine: 'myia-po-2025',
    from_workspace: '',
    to_workspace: '',
    subject: '[TASK] c.2372',
    body: 'instructions',
    priority: 'HIGH',
    status: 'unread',
    tags: ['TASK'],
    attachment_refs: [],
    created_at: '2026-10-25T12:00:00Z',
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    options: { tags: ['TASK'] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Marqueur de backfill : état FRAIS (jamais 'unknown') pour qu'aucune
  // consultation PG ne parte pendant le test (le helper CLI attend le
  // marqueur avant de décider).
  setBackfillMarkerState('channel', 'absent');
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgresql://test/test';
  mockUpdatePrimary.mockResolvedValue(true);
});

afterEach(() => {
  setBackfillMarkerState('channel', 'absent');
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
});

describe('markCliMessageReadInPg (#4131 B17)', () => {
  it('gate off → source file, reason gate-off, no reader acquired', async () => {
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_PG_URL;

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-1');

    expect(result).toEqual({ source: 'file', reason: 'gate-off' });
    expect(mockMessageById).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('unknown row → written:false, reason not-found, reader closed', async () => {
    mockMessageById.mockResolvedValue(null);

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-gone');

    expect(result).toEqual({ source: 'pg', written: false, reason: 'not-found' });
    expect(mockUpdatePrimary).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  // THE bug B17 fixes: a machine-wide [TASK] the bare-machine worker served.
  // The MCP path tracks machine-wide readers per WORKSPACE (read_by_workspace)
  // and only flips the global status when the reader HAS no workspace — the
  // worker-side write must select the exact same fields.
  it('machine-wide target + bare-machine reader → global status flip, options carried', async () => {
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-task', to_machine: MACHINE, status: 'unread' })
    );

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-task');

    expect(result).toEqual({ source: 'pg', written: true });
    expect(mockUpdatePrimary).toHaveBeenCalledTimes(1);
    const [id, fields] = mockUpdatePrimary.mock.calls[0];
    expect(id).toBe('msg-task');
    expect(fields.status).toBe('read');
    expect(fields.read_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(fields.read_by).toBeUndefined();
    expect(fields.read_by_workspace).toBeUndefined();
    // options carried so the UPDATE does not clobber them (MCP-path parity):
    // the payload is REBUILT from the mutated message, so the reader's ack
    // timestamp — set in memory by applyReadTracking — persists through it.
    expect(fields.options).toMatchObject({
      acknowledged_at: { [MACHINE]: expect.stringMatching(/^\d{4}-/) },
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('machine-wide target + workspace reader → read_by_workspace append', async () => {
    mockMessageById.mockResolvedValue(
      row({
        id: 'msg-wide',
        to_machine: MACHINE,
        // Machine-wide: no to_workspace on the row; OTHER workspaces' reads
        // already live in read_by_workspace, the new one appends there.
        read_by: [MACHINE],
        read_by_workspace: ['myia-po-2025:CoursIA'],
      })
    );

    const result = await markCliMessageReadInPg(MACHINE, 'roo-extensions', 'msg-wide');

    expect(result).toEqual({ source: 'pg', written: true });
    const [, fields] = mockUpdatePrimary.mock.calls[0];
    expect(fields.status).toBeUndefined();
    expect(fields.read_by_workspace).toEqual(
      expect.arrayContaining(['myia-po-2025:CoursIA', 'myia-ai-01:roo-extensions'])
    );
    expect(fields.read_by).toBeUndefined();
  });

  it('broadcast target → read_by append, no global flip', async () => {
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-all', to_machine: 'all', read_by: ['myia-po-2025'] })
    );

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-all');

    expect(result).toEqual({ source: 'pg', written: true });
    const [, fields] = mockUpdatePrimary.mock.calls[0];
    expect(fields.read_by).toEqual(['myia-po-2025', MACHINE]);
    expect(fields.status).toBeUndefined();
  });

  it('targeted machine:workspace message, matching reader → global flip', async () => {
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-ws', to_machine: MACHINE, to_workspace: 'roo-extensions' })
    );

    const result = await markCliMessageReadInPg(MACHINE, 'roo-extensions', 'msg-ws');

    expect(result).toEqual({ source: 'pg', written: true });
    const [, fields] = mockUpdatePrimary.mock.calls[0];
    expect(fields.status).toBe('read');
  });

  it('already read for this reader → written:true alreadyRead:true, NO write', async () => {
    // Machine-wide row another workspace already read: perReaderStatus for the
    // bare-machine reader is the fallback verdict, which mapRowToMessage must
    // surface as 'read' only when the global status already flipped.
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-done', to_machine: MACHINE, status: 'read' })
    );

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-done');

    expect(result).toEqual({ source: 'pg', written: true, alreadyRead: true });
    expect(mockUpdatePrimary).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('workspace-mismatch guard rejects → written:false, reason denied (#2287)', async () => {
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-other-ws', to_machine: MACHINE, to_workspace: 'other-ws' })
    );

    const result = await markCliMessageReadInPg(MACHINE, 'roo-extensions', 'msg-other-ws');

    expect(result).toEqual({ source: 'pg', written: false, reason: 'denied' });
    expect(mockUpdatePrimary).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('non-recipient reader rejected → written:false, reason denied', async () => {
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-po2024', to_machine: 'myia-po-2024' })
    );

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-po2024');

    expect(result).toEqual({ source: 'pg', written: false, reason: 'denied' });
    expect(mockUpdatePrimary).not.toHaveBeenCalled();
  });

  it('UPDATE wrote nothing (rowCount 0) → written:false, reason update-not-persisted', async () => {
    mockMessageById.mockResolvedValue(row({ id: 'msg-1', to_machine: MACHINE }));
    mockUpdatePrimary.mockResolvedValue(false);

    const result = await markCliMessageReadInPg(MACHINE, undefined, 'msg-1');

    expect(result).toEqual({ source: 'pg', written: false, reason: 'update-not-persisted' });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('combined machine:workspace --machine form parses — the workspace reaches the reader id', async () => {
    mockMessageById.mockResolvedValue(
      row({ id: 'msg-combined', to_machine: MACHINE, to_workspace: 'roo-extensions' })
    );

    const result = await markCliMessageReadInPg(`${MACHINE}:roo-extensions`, undefined, 'msg-combined');

    expect(result).toEqual({ source: 'pg', written: true });
    const [, fields] = mockUpdatePrimary.mock.calls[0];
    // Machine-wide tracking did NOT kick in (targeted message): global flip.
    expect(fields.status).toBe('read');
  });
});
