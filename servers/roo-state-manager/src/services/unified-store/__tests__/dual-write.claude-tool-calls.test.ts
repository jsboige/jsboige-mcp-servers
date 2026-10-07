/**
 * #2191 — end-to-end: a Claude Code transcript in the shape Claude Code writes reaches
 * the unified store with its tool actions in `messages.tool_calls`.
 *
 * Two defects stacked before this: the skeleton builder only knew a nested `toolUse`
 * block that never occurs on disk (so no Claude skeleton held an action), and the
 * dual-write dropped actions anyway. Reverting either fix turns this file red.
 *
 * No pg connection: NullUnifiedStoreWriter (env-gate OFF), spied.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ClaudeStorageDetector } from '../../../utils/claude-storage-detector.js';
import { dualWriteConversationToStore } from '../dual-write.js';
import { resetWriterInstance } from '../writer-factory.js';
import { NullUnifiedStoreWriter } from '../UnifiedStoreWriter.js';
import type { MessageRow } from '../types.js';

function clearUnifiedStoreEnv(): void {
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_POOL_MAX;
  delete process.env.UNIFIED_STORE_TIMEOUT_MS;
}

/** JS mirror of the reader's `tool_calls @> '[{"name": X}]'` containment. */
function matchesToolName(row: MessageRow, name: string): boolean {
  return Array.isArray(row.tool_calls)
    && row.tool_calls.some(c => !!c && typeof c === 'object' && (c as { name?: unknown }).name === name);
}

describe('#2191 — Claude tool actions reach messages.tool_calls', () => {
  let tmpDir: string;
  let projectDir: string;
  let msgSpy: ReturnType<typeof vi.spyOn>;
  let convSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  const SESSION = '11111111-2222-3333-4444-555555555555';

  beforeEach(async () => {
    resetWriterInstance();
    vi.unstubAllEnvs();
    clearUnifiedStoreEnv();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    convSpy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertConversationOnly');
    msgSpy = vi.spyOn(NullUnifiedStoreWriter.prototype, 'upsertMessages');

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-claude-tools-'));
    projectDir = path.join(tmpDir, 'd--dev-proj');
    await fs.mkdir(projectDir, { recursive: true });

    // One content block per line, top-level tool_use fields: the on-disk shape.
    const lines = [
      { type: 'user', message: { role: 'user', content: 'Liste le dossier puis lis a.ts' }, timestamp: '2026-10-07T08:00:00.000Z', uuid: 'u0' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Je regarde.' }] }, timestamp: '2026-10-07T08:00:01.000Z', uuid: 'a0' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' }, caller: { type: 'direct' } }] }, timestamp: '2026-10-07T08:00:02.000Z', uuid: 'a1' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'a.ts' }] }, timestamp: '2026-10-07T08:00:03.000Z', uuid: 'u1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: '/p/a.ts' }, caller: { type: 'direct' } }] }, timestamp: '2026-10-07T08:00:04.000Z', uuid: 'a2' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'export {}' }] }, timestamp: '2026-10-07T08:00:05.000Z', uuid: 'u2' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fichier vide.' }] }, timestamp: '2026-10-07T08:00:06.000Z', uuid: 'a3' },
    ];
    await fs.writeFile(path.join(projectDir, `${SESSION}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    infoSpy.mockRestore();
    convSpy.mockRestore();
    msgSpy.mockRestore();
    resetWriterInstance();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('each tool_use lands on the assistant row that issued it; seq stays message-relative', async () => {
    const taskId = `claude-d--dev-proj--${SESSION}`;
    const skeleton = await ClaudeStorageDetector.analyzeConversation(taskId, projectDir);
    expect(skeleton).not.toBeNull();

    await expect(dualWriteConversationToStore(taskId, skeleton!)).resolves.toEqual({ ok: true });
    expect(msgSpy).toHaveBeenCalledTimes(1);
    const rows = msgSpy.mock.calls[0][0] as MessageRow[];

    // 7 JSONL message lines → 7 rows, seq 0..6, the 2 actions are not rows.
    expect(rows.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant', 'user', 'assistant']);

    const withTools = rows.filter(r => r.tool_calls !== null);
    expect(withTools.map(r => r.seq)).toEqual([2, 4]);
    expect(withTools[0].tool_calls).toEqual([
      expect.objectContaining({ type: 'tool', name: 'Bash', parameters: { command: 'ls' }, status: 'success' }),
    ]);
    expect(withTools[1].tool_calls).toEqual([
      expect.objectContaining({ type: 'tool', name: 'Read', parameters: { file_path: '/p/a.ts' } }),
    ]);

    // The reader's tool_name filter now finds the session — it found nothing before.
    expect(rows.filter(r => matchesToolName(r, 'Read')).map(r => r.seq)).toEqual([4]);
    expect(rows.filter(r => matchesToolName(r, 'Bash')).map(r => r.seq)).toEqual([2]);
    expect(rows.some(r => matchesToolName(r, 'Write'))).toBe(false);
  });
});
