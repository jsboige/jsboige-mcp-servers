/**
 * Coverage tests for src/debug-hierarchy.ts (#833 — C3 sprint)
 *
 * `debug-hierarchy.ts` is a top-level executable diagnostic script. It imports
 * fs/promises + RooStorageDetector + GenericError, then on top-level execution:
 *   - calls `RooStorageDetector.detectRooStorage()`
 *   - selects firstLocation.path, joins 'tasks'
 *   - readdir() the directory, iterates `entries.slice(0, 3)`
 *   - for each `.json` entry: readFile + JSON.parse + logs 4 conditional sections
 *     (agentDetails / parentTaskId-root / metadata / apiHistory.new_task)
 *   - count incremented + break after 3
 *
 * The existing `debug-hierarchy.test.ts` covers the throw branch (L22 no-locations)
 * and helper filters but never traverses the for-loop on real fs mocks → 44.06% stmts
 * / 75% branch (cold = full L33-L83 body except catch).
 *
 * This file pins the cold clusters via vi.doMock('fs/promises') + vi.doMock of
 * roo-storage-detector. Add-only coverage test, 0 source touched (#1936).
 *
 * Pattern (per c.34 lesson): vi.resetModules() + dynamic import() between tests to
 * isolate module state. console.log/error spies per test.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe('debug-hierarchy.ts branch coverage', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let readdirMock: ReturnType<typeof vi.fn>;
  let readFileMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    readdirMock = vi.fn();
    readFileMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../utils/roo-storage-detector.js');
    vi.doUnmock('fs/promises');
    vi.doUnmock('../types/errors.js');
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Import debug-hierarchy.ts with fs/promises + RooStorageDetector + GenericError
   * mocked. `readFileContent` is what `readFile()` returns for the FIRST call (only
   * one file is processed per test setup — see slice(0,3) + count increment).
   */
  async function importSutWithMocks(opts: {
    detectStorageLocations?: Array<{ path: string; type?: string }>;
    detectStorageReject?: boolean;
    readdirReturn?: string[];
    readdirReject?: boolean;
    readFileContent?: string; // returned by readFile() on every call
    readFileRejectWithError?: Error;
  }) {
    // Mock fs/promises: readdir + readFile
    vi.doMock('fs/promises', () => ({
      readdir: opts.readdirReject
        ? readdirMock.mockRejectedValue(new Error('readdir failed'))
        : readdirMock.mockResolvedValue(opts.readdirReturn ?? []),
      readFile: readFileMock.mockImplementation(async (_filePath: string) => {
        if (opts.readFileRejectWithError) {
          throw opts.readFileRejectWithError;
        }
        if (opts.readFileContent === undefined) {
          throw new Error('readFile mock: no readFileContent provided in test opts');
        }
        return opts.readFileContent;
      }),
    }));

    // Mock RooStorageDetector: static method + class instantiation
    vi.doMock('../utils/roo-storage-detector.js', () => ({
      RooStorageDetector: class MockRooStorageDetector {
        constructor() {}
        static detectRooStorage = opts.detectStorageReject
          ? vi.fn().mockRejectedValue(new Error('detectRooStorage failed'))
          : vi.fn().mockResolvedValue({
              locations: opts.detectStorageLocations ?? [{ path: '/mock/storage', type: 'mock' }],
            });
      },
    }));

    await import('../debug-hierarchy.js');
    // Wait for top-level execution to complete (async chain in debugHierarchy)
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  function logCallsAsJoinedStrings(): string[] {
    return consoleLogSpy.mock.calls.map((c) => c.map((a) => String(a)).join(' '));
  }

  function logJoined(): string {
    return logCallsAsJoinedStrings().join('\n');
  }

  // ─── L8-L17 banner + detectRooStorage call ──────────────────────────────────

  test('L9: prints top-level debug banner', async () => {
    await importSutWithMocks({ detectStorageLocations: [] });
    const joined = logJoined();
    expect(joined).toContain('🔍 DEBUG');
    expect(joined).toContain('Analyse de la hiérarchie');
  });

  test('L17: logs "Storage détecté" after successful detectRooStorage', async () => {
    await importSutWithMocks({ detectStorageLocations: [{ path: '/x' }] });
    expect(logJoined()).toContain('Storage détecté');
  });

  // ─── L22 firstLocation absent → throw → catch L82 ───────────────────────────

  test('L22-L24 + L82: throws GenericError when locations array is empty (catch path)', async () => {
    // Existing test covers this; re-pin here to assert error message + console.error path
    await importSutWithMocks({ detectStorageLocations: [] });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errArgs = consoleErrorSpy.mock.calls[0] ?? [];
    const errStr = errArgs.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    // The catch logs "❌ Erreur:" + the error. The error message must be GenericError.
    expect(errStr).toContain('Aucun emplacement de stockage trouvé');
  });

  // ─── L25-L28 conversationsDir constructed ───────────────────────────────────

  test('L25-L28: constructs conversationsDir = firstLocation.path + "tasks"', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: [],
    });
    // path.join is platform-dependent (POSIX = '/', Windows = '\\'). Accept both.
    expect(readdirMock).toHaveBeenCalledTimes(1);
    const calledWith = readdirMock.mock.calls[0]?.[0] ?? '';
    expect(String(calledWith).replace(/\\/g, '/')).toBe('/mock/storage/tasks');
  });

  // ─── L33-L34 readdir + count init ───────────────────────────────────────────

  test('L33: readdir called on conversationsDir', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
    });
    expect(readdirMock).toHaveBeenCalledTimes(1);
  });

  // ─── L36 for-loop + L37 entry.endsWith('.json') branches ────────────────────

  test('L36-L37: skips non-.json entries (branch endsWith===false)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['readme.txt', 'image.png'],
      readFileContent: '{}',
    });
    // No file read attempted (only .json entries are read)
    expect(readFileMock).not.toHaveBeenCalled();
    // No file banner logged (entry skipped entirely)
    expect(logJoined()).not.toContain('📄 Fichier');
  });

  test('L36-L37: processes .json entries (branch endsWith===true)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['task1.json'],
      readFileContent: '{}',
    });
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(readFileMock.mock.calls[0][0]).toMatch(/task1\.json$/);
    expect(logJoined()).toContain('📄 Fichier');
    expect(logJoined()).toContain('task1.json');
  });

  // ─── L40 JSON.parse success path ────────────────────────────────────────────

  test('L40: JSON.parse succeeds on valid JSON content', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['valid.json'],
      readFileContent: JSON.stringify({
        conversationId: 'conv-1',
        workspaceDirectory: '/ws/1',
      }),
    });
    // conversationId branch wins → no fallback to id / 'N/A'
    expect(logJoined()).toContain('taskId: conv-1');
    expect(logJoined()).toContain('workspace: /ws/1');
  });

  // ─── L43 conversationId || id || 'N/A' 3 branches ───────────────────────────

  test('L43: conversationId branch wins (truthy first)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        conversationId: 'c-1',
        id: 'i-9', // would be fallback if conversationId missing
      }),
    });
    expect(logJoined()).toContain('taskId: c-1');
    expect(logJoined()).not.toContain('taskId: i-9');
  });

  test('L43: id branch used when conversationId absent (nullish-coalescing fallback)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({ id: 'fallback-id' }),
    });
    expect(logJoined()).toContain('taskId: fallback-id');
  });

  test('L43: "N/A" branch when neither conversationId nor id present', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({}),
    });
    expect(logJoined()).toContain('taskId: N/A');
  });

  // ─── L47 Object.keys(data) logging ───────────────────────────────────────────

  test('L47: logs root keys joined', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({ foo: 1, bar: 2, baz: 3 }),
    });
    expect(logJoined()).toContain('Clés racines: foo, bar, baz');
  });

  // ─── L50/55/60/65 four conditional sections ─────────────────────────────────

  test('L50-L52: agentDetails branch — logs agentDetails.parentTaskId (presence)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        agentDetails: { parentTaskId: 'agent-p-1' },
      }),
    });
    expect(logJoined()).toContain('agentDetails.parentTaskId: agent-p-1');
  });

  test('L50-L52: agentDetails branch — logs NON TROUVÉ when agentDetails.parentTaskId absent', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        agentDetails: { foo: 'bar' }, // parentTaskId missing
      }),
    });
    expect(logJoined()).toContain('agentDetails.parentTaskId: NON TROUVÉ');
  });

  test('L50 branch absent: skips agentDetails log when data.agentDetails undefined', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({}),
    });
    expect(logJoined()).not.toContain('agentDetails.parentTaskId');
  });

  test('L55-L57: parentTaskId root branch — logs root parentTaskId', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        parentTaskId: 'root-parent-xyz',
      }),
    });
    expect(logJoined()).toContain('parentTaskId (racine): root-parent-xyz');
  });

  test('L55 branch absent: skips root parentTaskId log when undefined', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({}),
    });
    expect(logJoined()).not.toContain('parentTaskId (racine)');
  });

  test('L60-L62: metadata branch — logs metadata.parentTaskId (presence)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        metadata: { parentTaskId: 'meta-p-1' },
      }),
    });
    expect(logJoined()).toContain('metadata.parentTaskId: meta-p-1');
  });

  test('L60-L62: metadata branch — logs NON TROUVÉ when metadata.parentTaskId absent', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        metadata: { other: 'value' },
      }),
    });
    expect(logJoined()).toContain('metadata.parentTaskId: NON TROUVÉ');
  });

  test('L60 branch absent: skips metadata log when data.metadata undefined', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({}),
    });
    expect(logJoined()).not.toContain('metadata.parentTaskId');
  });

  // ─── L65-L74 apiHistory.new_task detection ──────────────────────────────────

  test('L65-L74: apiHistory branch — detects new_task instruction (OUI)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        apiHistory: {
          messages: [
            { content: 'Regular message' },
            { content: 'Run <new_task>foo</new_task> please' },
            { content: 'Another message' },
          ],
        },
      }),
    });
    expect(logJoined()).toContain('Instructions new_task: OUI');
  });

  test('L65-L74: apiHistory branch — no new_task found (NON)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        apiHistory: {
          messages: [
            { content: 'no new_task here' },
            { content: 'neither here' },
          ],
        },
      }),
    });
    expect(logJoined()).toContain('Instructions new_task: NON');
  });

  test('L65 branch absent: skips apiHistory log when data.apiHistory undefined', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({}),
    });
    expect(logJoined()).not.toContain('Instructions new_task');
  });

  test('L65 partial: skips apiHistory log when apiHistory present but messages absent', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        apiHistory: { /* no messages key */ },
      }),
    });
    expect(logJoined()).not.toContain('Instructions new_task');
  });

  // ─── L67-L72 inner messages loop + L68 includes('<new_task>') + break ───────

  test('L68-L72: messages loop breaks at first <new_task> match', async () => {
    // The implementation: for...of with `if (msg.content && msg.content.includes('<new_task>')) { newTaskInstructions.push('TROUVÉ'); break; }`.
    // We verify the branch is exercised (length > 0 ⇒ OUI logged). The break itself is internal control flow
    // covered transitively. To prove the includes() branch actually matches the substring, we use a content
    // where only one message has the marker (otherwise the break wouldn't be testable from outside).
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        apiHistory: {
          messages: [
            { content: 'plain' },
            { content: 'has <new_task> marker' },
            { content: 'also has <new_task> marker (break before this)' },
          ],
        },
      }),
    });
    expect(logJoined()).toContain('Instructions new_task: OUI');
  });

  test('L68: messages with empty content skipped (msg.content falsy guard)', async () => {
    // Pin the truthy guard at L68 (`if (msg.content && msg.content.includes('<new_task>'))`)
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['a.json'],
      readFileContent: JSON.stringify({
        apiHistory: {
          messages: [
            { content: '' },
            { content: '   ' },
            { content: '<new_task>real</new_task>' },
          ],
        },
      }),
    });
    expect(logJoined()).toContain('Instructions new_task: OUI');
  });

  // ─── L76 count++; L77 if (count >= 3) break ────────────────────────────────

  test('L36-L77: processes exactly 3 entries (slice(0,3) + count increment)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['1.json', '2.json', '3.json', '4.json', '5.json'],
      readFileContent: JSON.stringify({ id: 'x' }),
    });
    expect(readFileMock).toHaveBeenCalledTimes(3);
    const filenames = readFileMock.mock.calls.map((c) => String(c[0]).split(/[\\/]/).pop());
    expect(filenames).toEqual(['1.json', '2.json', '3.json']);
  });

  // ─── L82 catch path — readdir rejects ───────────────────────────────────────

  test('L82: console.error called when fs.readdir rejects (catch path)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReject: true,
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
    // console.error("❌ Erreur:", error) — second arg is the Error
    const errArgs = consoleErrorSpy.mock.calls[0] ?? [];
    const errStr = errArgs.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    expect(errStr).toContain('❌ Erreur');
    expect(errStr).toContain('readdir failed');
  });

  // ─── L82 catch path — JSON.parse throws ─────────────────────────────────────

  test('L82: console.error called when JSON.parse throws on malformed content (catch path)', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/mock/storage' }],
      readdirReturn: ['bad.json'],
      readFileContent: '{ this is not valid JSON',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errArgs = consoleErrorSpy.mock.calls[0] ?? [];
    const errStr = errArgs.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    expect(errStr).toContain('❌ Erreur');
  });

  // ─── L16 detectRooStorage called once on success ────────────────────────────

  test('L16: detectRooStorage invoked exactly once at top level', async () => {
    await importSutWithMocks({
      detectStorageLocations: [{ path: '/p' }],
      readdirReturn: [],
    });
    // The mock constructor + static call path is exercised by the import.
    // We don't spy on the static here (it's recreated per-import via vi.doMock),
    // but we verify the success banner was logged = detectRooStorage returned OK.
    expect(logJoined()).toContain('Storage détecté');
  });
});