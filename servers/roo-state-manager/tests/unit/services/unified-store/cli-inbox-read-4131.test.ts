/**
 * #4131 B14 — readCliInboxFromPg, the CLI contract for the scheduled workers.
 *
 * start-claude-worker.ps1 goes file-blind under CHANNEL_PG_PRIMARY; this is
 * the helper its future shell-out (`scripts/read-roosync-inbox.mjs`) calls.
 * The contract under test:
 *   - gate off  → {source:'file', reason:'gate-off'}   (caller keeps files)
 *   - PG rows   → {source:'pg', messages} full fidelity, per-reader status
 *   - PG down   → {source:'file', reason:'pg-unavailable'}
 *   - empty PG  → {source:'pg', messages:[]}  — authoritative, NOT a fallback
 *   - reader closed exactly once on every acquired path (CLI must not hang)
 *
 * Same fake-reader seam as channel-pg-paths-4302.test.ts: the factory is
 * mocked, env vars drive the gate, no GDrive store exists anywhere in the
 * test — any message can only come from the (fake) PG reader.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RooSyncMessageRow } from '../../../../src/services/unified-store/types.js';

const { mockGetUnifiedStoreReader, mockResetReaderInstance, mockMailbox, mockClose } =
  vi.hoisted(() => ({
    mockGetUnifiedStoreReader: vi.fn(),
    mockResetReaderInstance: vi.fn(),
    /** Rows the PG reader would return for the machine (machine + 'all', newest first). */
    mockMailbox: vi.fn(),
    /** close() on the fake reader — the helper must call it before returning. */
    mockClose: vi.fn(),
  }));

vi.mock('../../../../src/services/unified-store/reader-factory.js', () => ({
  getUnifiedStoreReader: () =>
    mockGetUnifiedStoreReader() ?? {
      isNull: () => false,
      getRooSyncMailbox: async (machineId: string) =>
        (await mockMailbox(machineId)) as RooSyncMessageRow[],
      close: mockClose,
    },
  resetReaderInstance: mockResetReaderInstance,
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { readCliInboxFromPg } from '../../../../src/services/unified-store/roosync-channel-read.js';

const MACHINE = 'myia-po-2024';

function row(overrides: Partial<RooSyncMessageRow> & Pick<RooSyncMessageRow, 'id' | 'to_machine'>): RooSyncMessageRow {
  return {
    thread_id: null,
    from_machine: 'myia-ai-01',
    from_workspace: '',
    to_workspace: '',
    subject: 'sujet',
    body: 'corps',
    priority: 'MEDIUM',
    status: 'unread',
    tags: [],
    attachment_refs: [],
    created_at: '2026-10-21T23:30:00Z',
    reply_to: null,
    read_by: [],
    read_by_workspace: [],
    options: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
  process.env.UNIFIED_STORE_PG_URL = 'postgresql://test/test';
});

afterEach(() => {
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
});

describe('readCliInboxFromPg (#4131 B14)', () => {
  it('gate off → source file, reason gate-off, no reader acquired', async () => {
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_PG_URL;

    const result = await readCliInboxFromPg(MACHINE);

    expect(result).toEqual({ source: 'file', reason: 'gate-off' });
    expect(mockMailbox).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('serves full messages from PG with every field the worker filters on', async () => {
    mockMailbox.mockResolvedValue([
      row({
        id: 'msg-1',
        to_machine: MACHINE,
        subject: '[TASK] File c.35',
        body: 'instructions',
        priority: 'HIGH',
        status: 'read',
        tags: ['TASK', '4131'],
      }),
      // Candidate row the reader may return but recipient matching must drop:
      // addressed to another workspace of this machine.
      row({ id: 'msg-2', to_machine: MACHINE, to_workspace: 'other-ws' }),
    ]);

    const result = await readCliInboxFromPg(MACHINE, 'roo-extensions');

    expect(result).toMatchObject({ source: 'pg' });
    if (result.source !== 'pg') throw new Error('unreachable');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'msg-1',
      from: 'myia-ai-01',
      to: MACHINE,
      subject: '[TASK] File c.35',
      body: 'instructions',
      priority: 'HIGH',
      status: 'read',
      timestamp: '2026-10-21T23:30:00Z',
      tags: ['TASK', '4131'],
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('adjusts broadcast status per reader — a read_by broadcast is not re-fired', async () => {
    mockMailbox.mockResolvedValue([
      row({ id: 'msg-broadcast', to_machine: 'all', status: 'unread', read_by: [MACHINE] }),
      row({ id: 'msg-direct', to_machine: MACHINE, status: 'unread' }),
    ]);

    const result = await readCliInboxFromPg(MACHINE);

    if (result.source !== 'pg') throw new Error('expected pg');
    const byId = Object.fromEntries(result.messages.map((m) => [m.id, m.status]));
    // Raw global status would say unread; the worker would re-fire on it (#629).
    expect(byId['msg-broadcast']).toBe('read');
    // Non-broadcast rows keep the raw status (perReaderStatus returns null).
    expect(byId['msg-direct']).toBe('unread');
  });

  it('bare-machine call stays blind to workspace-targeted rows (parity with the worker filter)', async () => {
    // The file-based Get-RooSyncTask only accepts `to -eq $MachineId -or 'all'`;
    // matchesRecipient returns false for machine:ws targets without a local
    // workspace qualifier (message-helpers l.528). The CLI must not widen that.
    mockMailbox.mockResolvedValue([
      row({ id: 'msg-ws', to_machine: MACHINE, to_workspace: 'other-ws' }),
      row({ id: 'msg-machine', to_machine: MACHINE }),
    ]);

    const result = await readCliInboxFromPg(MACHINE);

    if (result.source !== 'pg') throw new Error('expected pg');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('msg-machine');
    expect(result.messages[0].to).toBe(MACHINE);
  });

  it('empty mailbox is an authoritative empty pg answer, not a fallback', async () => {
    mockMailbox.mockResolvedValue([]);

    const result = await readCliInboxFromPg(MACHINE);

    expect(result).toEqual({ source: 'pg', messages: [] });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('PG failure → source file, reason pg-unavailable, reader still closed', async () => {
    mockMailbox.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await readCliInboxFromPg(MACHINE);

    expect(result).toEqual({ source: 'file', reason: 'pg-unavailable' });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('CHANNEL_PG_PRIMARY implies the read gate (Phase D parity)', async () => {
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    mockMailbox.mockResolvedValue([]);

    const result = await readCliInboxFromPg(MACHINE);

    expect(result).toEqual({ source: 'pg', messages: [] });
  });

  // --- review head cad920f5 (Hermes) — F1: the combined machine:workspace
  // form is documented by --help; on the pre-fix head it silently produced an
  // authoritative EMPTY inbox (canonicalMachineId does not split, so
  // matchesRecipient rejected everything but 'all').
  it('combined machine:workspace form parses (#3177) — machine-wide and own-ws visible, other-ws dropped', async () => {
    mockMailbox.mockResolvedValue([
      row({ id: 'mw', to_machine: MACHINE, subject: '[TASK] machine-wide' }),
      row({ id: 'own-ws', to_machine: MACHINE, to_workspace: 'roo-extensions' }),
      row({ id: 'other-ws', to_machine: MACHINE, to_workspace: 'other-ws' }),
    ]);

    const result = await readCliInboxFromPg(`${MACHINE}:roo-extensions`);

    if (result.source !== 'pg') throw new Error('expected pg');
    expect(result.messages.map((m) => m.id).sort()).toEqual(['mw', 'own-ws']);
  });

  it('explicit workspace qualifier wins over the combined suffix', async () => {
    mockMailbox.mockResolvedValue([
      row({ id: 'mw', to_machine: MACHINE }),
      row({ id: 'explicit-ws', to_machine: MACHINE, to_workspace: 'explicit-ws' }),
      row({ id: 'suffix-ws', to_machine: MACHINE, to_workspace: 'ignored-suffix' }),
    ]);

    const result = await readCliInboxFromPg(`${MACHINE}:ignored-suffix`, 'explicit-ws');

    if (result.source !== 'pg') throw new Error('expected pg');
    expect(result.messages.map((m) => m.id).sort()).toEqual(['explicit-ws', 'mw']);
  });

  // --- review head cad920f5 (Hermes) — F2: the CLI runs at worker boot, the
  // coldest moment of the PG pool (#4303); the mailbox enumeration must carry
  // the same bounded resume its count sibling already has.
  it('cold-pool connection timeout resumes once before any fallback (parity with countChannelInboxFromPg)', async () => {
    mockMailbox
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce([row({ id: 'msg-1', to_machine: MACHINE })]);

    const result = await readCliInboxFromPg(MACHINE);

    if (result.source !== 'pg') throw new Error('expected pg');
    expect(result.messages.map((m) => m.id)).toEqual(['msg-1']);
    expect(mockMailbox).toHaveBeenCalledTimes(2);
  });
});
