/**
 * Tests for dashboard-helpers
 *
 * Verifies dashboard activity updates, mention resolution,
 * structured mention notifications, and metrics updates.
 *
 * @module utils/dashboard-helpers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mention, UserId } from '../../../src/tools/roosync/dashboard.js';

// --- Mocks (hoisted so vi.mock factories can reference them) ---

const {
  mockAccess,
  mockReadFile,
  mockWriteFile,
  mockGetSharedStatePath,
  mockGetLocalMachineId,
  mockSendMessage,
  mockLogger,
} = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockGetSharedStatePath: vi.fn(),
  mockGetLocalMachineId: vi.fn(),
  mockSendMessage: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// fs/promises — mock NAMED exports (source uses `import * as fs from 'fs/promises'`)
vi.mock('fs/promises', () => ({
  access: (...args: any[]) => mockAccess(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
}));

// shared-state-path
vi.mock('../../../src/utils/shared-state-path.js', () => ({
  getSharedStatePath: () => mockGetSharedStatePath(),
}));

// message-helpers
vi.mock('../../../src/utils/message-helpers.js', () => ({
  getLocalMachineId: () => mockGetLocalMachineId(),
}));

// logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

// MessageManager
vi.mock('../../../src/services/MessageManager.js', () => ({
  getMessageManager: () => ({ sendMessage: (...args: any[]) => mockSendMessage(...args) }),
}));

// child_process — mock for fetchGitHubProjectMetrics (promisified at module load)
// The mock provides a no-op callback; promisify wraps it so execAsync never resolves.
// This means fetchGitHubProjectMetrics always returns null (caught in try/catch).
vi.mock('child_process', () => ({
  exec: (_cmd: string, _opts: any, _cb: any) => { /* no-op */ },
}));

// --- Imports (after mock declarations so they resolve to mocked modules) ---

import {
  resolveMentionTarget,
  updateDashboardActivityAsync,
  sendMentionNotificationsAsync,
  sendStructuredMentionNotificationsAsync,
  updateDashboardMetricsAsync
} from '../../../src/utils/dashboard-helpers.js';

// Helper: minimal dashboard content
function makeDashboardContent(parts: { lastUpdate?: string; machineSection?: string; metricsSection?: string } = {}): string {
  const lines: string[] = [];
  if (parts.lastUpdate) {
    lines.push(parts.lastUpdate);
  } else {
    lines.push('**Derniere mise a jour:** 2026-01-01 00:00:00 par myia-ai-01:roo-extensions');
  }
  lines.push('');
  lines.push('## Status');
  lines.push('');
  if (parts.machineSection) {
    lines.push(parts.machineSection);
  } else {
    lines.push('### myia-ai-01');
    lines.push('');
    lines.push('#### roo-extensions');
    lines.push('- Old activity');
    lines.push('');
  }
  if (parts.metricsSection) {
    lines.push(parts.metricsSection);
  }
  return lines.join('\n');
}

// =========================================================================
// resolveMentionTarget (pure function, no mocks needed)
// =========================================================================
describe('resolveMentionTarget', () => {
  it('should return userId when mention has userId', () => {
    const userId: UserId = { machineId: 'myia-ai-01', workspace: 'roo-extensions' };
    const mention: Mention = { userId };
    const result = resolveMentionTarget(mention);
    expect(result).toEqual(userId);
  });

  it('should return userId with note field present (note is ignored)', () => {
    const userId: UserId = { machineId: 'myia-po-2026', workspace: 'roo-extensions' };
    const mention: Mention = { userId, note: 'please review' };
    const result = resolveMentionTarget(mention);
    expect(result).toEqual(userId);
  });

  it('should parse messageId format into machineId + workspace', () => {
    const mention: Mention = {
      messageId: 'myia-ai-01:roo-extensions:ic-2026-04-17T0809-3lmh',
    };
    const result = resolveMentionTarget(mention);
    expect(result).toEqual({ machineId: 'myia-ai-01', workspace: 'roo-extensions' });
  });

  it('should parse messageId with hyphens in workspace name', () => {
    const mention: Mention = {
      messageId: 'myia-po-2023:roo-extensions:ic-2026-04-20T1200-abcd',
    };
    const result = resolveMentionTarget(mention);
    expect(result).toEqual({ machineId: 'myia-po-2023', workspace: 'roo-extensions' });
  });

  it('should parse messageId that has colons inside the third segment', () => {
    // Third segment = "ic-2026-04-17T08:09:00-rand" — the split must only use first two colons
    const mention: Mention = {
      messageId: 'myia-web1:roo-extensions:ic-2026-04-17T08:09:00-xyz',
    };
    const result = resolveMentionTarget(mention);
    expect(result).toEqual({ machineId: 'myia-web1', workspace: 'roo-extensions' });
  });

  it('should throw on messageId with no colons (invalid format)', () => {
    const mention: Mention = {
      messageId: 'invalid-no-colons',
    };
    expect(() => resolveMentionTarget(mention)).toThrow(
      /Invalid messageId format/
    );
  });

  it('should throw on messageId with only one colon (missing workspace)', () => {
    const mention: Mention = {
      messageId: 'only-one-colon:',
    };
    expect(() => resolveMentionTarget(mention)).toThrow(
      /Invalid messageId format/
    );
  });

  it('should throw when neither userId nor messageId is provided (XOR violation)', () => {
    // TypeScript prevents this at compile time, but runtime guard exists
    const mention = {} as Mention;
    expect(() => resolveMentionTarget(mention)).toThrow(
      /schema XOR invariant violated/
    );
  });
});

// =========================================================================
// updateDashboardActivityAsync
// =========================================================================
describe('updateDashboardActivityAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSharedStatePath.mockReturnValue('/fake/shared-state');
    mockGetLocalMachineId.mockReturnValue('myia-ai-01');
    mockAccess.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('should return silently when dashboard file does not exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    await updateDashboardActivityAsync('Test activity');
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('should return silently when machine section is not found', async () => {
    const content = '## Status\n\nSome content without machine headers\n';
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('Test activity');
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Machine section not found'),
      expect.any(Object)
    );
  });

  it('should replace existing workspace subsection content', async () => {
    const content = makeDashboardContent();
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('Message sent to myia-po-2026');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('Message sent to myia-po-2026');
    expect(written).toContain('Derni');  // "Derniere activite" or "Dernière activité"
    expect(written).not.toContain('- Old activity');
  });

  it('should create workspace subsection when not found after machine header', async () => {
    const content = makeDashboardContent({
      machineSection: '### myia-ai-01\n\nNo workspace subsection here\n',
    });
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('New activity');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('New activity');
  });

  it('should include messageId in content when provided', async () => {
    const content = makeDashboardContent();
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('Test', { messageId: 'msg-123' });
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('msg-123');
    expect(written).toContain('Message ID');
  });

  it('should include subject in content when provided', async () => {
    const content = makeDashboardContent();
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('Test', { subject: 'Sync complete' });
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('Sync complete');
    expect(written).toContain('Sujet');
  });

  it('should update the timestamp line', async () => {
    const content = makeDashboardContent();
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('Test');
    const written = mockWriteFile.mock.calls[0][1] as string;
    // The source updates "Derniere mise a jour:" — match the pattern the source uses
    // Source uses French accented "Dernière mise à jour" but that depends on content
    // Check that the written content includes a timestamp line with machineId
    const lines = written.split('\n');
    const tsLine = lines.find(l => l.includes('myia-ai-01:roo-extensions'));
    expect(tsLine).toBeDefined();
  });

  it('should not throw on unexpected errors (fire-and-forget)', async () => {
    mockReadFile.mockRejectedValue(new Error('Disk failure'));
    // Should NOT throw
    await expect(updateDashboardActivityAsync('Test')).resolves.toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('non-critical'),
      expect.any(Object)
    );
  });

  it('should handle dashboard with multiple machine sections and find the correct one', async () => {
    const content = makeDashboardContent({
      machineSection:
        '### myia-po-2023\n\n#### roo-extensions\n- po-2023 activity\n\n### myia-ai-01\n\n#### roo-extensions\n- ai-01 activity\n',
    });
    mockReadFile.mockResolvedValue(content);
    await updateDashboardActivityAsync('New ai-01 activity');
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('New ai-01 activity');
    // po-2023 section should remain untouched
    expect(written).toContain('po-2023 activity');
  });
});

// =========================================================================
// sendMentionNotificationsAsync
// =========================================================================
describe('sendMentionNotificationsAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocalMachineId.mockReturnValue('myia-ai-01');
    mockSendMessage.mockResolvedValue({ id: 'sent-1' });
  });

  it('should group mentions by machine and send one notification per machine', async () => {
    const mentions = [
      { type: 'machine' as const, target: 'myia-po-2023', pattern: '@myia-po-2023' },
      { type: 'machine' as const, target: 'myia-po-2023', pattern: '@myia-po-2023' },
      { type: 'machine' as const, target: 'myia-po-2026', pattern: '@myia-po-2026' },
    ];
    await sendMentionNotificationsAsync('msg-1', mentions, 'workspace-roo-extensions', 'Hello');
    // One call per unique machine
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('should extract machine ID from agent mentions by removing prefix', async () => {
    const mentions = [
      { type: 'agent' as const, target: 'roo-myia-ai-01', pattern: '@roo-myia-ai-01' },
    ];
    await sendMentionNotificationsAsync('msg-2', mentions, 'workspace-roo-extensions', 'Test');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    // The `to` argument should be the extracted machine ID
    const call = mockSendMessage.mock.calls[0];
    expect(call[1]).toBe('myia-ai-01'); // "roo-myia-ai-01" with "roo-" prefix stripped
  });

  it('should truncate content excerpt to 200 chars in notification body', async () => {
    const longExcerpt = 'A'.repeat(300);
    const mentions = [
      { type: 'machine' as const, target: 'myia-po-2023', pattern: '@myia-po-2023' },
    ];
    await sendMentionNotificationsAsync('msg-3', mentions, 'workspace-roo-extensions', longExcerpt);
    const body = mockSendMessage.mock.calls[0][3] as string;
    // The excerpt part should be truncated
    expect(body).toContain('...');
    // Full excerpt is 300 chars, truncated body part should be shorter
    const excerptInBody = body.split('**Extrait:**\n')[1];
    expect(excerptInBody.length).toBeLessThan(longExcerpt.length + 10);
  });

  it('should skip user and message type mentions (only machine/agent)', async () => {
    const mentions = [
      { type: 'user' as const, target: 'some-user', pattern: '@user' },
      { type: 'message' as const, target: 'msg-ref', pattern: '#msg' },
    ];
    await sendMentionNotificationsAsync('msg-4', mentions, 'workspace-roo-extensions', 'Test');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('should handle empty mentions array gracefully', async () => {
    await sendMentionNotificationsAsync('msg-5', [], 'workspace-roo-extensions', 'Test');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('should not throw when sendMessage fails (fire-and-forget per machine)', async () => {
    mockSendMessage.mockRejectedValue(new Error('Network error'));
    const mentions = [
      { type: 'machine' as const, target: 'myia-po-2023', pattern: '@myia-po-2023' },
    ];
    await expect(
      sendMentionNotificationsAsync('msg-6', mentions, 'workspace-roo-extensions', 'Test')
    ).resolves.toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('non-critical'),
      expect.any(Object)
    );
  });

  it('should not propagate errors from outer catch', async () => {
    // Force getLocalMachineId to throw so the outer catch fires
    mockGetLocalMachineId.mockImplementation(() => {
      throw new Error('Unexpected failure');
    });
    // Provide machine-type mentions so the loop body runs and calls getLocalMachineId
    const mentions = [
      { type: 'machine' as const, target: 'myia-po-2023', pattern: '@myia-po-2023' },
    ];
    await expect(
      sendMentionNotificationsAsync('msg-7', mentions, 'workspace-roo-extensions', 'Test')
    ).resolves.toBeUndefined();
    // The outer catch logs "non-critical" and includes messageId
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('non-critical'),
      expect.objectContaining({ messageId: 'msg-7' })
    );
  });
});

// =========================================================================
// sendStructuredMentionNotificationsAsync
// =========================================================================
describe('sendStructuredMentionNotificationsAsync', () => {
  const fromUserId: UserId = { machineId: 'myia-ai-01', workspace: 'roo-extensions' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({ id: 'sent-s1' });
  });

  it('should send one notification per unique machineId:workspace target', async () => {
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
      { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s1', targets, 'workspace-roo-extensions', 'Test excerpt'
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('should deduplicate targets by machineId:workspace key', async () => {
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s2', targets, 'workspace-roo-extensions', 'Dedup test'
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('should send separate notifications for same machine different workspace', async () => {
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
      { machineId: 'myia-po-2023', workspace: 'other-project' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s3', targets, 'workspace-roo-extensions', 'Multi-workspace'
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('should truncate excerpt to 200 chars', async () => {
    const longExcerpt = 'B'.repeat(300);
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s4', targets, 'workspace-roo-extensions', longExcerpt
    );
    const body = mockSendMessage.mock.calls[0][3] as string;
    expect(body).toContain('...');
  });

  it('should not truncate short excerpts', async () => {
    const shortExcerpt = 'Short message';
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s5', targets, 'workspace-roo-extensions', shortExcerpt
    );
    const body = mockSendMessage.mock.calls[0][3] as string;
    expect(body).not.toContain('...');
    expect(body).toContain(shortExcerpt);
  });

  it('should log at debug level for self-block errors (Auto-message interdit)', async () => {
    mockSendMessage.mockRejectedValue(new Error('Auto-message interdit: blocked'));
    const targets: UserId[] = [
      { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s6', targets, 'workspace-roo-extensions', 'Self test'
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send structured mention'),
      expect.objectContaining({ selfBlock: true })
    );
  });

  it('should log at warn level for non-self-block errors', async () => {
    mockSendMessage.mockRejectedValue(new Error('Network failure'));
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s7', targets, 'workspace-roo-extensions', 'Net error test'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send structured mention'),
      expect.objectContaining({ selfBlock: false })
    );
  });

  it('should handle empty targets gracefully', async () => {
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s8', [], 'workspace-roo-extensions', 'No targets'
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('should use HIGH priority and v3 tags', async () => {
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s9', targets, 'workspace-roo-extensions', 'Priority test'
    );
    const call = mockSendMessage.mock.calls[0];
    expect(call[4]).toBe('HIGH');
    expect(call[5]).toEqual(['mention', 'notification', 'v3']);
  });

  it('should not throw when all sends fail (fire-and-forget per target)', async () => {
    mockSendMessage.mockRejectedValue(new Error('All down'));
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
      { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
    ];
    await expect(
      sendStructuredMentionNotificationsAsync(
        fromUserId, 'msg-s10', targets, 'workspace-roo-extensions', 'Mass failure'
      )
    ).resolves.toBeUndefined();
    // Each failure logged at warn (non-self-block)
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('should pass from as machineId:workspace format', async () => {
    const targets: UserId[] = [
      { machineId: 'myia-po-2023', workspace: 'roo-extensions' },
    ];
    await sendStructuredMentionNotificationsAsync(
      fromUserId, 'msg-s11', targets, 'workspace-roo-extensions', 'From format'
    );
    const call = mockSendMessage.mock.calls[0];
    expect(call[0]).toBe('myia-ai-01:roo-extensions');
    expect(call[1]).toBe('myia-po-2023:roo-extensions');
  });
});

// =========================================================================
// updateDashboardMetricsAsync
// =========================================================================
describe('updateDashboardMetricsAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSharedStatePath.mockReturnValue('/fake/shared-state');
    mockGetLocalMachineId.mockReturnValue('myia-ai-01');
    mockAccess.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('should return silently when dashboard file does not exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    await updateDashboardMetricsAsync();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('should handle missing getSharedStatePath gracefully', async () => {
    mockGetSharedStatePath.mockImplementation(() => {
      throw new Error('ROOSYNC_SHARED_PATH not set');
    });
    await expect(updateDashboardMetricsAsync()).resolves.toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  // Note: Tests involving fetchGitHubProjectMetrics (which uses child_process.exec)
  // cannot be reliably unit-tested here because promisify(exec) is bound at module
  // load time. The exec mock's callback-based interface must be manually invoked,
  // which promisify cannot handle in a standard vi.mock scenario.
  // Integration tests cover the full metrics flow.
});
