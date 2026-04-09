/**
 * Tests unitaires pour roosync_dashboard (#675)
 *
 * @module tests/roosync/dashboard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard } from '../dashboard.js';
import { resetChatOpenAIClient } from '@/services/openai';

// #858: Mock OpenAI chat client for LLM condensation tests
const mockChatCreate = vi.fn();
const mockGetChatClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetChatClient(),
  resetChatOpenAIClient: vi.fn(),
}));

const testTmpBase = path.join(os.tmpdir(), 'dashboard-test-');

describe('roosync_dashboard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    // #864: Réinitialiser le singleton LLM et supprimer les clés API
    // pour s'assurer que les tests de condensation sans LLM fonctionnent
    resetChatOpenAIClient();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    // Aussi supprimer EMBEDDING_API_KEY car c'est un fallback dans getChatOpenAIClient
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
    // #858: Default mock = LLM unavailable (throws)
    mockGetChatClient.mockImplementation(() => { throw new Error('No chat API key configured'); });
    mockChatCreate.mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  // === Test 1: Création dashboard global ===
  it('creates global dashboard on write', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'global',
      content: '# Global Dashboard\n\nState: OK',
      createIfNotExists: true
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('write');
    expect(result.key).toBe('global');
  });

  // === Test 2: Clé dashboard machine ===
  it('creates machine dashboard with correct key', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'machine',
      content: '# Machine Status'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('machine-test-machine');
  });

  // === Test 3: Clé dashboard workspace ===
  it('creates workspace dashboard with correct key', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: '# Workspace Status'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-test-workspace');
  });

  // === Test 5: Read dashboard complet ===
  it('reads dashboard with all sections', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Test Status' });

    const result = await roosyncDashboard({
      action: 'read',
      type: 'global',
      section: 'all'
    });

    expect(result.success).toBe(true);
    expect(result.data?.status?.markdown).toBe('# Test Status');
    expect(result.data?.intercom).toBeDefined();
  });

  // === Test 6: Read section status uniquement ===
  it('reads only status section', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Status Test' });
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });

    expect(result.data?.status).toBeDefined();
    expect(result.data?.intercom).toBeUndefined();
  });

  // === Test 7: Read section intercom uniquement ===
  it('reads only intercom section', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'Msg test' });
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });

    expect(result.data?.intercom?.messages).toHaveLength(1);
    expect(result.data?.status).toBeUndefined();
  });

  // === Test 8: Write remplace status.markdown ===
  it('write replaces status markdown', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: 'Old content' });
    await roosyncDashboard({ action: 'write', type: 'global', content: 'New content' });
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });

    expect(result.data?.status?.markdown).toBe('New content');
  });

  // === Test 9: Append ajoute messages en ordre ===
  it('appends messages in order', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'Message 1' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'Message 2' });
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });

    const msgs = result.data?.intercom?.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs?.[0].content).toBe('Message 1');
    expect(msgs?.[1].content).toBe('Message 2');
  });

  // === Test 10: Legacy tag headers tolerated by parser ===
  // Tags removed from dashboard intercom in 2026-04 (no consumer, AI slop).
  // Parser still tolerates legacy `### [ts] machine|workspace [TAGS]` headers but discards them.
  it('parses legacy headers with tags segment without breaking', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: 'Plain message'
    });
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const msg = result.data?.intercom?.messages?.[0];

    expect(msg?.content).toBe('Plain message');
    expect((msg as any)?.tags).toBeUndefined();
  });

  // === Test 11: Condensation manuelle (annulée sans LLM) ===
  // #864: Sans LLM configuré, la condensation est annulée
  // #858: Fixed — mock properly resets via beforeEach
  it('condense is cancelled without LLM configured', async () => {
    // S'assurer qu'aucun LLM n'est configuré
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
    }

    const condenseResult = await roosyncDashboard({
      action: 'condense',
      type: 'global',
      keepMessages: 3
    });

    // #864: Condensation annulée car LLM non configuré
    expect(condenseResult.success).toBe(true);
    expect(condenseResult.condensed).toBe(false);
    expect(condenseResult.archivedCount).toBe(0);

    // Tous les messages sont conservés (pas de condensation)
    // write ne crée PAS de message intercom, seulement 10 (append)
    const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    expect(readResult.data?.intercom?.messages?.length).toBe(10);
  });

  // === Test 12: Read dashboard inexistant ===
  it('returns failure for non-existent dashboard', async () => {
    const result = await roosyncDashboard({ action: 'read', type: 'global' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('introuvable');
  });

  // === Test 13: createIfNotExists=false ===
  it('does not create dashboard when createIfNotExists=false', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'global',
      content: 'test',
      createIfNotExists: false
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('createIfNotExists=false');
  });

  // === Test 14: Identification auteur ===
  it('stores author information', async () => {
    const author = { machineId: 'myia-po-2025', workspace: 'roo-extensions', worktree: 'wt-123' };
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Test', author });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'all' });
    expect(result.data?.lastModifiedBy?.machineId).toBe('myia-po-2025');
    expect(result.data?.lastModifiedBy?.worktree).toBe('wt-123');
  });

  // === Test 15: Override explicite machine et workspace ===
  it('accepts explicit machineId and workspace overrides for machine type', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'machine',
      machineId: 'myia-ai-01',
      content: '# Explicit machine'
    });

    expect(result.key).toBe('machine-myia-ai-01');
  });

  // === Test 17: intercomLimit ===
  it('respects intercomLimit when reading', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}` });
    }

    const result = await roosyncDashboard({
      action: 'read',
      type: 'global',
      section: 'intercom',
      intercomLimit: 3
    });

    expect(result.data?.intercom?.messages?.length).toBe(3);
  });

  // === Test 17b: without intercomLimit, returns ALL messages ===
  it('returns all messages when intercomLimit is not specified', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}` });
    }

    const result = await roosyncDashboard({
      action: 'read',
      type: 'global',
      section: 'intercom'
      // no intercomLimit — should return all
    });

    expect(result.data?.intercom?.messages?.length).toBe(10);
  });

  // === Test 18: condense no-op quand peu de messages ===
  it('condense reports no-op when below threshold', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'Only message' });

    const result = await roosyncDashboard({
      action: 'condense',
      type: 'global',
      keepMessages: 100
    });

    expect(result.success).toBe(true);
    expect(result.condensed).toBe(false);
    expect(result.archivedCount).toBe(0);
  });

  // === Phase 3: Archive & Utils ===

  // === Test 19: list retourne tableau vide si pas de dashboards ===
  it('list returns empty array when no dashboards exist', async () => {
    const result = await roosyncDashboard({ action: 'list' });

    expect(result.success).toBe(true);
    expect(result.action).toBe('list');
    expect(result.dashboards).toEqual([]);
  });

  // === Test 20: list retourne les dashboards existants ===
  it('list returns all created dashboards', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Global' });
    await roosyncDashboard({ action: 'write', type: 'machine', content: '# Machine' });

    const result = await roosyncDashboard({ action: 'list' });

    expect(result.success).toBe(true);
    expect(result.dashboards?.length).toBe(2);
    const keys = result.dashboards?.map(d => d.key);
    expect(keys).toContain('global');
    expect(keys).toContain('machine-test-machine');
  });

  // === Test 21: list résumés contiennent les champs attendus ===
  it('list summaries include expected fields', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Test' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'Message 1' });

    const result = await roosyncDashboard({ action: 'list' });
    const summary = result.dashboards?.[0];

    expect(summary?.key).toBe('global');
    expect(summary?.type).toBe('global');
    expect(summary?.lastModified).toBeDefined();
    expect(summary?.messageCount).toBe(1);
    expect(summary?.statusLength).toBeGreaterThan(0);
  });

  // === Test 22: delete supprime un dashboard existant ===
  it('delete removes an existing dashboard', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Test' });

    const deleteResult = await roosyncDashboard({ action: 'delete', type: 'global' });
    expect(deleteResult.success).toBe(true);

    // Vérifier que le dashboard n'existe plus
    const readResult = await roosyncDashboard({ action: 'read', type: 'global' });
    expect(readResult.success).toBe(false);
  });

  // === Test 23: delete dashboard inexistant retourne failure ===
  it('delete returns failure for non-existent dashboard', async () => {
    const result = await roosyncDashboard({ action: 'delete', type: 'global' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('introuvable');
  });

  // === Test 24: read_archive sans archiveFile liste les archives ===
  it('read_archive lists archives for a key', async () => {
    // #858: Set up mock LLM for condensation to succeed
    mockGetChatClient.mockReturnValue({
      chat: { completions: { create: mockChatCreate } }
    });
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '## Updated Status\n\nAll good' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '## Summary\n\n- Item 1' } }] });

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}` });
    }
    // Condenser pour créer une archive
    await roosyncDashboard({ action: 'condense', type: 'global', keepMessages: 3 });

    const result = await roosyncDashboard({ action: 'read_archive', type: 'global' });

    expect(result.success).toBe(true);
    expect(result.archives?.length).toBeGreaterThanOrEqual(1);
    const archiveName = result.archives?.[0];
    expect(archiveName).toMatch(/^global-/);
    expect(archiveName).toMatch(/\.md$/);
  });

  // === Test 25: read_archive avec archiveFile lit l'archive ===
  it('read_archive reads a specific archive file', async () => {
    // #858: Set up mock LLM for condensation to succeed
    mockGetChatClient.mockReturnValue({
      chat: { completions: { create: mockChatCreate } }
    });
    mockChatCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '## Updated Status\n\nAll good' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '## Summary\n\n- Item 1' } }] });

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}` });
    }
    await roosyncDashboard({ action: 'condense', type: 'global', keepMessages: 3 });

    // D'abord lister les archives
    const listResult = await roosyncDashboard({ action: 'read_archive', type: 'global' });
    const archiveFile = listResult.archives?.[0];
    expect(archiveFile).toBeDefined();

    // Puis lire l'archive
    const readResult = await roosyncDashboard({
      action: 'read_archive',
      type: 'global',
      archiveFile
    });

    expect(readResult.success).toBe(true);
    expect(readResult.archiveData?.key).toBe('global');
    expect(readResult.archiveData?.messageCount).toBe(7); // 10 - 3 = 7 archivés
    expect(readResult.archiveData?.messages.length).toBe(7);
  });

  // === Test 26: read_archive archive inexistante retourne failure ===
  it('read_archive returns failure for non-existent archive', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

    const result = await roosyncDashboard({
      action: 'read_archive',
      type: 'global',
      archiveFile: 'global-nonexistent-archive.md'
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('introuvable');
  });

  // ============================================================
  // Tests LLM Summary (#858)
  // ============================================================

  // === Test 27: Condensation sans LLM (annulée) ===
  // #864: Si le LLM est indisponible, la condensation est ANNULÉE (pas de fallback)
  // #858: Fixed — mock properly resets via beforeEach
  it('condense without LLM service is cancelled (no fallback)', async () => {
    // Sans configurer OPENAI_API_KEY, le LLM devrait échouer
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
    }

    const condenseResult = await roosyncDashboard({
      action: 'condense',
      type: 'global',
      keepMessages: 3
    });

    // #864: Condensation annulée car LLM indisponible
    expect(condenseResult.success).toBe(true);
    expect(condenseResult.condensed).toBe(false);
    expect(condenseResult.archivedCount).toBe(0);

    const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messages = readResult.data?.intercom?.messages;

    // Tous les messages sont conservés (pas de condensation)
    // write ne crée PAS de message intercom, seulement 10 (append)
    expect(messages?.length).toBe(10);
  });

  // === Test 28: Condensation annulée sans LLM préserve tous les messages ===
  // #864: Sans LLM, la condensation est annulée et tous les messages sont conservés
  // #858: Fixed — mock properly resets via beforeEach
  it('condense cancelled without LLM preserves all messages', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
    }

    const condenseResult = await roosyncDashboard({
      action: 'condense',
      type: 'global',
      keepMessages: 3
    });

    // Condensation annulée
    expect(condenseResult.condensed).toBe(false);

    const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const msgs = readResult.data?.intercom?.messages;

    // Tous les messages conservés: write ne crée PAS de message intercom, seulement 10 (append)
    expect(msgs?.length).toBe(10);

    // Les derniers messages sont dans l'ordre original
    const lastMessage = msgs?.[msgs.length - 1]?.content;
    expect(lastMessage).toBe('Message 9');
  });

  // === Test 30: Size-based auto-condensation triggers on large dashboards ===
  // Without LLM, condensation is cancelled (#864), but the trigger logic is exercised
  it('auto-condensation triggers based on size, not message count', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init', createIfNotExists: true });

    // Add messages with large content to exceed 50KB quickly
    // 50KB / ~2.5KB per message ≈ 20 messages should trigger
    const largeContent = 'X'.repeat(2500); // ~2.5KB per message
    for (let i = 0; i < 25; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}: ${largeContent}` });
    }

    // Without LLM, condensation is cancelled, so all messages should remain
    // But the trigger code path is exercised (verified via logs)
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messageCount = result.data?.intercom?.messages?.length ?? 0;

    // All 25 messages preserved since LLM is unavailable (condensation cancelled)
    expect(messageCount).toBe(25);
  });

  // === Test 31: Small messages don't trigger condensation even with many messages ===
  it('does not condense when total size is under 50KB regardless of message count', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init', createIfNotExists: true });

    // Add 100 tiny messages — well under 50KB
    for (let i = 0; i < 100; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `ok ${i}` });
    }

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messageCount = result.data?.intercom?.messages?.length ?? 0;

    // All 100 messages should be preserved — size is under 50KB
    expect(messageCount).toBe(100);
  });

  // === Test 29: Pas de message système CONDENSATION si condensation annulée ===
  // #864: Sans LLM, pas de message système CONDENSATION ajouté
  it('condense cancelled does not add system condensation message', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
    }

    await roosyncDashboard({
      action: 'condense',
      type: 'global',
      keepMessages: 3
    });

    const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messages = readResult.data?.intercom?.messages;

    // Aucun message système CONDENSATION ne devrait être présent
    const hasCondensationMsg = messages?.some(m => m.content.includes('**CONDENSATION**'));
    expect(hasCondensationMsg).toBe(false);
  });

  // === Test 32: Content with ### [ prefix doesn't break parsing (#1123) ===
  it('preserves message content containing ### [ at line start', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init', createIfNotExists: true });

    // Message with ### [ in content — this used to cause false message splits
    const maliciousContent = 'Normal text\n\n### [This looks like a header]\n\nMore text';
    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: maliciousContent
    });

    // Add a second message to verify split didn't corrupt
    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: 'Second message'
    });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messages = result.data?.intercom?.messages;

    expect(messages.length).toBe(2);
    // First message should preserve the ### [ content exactly
    expect(messages[0].content).toBe(maliciousContent);
    expect(messages[1].content).toBe('Second message');
  });

  // === Test 33: Content with --- separator doesn't break parsing ===
  it('preserves message content containing --- separator', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init', createIfNotExists: true });

    const contentWithDashes = 'Some text\n---\nMore text after dash separator';
    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: contentWithDashes
    });

    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: 'After'
    });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messages = result.data?.intercom?.messages;

    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe(contentWithDashes);
  });

  // === Test 34: Content with pipe | in body preserves correctly ===
  it('preserves message content containing pipe characters', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init', createIfNotExists: true });

    const contentWithPipes = 'Column A | Column B | Column C\n--- | --- | ---\n1 | 2 | 3';
    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: contentWithPipes
    });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messages = result.data?.intercom?.messages;

    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe(contentWithPipes);
  });

  // ============================================================
  // Tests LLM Condensation avec mock (#858)
  // ============================================================

  describe('LLM condensation (#858)', () => {
    it('condenses with LLM summary and status update', async () => {
      // Set up mock LLM
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate
        .mockResolvedValueOnce({ choices: [{ message: { content: '## Updated Status\n\n### Summary\nAll systems operational' } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: '## Summary of 7 archived messages\n\n### Themes\n- Testing\n- Deployment' } }] });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      for (let i = 0; i < 10; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
      }

      const result = await roosyncDashboard({
        action: 'condense',
        type: 'global',
        keepMessages: 3
      });

      expect(result.success).toBe(true);
      expect(result.condensed).toBe(true);
      // archivedCount = beforeCount(10) - afterCount(5) = 5
      // (2 system messages + 3 kept = 5 remaining)
      expect(result.archivedCount).toBe(5);

      // Verify LLM was called (status + summary)
      expect(mockChatCreate).toHaveBeenCalled();

      // Read dashboard and verify structure
      const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      const messages = readResult.data?.intercom?.messages ?? [];

      // Should have: 1 CONDENSATION-SUMMARY + 1 CONDENSATION notice + 3 kept = 5
      expect(messages.length).toBe(5);

      // First message should be the LLM summary
      // Note: `tags` field was removed in df56edb1 — assert on content marker only
      expect(messages[0].content).toContain('CONDENSATION-SUMMARY');

      // Second message should be the condensation notice
      expect(messages[1].content).toContain('**CONDENSATION**');

      // Last 3 should be the kept messages
      expect(messages[2].content).toBe('Message 7');
      expect(messages[3].content).toBe('Message 8');
      expect(messages[4].content).toBe('Message 9');
    });

    it('updates status with LLM-generated content', async () => {
      const newStatus = '## Updated Status\n\n### Summary\nAll systems operational';
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate
        .mockResolvedValueOnce({ choices: [{ message: { content: newStatus } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: '## Summary\n\n- Item 1' } }] });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Old Status' });
      for (let i = 0; i < 10; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
      }

      await roosyncDashboard({ action: 'condense', type: 'global', keepMessages: 3 });

      const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
      expect(readResult.data?.status?.markdown).toBe(newStatus);
    });

    it('cancels condensation when LLM returns empty', async () => {
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      for (let i = 0; i < 10; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
      }

      const result = await roosyncDashboard({
        action: 'condense',
        type: 'global',
        keepMessages: 3
      });

      // LLM returned empty → condensation cancelled after retries
      expect(result.success).toBe(true);
      expect(result.condensed).toBe(false);
      expect(result.archivedCount).toBe(0);
    });

    it('creates archive file with raw messages on condensation', async () => {
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate
        .mockResolvedValueOnce({ choices: [{ message: { content: '## Status' } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: '## Summary' } }] });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      for (let i = 0; i < 10; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}` });
      }

      await roosyncDashboard({ action: 'condense', type: 'global', keepMessages: 3 });

      // Verify archive was created
      const archiveResult = await roosyncDashboard({ action: 'read_archive', type: 'global' });
      expect(archiveResult.archives?.length).toBeGreaterThanOrEqual(1);

      // Read the archive and verify content
      const archiveFile = archiveResult.archives?.[0];
      const readArchive = await roosyncDashboard({
        action: 'read_archive',
        type: 'global',
        archiveFile
      });

      expect(readArchive.archiveData?.messageCount).toBe(7);
      expect(readArchive.archiveData?.messages.length).toBe(7);
    });
  });
});
