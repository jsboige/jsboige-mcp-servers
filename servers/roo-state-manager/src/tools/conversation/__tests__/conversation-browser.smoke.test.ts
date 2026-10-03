/**
 * Smoke test for conversation_browser
 *
 * Purpose: Validate that conversation_browser returns fresh data after filesystem changes
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * Renforcement #2639 (lot 4, rang 14). Mesures firsthand (probe sur ce checkout) :
 * - les anciennes assertions `toBeDefined()` laissaient passer des payloads
 *   d'erreur : `current` rendait `isError: true` (« Aucune tâche trouvée »)
 *   parce que le squelette dérive son workspace de task_metadata.json
 *   (disk-scanner.ts readTaskMetadata) — pas du task.jsonl que le test écrivait ;
 * - `tree` rendait le markdown « Arbre de Tâches Vide » avec un cache vierge ;
 * - le 6e argument (scanTasksForChildren) n'est pas câblé sur l'action tree.
 * Le test amorce désormais le cache par un appel `list` (scan fire-and-forget),
 * puis chaque action est décodée et son contrat JSON vérifié sur les valeurs
 * réelles : list (list-conversations.tool.ts), current (CurrentTaskResult,
 * get-current-task.tool.ts l.154-163), tree (jsonOutput, get-tree.tool.ts l.493-508).
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 25-32)
 * @see AUDIT_MCP_TOOLS_PHASE1.md - conversation_browser marked "À RISQUE" with 3 bugs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleConversationBrowser } from '../conversation-browser.js';
import { invalidateDiskScanCache } from '../../task/disk-scanner.js';
import { RooStorageDetector } from '../../../utils/roo-storage-detector.js';
import { globalCacheManager } from '../../../utils/cache-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionId } from '../../../utils/extension-paths.js';

// Unmock modules that jest.setup.js mocks globally.
// Smoke tests need real filesystem and real services (not mocks).
vi.unmock('fs');
vi.unmock('fs/promises');
vi.unmock('../../../services/ConversationCache.js');
vi.unmock('../../../services/ConfigService.js');

describe('SMOKE: conversation_browser', () => {
  // Use the same path that list-conversations.tool.ts uses (setup-env.ts redirects APPDATA)
  // NOTE: Path must be computed inside tests because APPDATA is redirected by setup-env.ts
  let testTasksPath: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Save original environment
    originalEnv = { ...process.env };

    // Compute test path after setup-env.ts has redirected APPDATA
    testTasksPath = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', getExtensionId(), 'tasks');

    // Setup test environment with required env vars
    process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';

    // Create test directory structure
    if (!fs.existsSync(testTasksPath)) {
      fs.mkdirSync(testTasksPath, { recursive: true });
    }

    // Invalidate disk-scanner's module-level cache to prevent state leakage between tests
    invalidateDiskScanCache();

    // CRITICAL FIX: Mock RooStorageDetector.detectStorageLocations() to return test path
    // The real detector uses os.homedir() which doesn't respect process.env.APPDATA
    const testStoragePath = path.dirname(testTasksPath);
    vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue([testStoragePath]);

    // Clear global cache to avoid cached storage locations from other tests
    await globalCacheManager.clear();
  });

  afterEach(async () => {
    // Restore original environment
    process.env = originalEnv;

    // Cleanup test files (delete all task directories)
    if (fs.existsSync(testTasksPath)) {
      const dirs = fs.readdirSync(testTasksPath);
      for (const dir of dirs) {
        const taskDir = path.join(testTasksPath, dir);
        if (fs.statSync(taskDir).isDirectory()) {
          fs.rmSync(taskDir, { recursive: true, force: true });
        }
      }
    }

    // Restore mock
    vi.restoreAllMocks();
  });

  /**
   * Helper: Create a Roo-format conversation on disk.
   * task_metadata.json porte le workspace — c'est LA source du squelette
   * (disk-scanner.ts readTaskMetadata l.21-29), task.jsonl ne l'est pas.
   */
  function createRooConversation(taskId: string, messages: any[]) {
    const taskDir = path.join(testTasksPath, taskId);
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(taskDir, 'api_conversation_history.json'),
      JSON.stringify(messages, null, 2)
    );

    const now = Date.now();
    const uiMessages = messages.map((m, i) => ({
      text: m.content || '',
      ts: now + i * 1000, // Timestamp increments by 1 second per message
      role: m.role
    }));
    fs.writeFileSync(
      path.join(taskDir, 'ui_messages.json'),
      JSON.stringify(uiMessages, null, 2)
    );

    fs.writeFileSync(
      path.join(taskDir, 'task_metadata.json'),
      JSON.stringify({ workspace: 'roo-extensions' }, null, 2)
    );
  }

  /** Amorce le cache via un appel list (scan disque fire-and-forget), puis attend la population. */
  async function primeCache(cache: Map<string, any>, minSize = 1) {
    await handleConversationBrowser(
      { action: 'list', limit: 10 },
      cache,
      async () => {},
      'roo-extensions',
      async (id) => null
    );
    await vi.waitFor(() => expect(cache.size).toBeGreaterThanOrEqual(minSize), { timeout: 5000 });
  }

  const callBrowser = (args: any, cache: Map<string, any>) =>
    handleConversationBrowser(args, cache, async () => {}, 'roo-extensions', async (id) => null);

  /** Un résultat frais n'est jamais un payload d'erreur (browse.ts l.194-208). */
  function expectFreshResult(result: any): string {
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].type).toBe('text');
    return result.content[0].text as string;
  }

  it('should return fresh list after new conversation is added (action: list)', async () => {
    // Step 1: Create initial conversation in Roo format
    const task1Id = 'smoke-test-task-1';
    createRooConversation(task1Id, [
      { role: 'user', content: 'Initial user message' },
      { role: 'assistant', content: 'Assistant response' }
    ]);

    const cache = new Map();

    // Step 2: Initial call triggers fire-and-forget disk scan — état frais VIDE mesuré
    const result1Text = expectFreshResult(await callBrowser({ action: 'list', limit: 10 }, cache));
    const result1Json = JSON.parse(result1Text);
    expect(result1Json.conversations).toEqual([]);
    expect(result1Json.pagination.total_count).toBe(0);

    // Wait for fire-and-forget scan to discover and cache the conversation
    await vi.waitFor(() => expect(cache.size).toBeGreaterThan(0), { timeout: 5000 });

    // Step 2b: Second call now has the conversation in cache
    const result1bText = expectFreshResult(await callBrowser({ action: 'list', limit: 10 }, cache));
    const result1bJson = JSON.parse(result1bText);
    // Contrat list (list-conversations.tool.ts l.84/l.225/l.271) : entrée taskId + message initial + métadonnées
    expect(result1bJson.conversations.map((c: any) => c.taskId)).toEqual([task1Id]);
    expect(result1bJson.conversations[0]).toMatchObject({
      taskId: task1Id,
      source: 'roo',
      firstUserMessage: 'Initial user message'
    });
    expect(result1bJson.conversations[0].metadata.messageCount).toBe(2);
    // Date d'activité parsable (dérivée du dernier ts ui_messages)
    expect(Number.isNaN(new Date(result1bJson.conversations[0].metadata.lastActivity).getTime())).toBe(false);
    expect(result1bJson.pagination).toMatchObject({ page: 1, total_count: 1, total_pages: 1, has_next: false });

    // Step 3: Add more conversations
    const task2Id = 'smoke-test-task-2';
    const task3Id = 'smoke-test-task-3';
    createRooConversation(task2Id, [{ role: 'user', content: 'Second task message' }]);
    createRooConversation(task3Id, [{ role: 'user', content: 'Third task message' }]);

    // CRITICAL: Invalidate disk-scanner's module-level cache to force fresh scan
    invalidateDiskScanCache();

    // Step 4: re-scan puis liste fraîche
    await primeCache(cache, 3);
    const result2Text = expectFreshResult(await callBrowser({ action: 'list', limit: 10 }, cache));

    // Step 5: la liste reflète l'état du filesystem — les 3 tâches, compte exact
    const result2Json = JSON.parse(result2Text);
    expect(result2Json.conversations).toHaveLength(3);
    expect(result2Json.conversations.map((c: any) => c.taskId))
      .toEqual(expect.arrayContaining([task1Id, task2Id, task3Id]));
    expect(result2Json.pagination.total_count).toBe(3);
  });

  it('should return fresh current task after state change (action: current)', async () => {
    // Step 1: Create initial active task
    const task1Id = 'smoke-test-current-1';
    createRooConversation(task1Id, [
      { role: 'user', content: 'Working on this task' },
      { role: 'assistant', content: 'Reply' }
    ]);

    // Amorçage : current lit le cache passé (pas de force_refresh exposé via
    // conversation_browser) — un appel list déclenche le scan qui le peuple.
    const cache = new Map();
    await primeCache(cache);

    // Step 2: current renvoie le contrat CurrentTaskResult (get-current-task.tool.ts l.154-163)
    const result1Text = expectFreshResult(await callBrowser({ action: 'current' }, cache));
    const result1Json = JSON.parse(result1Text);
    expect(result1Json.task_id).toBe(task1Id);
    expect(result1Json.workspace_path).toBe('roo-extensions'); // dérivé de task_metadata.json
    expect(result1Json.message_count).toBe(2); // user + assistant dans ui_messages.json
    expect(Number.isNaN(new Date(result1Json.updated_at).getTime())).toBe(false);

    // Step 3: Modify the task (update ui_messages.json — plus qu'un seul message)
    const uiMessagesPath = path.join(testTasksPath, task1Id, 'ui_messages.json');
    const modifiedTs = Date.now();
    fs.writeFileSync(uiMessagesPath, JSON.stringify([
      { text: 'Updated task', ts: modifiedTs, role: 'user' }
    ], null, 2));

    // CRITICAL: Invalidate disk-scanner's module-level cache to force fresh scan
    invalidateDiskScanCache();
    const cache2 = new Map();
    await primeCache(cache2);

    // Step 4: Second call to get current task
    const result2Text = expectFreshResult(await callBrowser({ action: 'current' }, cache2));

    // Step 5: Fresh data PROUVÉE par le contenu — une réponse stale montrerait
    // encore message_count 2 ; le fichier modifié n'en a plus qu'un.
    const result2Json = JSON.parse(result2Text);
    expect(result2Json.task_id).toBe(task1Id);
    expect(result2Json.message_count).toBe(1);
    // L'activité suit la modification (ts le plus récent du disque)
    expect(new Date(result2Json.updated_at).getTime())
      .toBeGreaterThanOrEqual(new Date(result1Json.updated_at).getTime() - 1000);
  });

  it('should return fresh tree structure for a newly discovered task (action: tree)', async () => {
    // Step 1: Create the root task
    const rootTaskId = 'smoke-test-root-1';
    createRooConversation(rootTaskId, [{ role: 'user', content: 'Root task' }]);

    const cache = new Map();
    await primeCache(cache);

    // Step 2: tree sur la racine — contrat JSON mesuré (get-tree.tool.ts l.493-508)
    const result1Text = expectFreshResult(await callBrowser(
      { action: 'tree', conversation_id: rootTaskId, output_format: 'json' }, cache));
    const result1Json = JSON.parse(result1Text);
    expect(result1Json.conversation_id).toBe(rootTaskId);
    expect(result1Json.root_task).toMatchObject({ taskId: rootTaskId, title: 'Root task' });
    expect(result1Json.root_task.metadata.workspace).toBe('roo-extensions');
    expect(Array.isArray(result1Json.tree)).toBe(true);
    expect(result1Json.metadata).toMatchObject({
      total_nodes: 1,
      output_format: 'json',
      include_siblings: true
    });

    // Step 3: new tasks appear on disk after the initial scan
    const child1Id = 'smoke-test-child-1';
    const child2Id = 'smoke-test-child-2';
    createRooConversation(child1Id, [{ role: 'user', content: 'Child task 1' }]);
    createRooConversation(child2Id, [{ role: 'user', content: 'Child task 2' }]);

    // CRITICAL: Invalidate disk-scanner's module-level cache to force fresh scan
    invalidateDiskScanCache();
    await primeCache(cache, 3);

    // Step 4: tree sur une tâche qui n'existait pas au premier scan —
    // fraîcheur PROUVÉE : la structure rend la tâche nouvellement découverte
    // (l'ancien test passait un callback scanTasksForChildren non câblé sur tree
    // et n'assertait que toBeDefined sur du texte).
    const result2Text = expectFreshResult(await callBrowser(
      { action: 'tree', conversation_id: child1Id, output_format: 'json' }, cache));
    const result2Json = JSON.parse(result2Text);
    expect(result2Json.conversation_id).toBe(child1Id);
    expect(result2Json.root_task).toMatchObject({ taskId: child1Id, title: 'Child task 1' });
    expect(result2Json.root_task.metadata.messageCount).toBe(1);
    expect(result2Json.metadata.total_nodes).toBe(1);

    // La racine initiale reste adressable et inchangée après le re-scan
    const result3Text = expectFreshResult(await callBrowser(
      { action: 'tree', conversation_id: rootTaskId, output_format: 'json' }, cache));
    const result3Json = JSON.parse(result3Text);
    expect(result3Json.root_task.taskId).toBe(rootTaskId);
    expect(result3Json.root_task.title).toBe('Root task');
    // NB mesuré : quickAnalyze ne dérive pas parentTaskId des dossiers disque
    // (disk-scanner.ts l.66/l.90) — child1/child2 sont des racines indépendantes
    // dans cette voie, pas des enfants de root. La hiérarchie réelle passe par
    // le cache de squelettes complet (build_skeleton_cache), hors scope smoke.
    expect(result3Json.metadata.total_nodes).toBe(1);
  });
});
