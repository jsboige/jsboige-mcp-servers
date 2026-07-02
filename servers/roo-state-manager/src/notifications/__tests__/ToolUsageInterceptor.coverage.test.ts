/**
 * #833 Sprint C3 — ToolUsageInterceptor branch coverage (po-2026 lane `notifications/**`)
 *
 * The existing `ToolUsageInterceptor.test.ts` (35 tests) covers the footer
 * annexation for two result shapes — plain `string` (L251-253) and the MCP
 * text-content array `[{type:'text', text}]` (L257-261). The private
 * `appendFooter` helper (source L250-285) has FIVE more result-shape branches
 * that are never exercised, so a regression in any of them would pass silently:
 *
 * - generic array (non text-content) → append a `{type:'text', text:footer}`
 *   element (source L263)
 * - object with `content: string` → append to the string (source L269-270)
 * - object with `content: Array` whose last element has `.text` → append to it
 *   (source L274-275)
 * - object with `content: Array` whose last element has NO `.text` → push a new
 *   text element (source L276-278)
 * - fallback (number / null / undefined / unhandled) → return result unchanged,
 *   footer skipped (source L283-284)
 *
 * These are reached indirectly: populate `pendingFooter` via a background inbox
 * check (unread messages), then call `interceptToolCall` with each result shape.
 * Every assertion is anchored on a source line of `ToolUsageInterceptor.ts`.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockScanDiskForNewTasks } = vi.hoisted(() => ({
  mockScanDiskForNewTasks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../tools/task/disk-scanner.js', () => ({
  scanDiskForNewTasks: (...args: any[]) => mockScanDiskForNewTasks(...args),
}));

vi.mock('../../utils/message-helpers.js', () => ({
  getLocalWorkspaceId: () => 'test-workspace',
}));

import { ToolUsageInterceptor } from '../ToolUsageInterceptor.js';
import { NotificationService } from '../NotificationService.js';
import type { InterceptorConfig } from '../ToolUsageInterceptor.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeConfig(overrides: Partial<InterceptorConfig> = {}): InterceptorConfig {
  return {
    machineId: 'test-machine',
    checkInbox: false,
    refreshCache: false,
    minPriority: 'LOW',
    ...overrides,
  };
}

function makeMockMessageManager(
  unreadItems: Array<{ id: string }> = [],
  messageMap: Record<string, any> = {}
) {
  return {
    readInbox: vi.fn().mockResolvedValue(unreadItems),
    getMessage: vi.fn((id: string) => Promise.resolve(messageMap[id] ?? null)),
  };
}

function makeMessage(overrides: any = {}) {
  return {
    id: 'msg-1',
    from: 'myia-ai-01',
    to: 'test-machine',
    subject: 'Test subject',
    body: 'Test body',
    priority: 'MEDIUM' as const,
    status: 'unread' as const,
    timestamp: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

let notificationService: NotificationService;
let conversationCache: Map<string, ConversationSkeleton>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  notificationService = new NotificationService();
  conversationCache = new Map();
  mockScanDiskForNewTasks.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Build an interceptor with one unread message → pendingFooter populated after background tick. */
async function buildInterceptorWithPendingFooter() {
  const msg = makeMessage({ id: 'msg-1' });
  const msgManager = makeMockMessageManager([{ id: 'msg-1' }], { 'msg-1': msg });
  const interceptor = new ToolUsageInterceptor(
    notificationService,
    msgManager as any,
    conversationCache,
    makeConfig({ checkInbox: true, minPriority: 'LOW' })
  );
  // Populate pendingFooter via the background inbox check.
  await vi.advanceTimersByTimeAsync(6_000);
  await flushMicrotasks();
  return { interceptor, msgManager };
}

describe('ToolUsageInterceptor — appendFooter result-shape branch coverage (#833 C3, source-grounded)', () => {

  // ── appendFooter: generic (non text-content) array (source L263) ──

  test('appends a text element to a generic (non text-content) array result (L263)', async () => {
    const { interceptor } = await buildInterceptorWithPendingFooter();

    // A plain array whose first element is NOT an MCP text-content object.
    const genericArray = ['just-a-string', 42];
    const result: any = await interceptor.interceptToolCall('tool', {}, async () => genericArray);

    expect(Array.isArray(result)).toBe(true);
    // L263: `[...result, { type: 'text', text: footer }]` — original elements preserved + 1 appended.
    expect(result.length).toBe(3);
    expect(result[0]).toBe('just-a-string');
    expect(result[1]).toBe(42);
    // The appended element carries the footer text.
    expect(result[2].type).toBe('text');
    expect(result[2].text).toContain('[NOTIF]');

    interceptor.dispose();
  });

  // ── appendFooter: object with content: string (source L269-270) ──

  test('appends footer to an object result whose content is a string (L269-270)', async () => {
    const { interceptor } = await buildInterceptorWithPendingFooter();

    const objResult = { content: 'original-content', meta: 'keep' };
    const result: any = await interceptor.interceptToolCall('tool', {}, async () => objResult);

    // L270: `{ ...obj, content: obj.content + footer }` — content extended, meta preserved.
    expect(result.meta).toBe('keep');
    expect(result.content).toContain('original-content');
    expect(result.content).toContain('[NOTIF]');

    interceptor.dispose();
  });

  // ── appendFooter: object with content: Array, last element has .text (source L274-275) ──

  test('appends footer to the last .text of an object.content array (L274-275)', async () => {
    const { interceptor } = await buildInterceptorWithPendingFooter();

    const objResult = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'last-element' },
      ],
    };
    const result: any = await interceptor.interceptToolCall('tool', {}, async () => objResult);

    // L275: last element's `.text` gets the footer appended.
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain('last-element');
    expect(result.content[1].text).toContain('[NOTIF]');
    // First element untouched.
    expect(result.content[0].text).toBe('first');

    interceptor.dispose();
  });

  // ── appendFooter: object with content: Array, last element has NO .text → push (source L276-278) ──

  test('pushes a new text element when object.content last item has no .text (L276-278)', async () => {
    const { interceptor } = await buildInterceptorWithPendingFooter();

    const objResult = {
      content: [
        { type: 'image', data: 'base64...' }, // last element has NO `.text` string
      ],
    };
    const result: any = await interceptor.interceptToolCall('tool', {}, async () => objResult);

    // L277-278: a `{ type: 'text', text: footer }` element is pushed onto content.
    expect(result.content).toHaveLength(2);
    expect(result.content[1].type).toBe('text');
    expect(result.content[1].text).toContain('[NOTIF]');
    // Original element preserved.
    expect(result.content[0].type).toBe('image');

    interceptor.dispose();
  });

  // ── appendFooter: fallback (non-appendable result) → unchanged (source L283-284) ──

  test('returns result unchanged when shape is not appendable — number (L284 fallback)', async () => {
    const { interceptor } = await buildInterceptorWithPendingFooter();

    // A number result hits NONE of the string/array/object branches → fallback.
    const result: any = await interceptor.interceptToolCall('tool', {}, async () => 42);

    // L284: `return result` — footer skipped, value unchanged.
    expect(result).toBe(42);

    interceptor.dispose();
  });

  test('returns result unchanged when shape is not appendable — null (L284 fallback)', async () => {
    const { interceptor } = await buildInterceptorWithPendingFooter();

    const result: any = await interceptor.interceptToolCall('tool', {}, async () => null);

    // null is not string/array/non-null object → fallback returns it as-is.
    expect(result).toBeNull();

    interceptor.dispose();
  });

  // ── refreshConversationCache: explicit throw path propagated via fire-and-forget catch ──
  // (interceptToolCall must stay non-blocking even when scanDiskForNewTasks rejects)

  test('interceptToolCall stays non-blocking when refreshConversationCache throws (L108-110 + L144-147)', async () => {
    mockScanDiskForNewTasks.mockRejectedValue(new Error('disk scan boom'));
    const interceptor = new ToolUsageInterceptor(
      notificationService,
      makeMockMessageManager() as any,
      conversationCache,
      makeConfig({ refreshCache: true })
    );

    // The result must still be returned despite the cache-refresh throw.
    const result = await interceptor.interceptToolCall('tool', {}, async () => 'survived');
    await vi.advanceTimersByTimeAsync(50);

    expect(result).toBe('survived');

    interceptor.dispose();
  });
});
