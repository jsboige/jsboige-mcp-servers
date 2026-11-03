/**
 * #4131 Phase D — the CallTool dispatch must resolve the backfill marker
 * BEFORE a shared-store tool decides where to write.
 *
 * Measured on ai-01, 03/11 04:35:18Z and 05:28:34Z: two `roosync_send` calls
 * from MCP hosts started in that same second landed on the G: files
 * (`Message saved to inbox: G:\…`) while every other send of the day went to
 * PG. The marker cache of a fresh process reads 'unknown', and 'unknown'
 * closes the PRIMARY gates, so the first write of a cold host took the file
 * path.
 *
 * These tests run the REAL CallTool handler and the REAL pg-backfill-marker
 * module; only `pg` (the marker lookup's client), MessageManager and the
 * dashboard/capability helpers are mocked. The send mock records the marker
 * state AT THE MOMENT the send runs, which is the state the PRIMARY gates
 * would read.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendMessage = vi.hoisted(() => vi.fn());
const pgState = vi.hoisted(() => ({
  connects: 0,
  fail: false,
  rows: [] as Array<{ key: string; value: string }>,
}));

// The marker lookup's short-lived client (pg-backfill-marker.ts readMetaValues).
vi.mock('pg', () => {
  class Client {
    async connect(): Promise<void> {
      pgState.connects++;
      // A real lookup takes wall-clock time. 200 ms is longer than the whole
      // (warmed) send path, so a dispatch that does not await the lookup has
      // already sent when it lands.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (pgState.fail) throw new Error('connect ECONNREFUSED');
    }
    async query(): Promise<{ rows: Array<{ key: string; value: string }> }> {
      return { rows: pgState.rows };
    }
    async end(): Promise<void> {}
  }
  return { default: { Client } };
});

vi.mock('../../services/MessageManager.js', () => ({
  getMessageManager: () => ({
    sendMessage: mockSendMessage,
  }),
}));

vi.mock('../../services/lazy-roosync.js', () => ({
  getRooSyncService: async () => ({
    getHeartbeatService: () => ({ registerHeartbeat: async () => undefined }),
  }),
}));

vi.mock('../../utils/dashboard-helpers.js', async () => {
  const actual = await vi.importActual('../../utils/dashboard-helpers.js');
  return {
    ...(actual as object),
    updateDashboardActivityAsync: async () => undefined,
  };
});

// roosync_send requires the 'sharedPath' capability; without this mock the
// capability guard would block the tool before the marker step in tests.
vi.mock('../../utils/server-capabilities.js', () => ({
  getServerCapabilities: () => ({
    isAvailable: () => true,
    getDegradedReason: () => '',
  }),
}));

import { registerCallToolHandler } from '../registry.js';
import {
  getBackfillMarkerState,
  setBackfillMarkerState,
  CHANNEL_BACKFILL_META_KEY,
  DASHBOARD_BACKFILL_META_KEY,
  type BackfillMarkerState,
} from '../../services/unified-store/pg-backfill-marker.js';

type Handler = (request: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const SEND = {
  params: {
    name: 'roosync_send',
    arguments: { action: 'send', to: 'myia-ai-01', subject: 'S', body: 'B' },
  },
};

describe('CallTool dispatch resolves the backfill marker before a shared-store write (#4131 Phase D)', () => {
  let handler: Handler;
  let savedUrl: string | undefined;
  let stateAtSend: BackfillMarkerState[];

  beforeEach(() => {
    savedUrl = process.env.UNIFIED_STORE_PG_URL;
    process.env.UNIFIED_STORE_PG_URL = 'postgres://marker-test.invalid/db';
    pgState.connects = 0;
    pgState.fail = false;
    pgState.rows = [
      { key: CHANNEL_BACKFILL_META_KEY, value: '2026-10-27T21:10:00Z' },
      { key: DASHBOARD_BACKFILL_META_KEY, value: '2026-10-27T22:01:00Z' },
    ];
    // A fresh process: nothing looked up yet.
    setBackfillMarkerState('channel', 'unknown');
    setBackfillMarkerState('dashboard', 'unknown');

    stateAtSend = [];
    mockSendMessage.mockReset();
    mockSendMessage.mockImplementation(async (from: string) => {
      stateAtSend.push(getBackfillMarkerState('channel'));
      return {
        id: 'msg-cold-start-1',
        from,
        to: 'myia-ai-01',
        subject: 'S',
        priority: 'MEDIUM',
        timestamp: new Date().toISOString(),
      };
    });

    const mockServer = { setRequestHandler: vi.fn() };
    const mockState = {
      conversationCache: new Map(),
      qdrantIndexQueue: new Set(),
      isQdrantIndexingEnabled: false,
      xmlExporterService: {},
      exportConfigManager: {},
    } as any;
    registerCallToolHandler(
      mockServer as any,
      mockState,
      vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Settings touched' }] }),
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue(undefined)
    );
    handler = mockServer.setRequestHandler.mock.calls[0][1];
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.UNIFIED_STORE_PG_URL;
    else process.env.UNIFIED_STORE_PG_URL = savedUrl;
  });

  test('cold host: the first send sees the marker as complete, never unknown', async () => {
    // Warm the handler's lazy imports first: a cold `import()` of the send
    // module takes longer than the lookup and would hide the race.
    setBackfillMarkerState('channel', 'complete');
    setBackfillMarkerState('dashboard', 'complete');
    await handler(SEND);
    mockSendMessage.mockClear();
    stateAtSend = [];

    // Now a fresh process's marker cache. Never read it synchronously here:
    // getBackfillMarkerState() on 'unknown' starts the lookup itself.
    setBackfillMarkerState('channel', 'unknown');
    setBackfillMarkerState('dashboard', 'unknown');
    pgState.connects = 0;

    const result = await handler(SEND);

    expect(result.isError).toBeFalsy();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(stateAtSend).toEqual(['complete']);
    expect(pgState.connects).toBe(1);
  });

  test('warm host: a fresh marker costs no lookup before the send', async () => {
    setBackfillMarkerState('channel', 'complete');
    setBackfillMarkerState('dashboard', 'complete');

    await handler(SEND);

    expect(pgState.connects).toBe(0);
    expect(stateAtSend).toEqual(['complete']);
  });

  test('PG unreachable at cold start: the tool still runs on the fail-safe answer, one lookup per TTL', async () => {
    pgState.fail = true;

    const first = await handler(SEND);
    const second = await handler(SEND);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    // An unproven scope stays on GDrive when the lookup fails (unchanged rule).
    expect(stateAtSend).toEqual(['absent', 'absent']);
    // The failed lookup is cached for the TTL: the outage costs one lookup,
    // not one per call.
    expect(pgState.connects).toBe(1);
  });

  test('a tool without the shared-store capability never triggers the lookup', async () => {
    const result = await handler({ params: { name: 'touch_mcp_settings', arguments: {} } });

    expect(result.content[0].text).toContain('Settings touched');
    expect(pgState.connects).toBe(0);
  });
});
