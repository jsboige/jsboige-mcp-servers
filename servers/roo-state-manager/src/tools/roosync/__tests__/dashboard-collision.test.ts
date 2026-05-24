/**
 * #2328: Tests for dashboard anti-collision smart-merge.
 *
 * Verifies that `applyCondensedWithMerge` preserves concurrent appends
 * and guards against stale double-condensation overwrites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-collision-test-');

describe('dashboard collision #2328', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  /** Helper: read dashboard file and return parsed intercom message ids */
  async function readMessageIds(key: string): Promise<string[]> {
    const dashboardsDir = path.join(tmpDir, 'dashboards');
    const filePath = path.join(dashboardsDir, `${key}.md`);
    const content = await readFile(filePath, 'utf8');
    const ids: string[] = [];
    const regex = /\[msg: ([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      ids.push(match[1]);
    }
    return ids;
  }

  /** Helper: get dashboard file path */
  function getDashboardFilePath(key: string): string {
    return path.join(tmpDir, 'dashboards', `${key}.md`);
  }

  /** Helper: inject an extra message directly into the file on disk (simulates concurrent append) */
  async function injectConcurrentMessage(key: string, msgId: string, msgContent: string): Promise<void> {
    const filePath = getDashboardFilePath(key);
    let fileContent = await readFile(filePath, 'utf8');

    // Append a new message block
    const ts = new Date().toISOString();
    const messageBlock = `\n\n---\n\n### [${ts}] other-machine|other-workspace\n[msg: ${msgId}]\n\n${msgContent}`;
    fileContent = fileContent.replace(/\*Aucun message\.\*/, '');
    fileContent += messageBlock;

    // Update totalMessages in frontmatter
    fileContent = fileContent.replace(
      /totalMessages: (\d+)/,
      (_, n) => `totalMessages: ${parseInt(n) + 1}`
    );
    // Update message count in section header
    fileContent = fileContent.replace(
      /## Intercom \((\d+) messages\)/,
      (_, n) => `## Intercom (${parseInt(n) + 1} messages)`
    );

    await writeFile(filePath, fileContent, 'utf8');
  }

  /** Helper: populate dashboard with N messages */
  async function populateDashboard(n: number): Promise<string> {
    const writeResult = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: 'test status',
      createIfNotExists: true,
    });
    const key = writeResult.key;

    for (let i = 0; i < n; i++) {
      await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: `Message ${i}: ${'x'.repeat(500)}`,
        tags: ['INFO'],
      });
    }
    return key;
  }

  it('preserves concurrent append after condensation', async () => {
    const key = await populateDashboard(20);
    const idsBefore = await readMessageIds(key);
    expect(idsBefore.length).toBe(20);

    // Inject a concurrent message directly on disk (simulates another machine)
    const concurrentMsgId = 'concurrent-msg-999';
    await injectConcurrentMessage(key, concurrentMsgId, 'Concurrent message from another machine');

    const idsAfterInject = await readMessageIds(key);
    expect(idsAfterInject).toContain(concurrentMsgId);

    // Trigger condensation via append — the in-memory snapshot does NOT contain concurrentMsgId.
    // applyCondensedWithMerge should re-read disk and stitch the delta back in.
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: `Final message: ${'y'.repeat(500)}`,
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);

    // The concurrent message must survive condensation
    const idsAfterCondense = await readMessageIds(key);
    expect(idsAfterCondense).toContain(concurrentMsgId);
  });

  it('skips overwrite when another condensation already won', async () => {
    const key = await populateDashboard(20);

    // Simulate that another machine already condensed: set lastCondensedAt to future
    const filePath = getDashboardFilePath(key);
    let fileContent = await readFile(filePath, 'utf8');
    const futureDate = new Date(Date.now() + 60000).toISOString();
    if (fileContent.includes('lastCondensedAt:')) {
      fileContent = fileContent.replace(/lastCondensedAt: .+/, `lastCondensedAt: ${futureDate}`);
    } else {
      fileContent = fileContent.replace(/^---\n/, `---\nlastCondensedAt: ${futureDate}\n`);
    }
    await writeFile(filePath, fileContent, 'utf8');

    // Append (may trigger condensation). The smart-merge guard should detect
    // the newer lastCondensedAt and skip the stale overwrite.
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: 'New message after concurrent condense',
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);

    // Messages should still be present (not lost to stale overwrite)
    const idsAfter = await readMessageIds(key);
    expect(idsAfter.length).toBeGreaterThanOrEqual(10);
  });

  it('works correctly when no concurrent append (common case)', async () => {
    const key = await populateDashboard(20);

    const idsBefore = await readMessageIds(key);
    expect(idsBefore.length).toBe(20);

    // Trigger condensation via append
    const result = await roosyncDashboard({
      action: 'append',
      type: 'workspace',
      content: `Final: ${'y'.repeat(500)}`,
      tags: ['INFO'],
    });

    expect(result.success).toBe(true);

    // Dashboard should still have messages (condensed or not)
    const idsAfter = await readMessageIds(key);
    expect(idsAfter.length).toBeGreaterThan(0);
  });
});
