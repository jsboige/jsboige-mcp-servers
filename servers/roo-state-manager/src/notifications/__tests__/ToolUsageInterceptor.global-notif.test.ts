/**
 * #3226(a) — ToolUsageInterceptor global dashboard footer wiring
 *
 * Verifies:
 * - background tick builds the global [NOTIF] footer when checkGlobal is on
 * - footer is annexed to the next tool response
 * - footer is dropped on a roosync_dashboard read of global (just-read staleness)
 * - footer survives unrelated roosync_dashboard calls (the push IS the feature)
 * - checkGlobal=false disables the check entirely
 * - inbox and global footers combine on one response
 */

import { test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockScanDiskForNewTasks, mockReadGlobalIntercomMessages, mockGetGlobalSeenCursor } = vi.hoisted(() => ({
  mockScanDiskForNewTasks: vi.fn().mockResolvedValue(undefined),
  mockReadGlobalIntercomMessages: vi.fn().mockResolvedValue(null),
  mockGetGlobalSeenCursor: vi.fn().mockResolvedValue('2026-08-25T10:00:00Z'),
}));

vi.mock('../../tools/task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDiskForNewTasks(...args),
}));

vi.mock('../../utils/message-helpers.js', () => ({
  getLocalWorkspaceId: () => 'test-workspace',
}));

// #3226: the real filter+footer are unit-tested in GlobalNotifState.test.ts.
// Here they are passthroughs so the wiring (tick → state → annex) is under test.
vi.mock('../GlobalNotifState.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getGlobalSeenCursor: (...args: any[]) => mockGetGlobalSeenCursor(...args),
  };
});

vi.mock('../../tools/roosync/dashboard.js', () => ({
  readGlobalIntercomMessages: (...args: any[]) => mockReadGlobalIntercomMessages(...args),
}));

import { ToolUsageInterceptor } from '../ToolUsageInterceptor.js';
import { NotificationService } from '../NotificationService.js';
import type { InterceptorConfig } from '../ToolUsageInterceptor.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

function makeConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
  return {
    machineId: 'test-machine',
    checkInbox: false,
    checkGlobal: true,
    refreshCache: false,
    minPriority: 'MEDIUM',
    ...overrides,
  };
}

function makeInterceptor(config: Partial<InterceptorConfig> = {}) {
  return new ToolUsageInterceptor(
    new NotificationService(),
    {
      readInbox: vi.fn().mockResolvedValue([]),
      getMessage: vi.fn().mockResolvedValue(null),
    } as any,
    new Map<string, ConversationSkeleton>(),
    makeConfig(config)
  );
}

/** Drive one background tick directly (deterministic — no fake-timer coupling). */
async function runTick(interceptor: ToolUsageInterceptor): Promise<void> {
  await (interceptor as any).backgroundInboxCheck();
}

function globalMessages() {
  return [
    {
      id: 'g1',
      timestamp: '2026-08-25T11:30:00Z', // 90 min before a 12:00 now — past grace
      author: { machineId: 'myia-web1', workspace: 'roo-extensions' },
      content: '[ERROR] embedding down',
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fake timers: (1) constructor timers never fire on their own, (2) the §4
  // grace period resolves against a deterministic Date.now().
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
  mockReadGlobalIntercomMessages.mockResolvedValue(null);
  mockGetGlobalSeenCursor.mockResolvedValue('2026-08-25T10:00:00Z');
});

afterEach(() => {
  vi.useRealTimers();
});

test('checkGlobal builds the [NOTIF] global footer and annexes it to the next tool response', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockResolvedValue(globalMessages());

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result');
  expect(result).toContain('raw-result');
  expect(result).toContain('[NOTIF] 1 nouveau(x) sur global depuis ta dernière lecture');
  expect(result).toContain('1 ERROR non résolu');
  expect(result).toContain('Lire : roosync_dashboard action:"read" type:"global"');
  // One-shot: the footer is consumed, the next response is clean.
  const next = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result-2');
  expect(next).toBe('raw-result-2');
  interceptor.dispose();
});

test('no notifiable messages → no footer annexed (zero cost when calm)', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockResolvedValue([
    {
      id: 'g1',
      timestamp: '2026-08-25T11:00:00Z',
      author: { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
      content: '[INFO] rien à signaler',
    },
  ]);

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result');
  expect(result).toBe('raw-result');
  interceptor.dispose();
});

test('footer is dropped on the very response of a global read (staleness)', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockResolvedValue(globalMessages());

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall(
    'roosync_dashboard',
    { action: 'read', type: 'global' },
    async () => 'global-content'
  );
  expect(result).toBe('global-content');
  interceptor.dispose();
});

test('footer survives a non-global dashboard call (that push is the feature)', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockResolvedValue(globalMessages());

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall(
    'roosync_dashboard',
    { action: 'read', type: 'workspace' },
    async () => 'workspace-content'
  );
  expect(result).toContain('[NOTIF] 1 nouveau(x) sur global');
  interceptor.dispose();
});

test('footer survives a dashboard append (cursor only advances on reads)', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockResolvedValue(globalMessages());

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall(
    'roosync_dashboard',
    { action: 'append', type: 'global' },
    async () => 'appended'
  );
  expect(result).toContain('[NOTIF] 1 nouveau(x) sur global');
  interceptor.dispose();
});

test('checkGlobal=false never touches the global dashboard', async () => {
  const interceptor = makeInterceptor({ checkGlobal: false });

  await runTick(interceptor);

  expect(mockReadGlobalIntercomMessages).not.toHaveBeenCalled();
  const result = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result');
  expect(result).toBe('raw-result');
  interceptor.dispose();
});

test('global dashboard absent (null) → no footer, no crash', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockResolvedValue(null);

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result');
  expect(result).toBe('raw-result');
  interceptor.dispose();
});

test('global check failure fails soft (footer cleared, next tick retries)', async () => {
  const interceptor = makeInterceptor();
  mockReadGlobalIntercomMessages.mockRejectedValue(new Error('GDrive FUSE hiccup'));

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result');
  expect(result).toBe('raw-result');
  interceptor.dispose();
});

test('inbox and global footers combine on one response', async () => {
  const interceptor = new ToolUsageInterceptor(
    new NotificationService(),
    {
      readInbox: vi.fn().mockResolvedValue([{ id: 'inbox-1' }]),
      getMessage: vi.fn().mockResolvedValue({
        id: 'inbox-1',
        from: 'myia-ai-01',
        to: 'test-machine',
        subject: 's',
        body: 'b',
        priority: 'HIGH',
        status: 'unread',
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
    } as any,
    new Map<string, ConversationSkeleton>(),
    makeConfig({ checkInbox: true })
  );
  mockReadGlobalIntercomMessages.mockResolvedValue(globalMessages());

  await runTick(interceptor);

  const result = await interceptor.interceptToolCall('conversation_browser', {}, async () => 'raw-result');
  expect(result).toContain('[NOTIF] 1 message(s) non lu(s) en inbox');
  expect(result).toContain('[NOTIF] 1 nouveau(x) sur global');
  // Inbox line first (existing behavior), global line after.
  expect(result.indexOf('message(s) non lu(s)')).toBeLessThan(result.indexOf('nouveau(x) sur global'));
  interceptor.dispose();
});
