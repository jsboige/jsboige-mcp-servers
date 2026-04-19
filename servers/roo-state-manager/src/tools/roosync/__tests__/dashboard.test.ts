/**
 * Tests unitaires pour roosync_dashboard (#675)
 *
 * @module tests/roosync/dashboard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, MentionSchema, detectStatusContradictions } from '../dashboard.js';
import { resolveMentionTarget } from '@/utils/dashboard-helpers';
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
  // Atomicity fix: Condensation cancelled now persists a visible [ERROR] system
  // message (deduplicated within 5 min), so LLM outages are visible instead of silent.
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

    // Tous les messages user sont conservés (pas de condensation) + 1 message system [ERROR]
    // write ne crée PAS de message intercom, 10 (append) + 1 (ERROR) = 11
    const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    expect(readResult.data?.intercom?.messages?.length).toBe(11);
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

    // Tous les messages user conservés + 1 message system [ERROR] persisté pour visibilité
    // write ne crée PAS de message intercom, 10 (append) + 1 (ERROR) = 11
    expect(messages?.length).toBe(11);
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

    // 10 messages user (append) + 1 message system [ERROR] = 11
    expect(msgs?.length).toBe(11);

    // Les 10 messages user sont dans l'ordre original
    for (let i = 0; i < 10; i++) {
      expect(msgs?.[i]?.content).toBe(`Message ${i}`);
      expect(msgs?.[i]?.author?.machineId).not.toBe('system');
    }

    // Le dernier message est le système [ERROR] CONDENSATION CANCELLED
    const lastMessage = msgs?.[msgs.length - 1];
    expect(lastMessage?.author?.machineId).toBe('system');
    expect(lastMessage?.content).toContain('[ERROR] CONDENSATION CANCELLED');
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

    // All 25 user messages preserved + 1 system [ERROR] (visibility fix) = 26
    expect(messageCount).toBe(26);
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

  describe('Mention parsing and filtering (#1363)', () => {
    beforeEach(async () => {
      // Initialize a global dashboard for mention tests
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Test Dashboard' });
    });

    it('detects machine mentions (@machine-id)', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Hey @myia-ai-01, please review this'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      expect(result.data?.intercom?.messages.length).toBe(1);
      expect(result.data?.intercom?.messages[0].content).toContain('@myia-ai-01');
    });

    it('detects agent mentions (@roo-*, @claude-*)', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Mentioning @roo-myia-ai-01 and @claude-myia-po-2023'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      expect(result.data?.intercom?.messages.length).toBe(1);
      const content = result.data?.intercom?.messages[0].content || '';
      expect(content).toContain('@roo-myia-ai-01');
      expect(content).toContain('@claude-myia-po-2023');
    });

    it('detects message mentions (@msg:id)', async () => {
      const appendResult = await roosyncDashboard({
        action: 'append',
        type: 'global',
        messageId: 'msg-123',
        content: 'Original message'
      });

      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Responding to @msg:msg-123 - this is great!'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      expect(result.data?.intercom?.messages.length).toBe(2);
      expect(result.data?.intercom?.messages[1].content).toContain('@msg:msg-123');
    });

    it('detects user mentions (@user)', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'FYI @jsboige, please check the dashboard'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      expect(result.data?.intercom?.messages.length).toBe(1);
      expect(result.data?.intercom?.messages[0].content).toContain('@jsboige');
    });

    it.skip('preserves custom messageId in append', async () => {
      const appendArgs: any = {
        action: 'append' as const,
        type: 'global' as const,
        messageId: 'custom-id-12345',
        content: 'Message with custom ID'
      };

      // Verify args has messageId before calling function
      expect(appendArgs.messageId).toBe('custom-id-12345');

      const appendResult = await roosyncDashboard(appendArgs);
      expect(appendResult.success).toBe(true);

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      expect(result.data?.intercom?.messages.length).toBe(1);
      expect(result.data?.intercom?.messages[0].id).toBe('custom-id-12345');
    });

    it('generates messageId automatically when not provided', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Message without custom ID'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      expect(result.data?.intercom?.messages.length).toBe(1);
      const messageId = result.data?.intercom?.messages[0].id || '';
      expect(messageId).toMatch(/^[^:]+:[^:]+:ic-\d{4}-\d{2}-\d{2}/); // v3 format: machineId:workspace:ic-YYYY-MM-DD
    });

    it('filters messages by mentionsOnly when machine is mentioned', async () => {
      // Add messages: some mention the test machine, others don't
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Message for @test-machine - important'
      });

      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Message for @other-machine - not relevant'
      });

      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: '@test-machine please respond to this'
      });

      // Read with mentionsOnly filter
      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom',
        mentionsOnly: true
      });

      // Should only return messages mentioning test-machine
      expect(result.data?.intercom?.messages.length).toBe(2);
      expect(result.data?.intercom?.messages[0].content).toContain('@test-machine');
      expect(result.data?.intercom?.messages[1].content).toContain('@test-machine');
    });

    it('handles multiple mentions in single message', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: '@myia-ai-01 and @jsboige: please check @msg:prev-msg for context'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom'
      });

      const content = result.data?.intercom?.messages[0].content || '';
      expect(content).toContain('@myia-ai-01');
      expect(content).toContain('@jsboige');
      expect(content).toContain('@msg:prev-msg');
    });

    it('does not filter non-mention patterns', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'Email: user@example.com and hash: #abc123 should not be treated as mentions'
      });

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom',
        mentionsOnly: true
      });

      // Should return 0 messages since no valid mentions
      expect(result.data?.intercom?.messages.length).toBe(0);
    });
  });

  // ========================================================================
  // v3 mentions and cross-post (#1363)
  // ========================================================================
  describe('v3 mentions and cross-post (#1363)', () => {
    describe('MentionSchema XOR validation', () => {
      it('accepts only userId', () => {
        const parsed = MentionSchema.safeParse({
          userId: { machineId: 'po-2023', workspace: 'roo-extensions' }
        });
        expect(parsed.success).toBe(true);
      });

      it('accepts only messageId', () => {
        const parsed = MentionSchema.safeParse({
          messageId: 'po-2023:roo-extensions:ic-2026-04-17T1234-abcd'
        });
        expect(parsed.success).toBe(true);
      });

      it('rejects both userId and messageId', () => {
        const parsed = MentionSchema.safeParse({
          userId: { machineId: 'po-2023', workspace: 'roo-extensions' },
          messageId: 'po-2023:roo-extensions:ic-2026-04-17T1234-abcd'
        });
        expect(parsed.success).toBe(false);
      });

      it('rejects neither userId nor messageId', () => {
        const parsed = MentionSchema.safeParse({ note: 'nothing' });
        expect(parsed.success).toBe(false);
      });
    });

    describe('resolveMentionTarget', () => {
      it('returns userId passthrough when mention has userId', () => {
        const target = resolveMentionTarget({
          userId: { machineId: 'po-2024', workspace: 'roo-extensions' }
        });
        expect(target).toEqual({ machineId: 'po-2024', workspace: 'roo-extensions' });
      });

      it('splits messageId on first two colons only', () => {
        const target = resolveMentionTarget({
          messageId: 'myia-ai-01:roo-extensions:ic-2026-04-17T0809-3lmh'
        });
        expect(target).toEqual({ machineId: 'myia-ai-01', workspace: 'roo-extensions' });
      });

      it('handles messageId with dashes and extra colons in third segment', () => {
        // Third segment can contain any chars; we only care about the first two segments.
        const target = resolveMentionTarget({
          messageId: 'po-2026:my-workspace:ic-2026-04-17T0809-3lmh:extra:suffix'
        });
        expect(target).toEqual({ machineId: 'po-2026', workspace: 'my-workspace' });
      });

      it('throws on malformed messageId (no colons)', () => {
        expect(() => resolveMentionTarget({ messageId: 'no-colons-here' }))
          .toThrow(/Invalid messageId format/);
      });

      it('throws on malformed messageId (single colon)', () => {
        expect(() => resolveMentionTarget({ messageId: 'only-one:colon' }))
          .toThrow(/Invalid messageId format/);
      });
    });

    describe('append with mentions[]', () => {
      it('accepts structured mentions array and returns success', async () => {
        const result = await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: 'Cross-machine ping with structured mentions',
          mentions: [
            { userId: { machineId: 'po-2023', workspace: 'roo-extensions' } },
            { userId: { machineId: 'po-2024', workspace: 'roo-extensions' }, note: 'review please' }
          ]
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('append');
      });
    });

    describe('append with crossPost[]', () => {
      it('replicates message to a different dashboard (global)', async () => {
        const result = await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: 'Important notice cross-posted to global',
          crossPost: [{ type: 'global' }],
          createIfNotExists: true
        });

        expect(result.success).toBe(true);
        expect(result.crossPost).toBeDefined();
        expect(result.crossPost!.length).toBe(1);
        expect(result.crossPost![0].key).toBe('global');
        expect(result.crossPost![0].ok).toBe(true);

        // Confirm the message was actually written to the global dashboard
        const readGlobal = await roosyncDashboard({
          action: 'read',
          type: 'global',
          section: 'intercom'
        });
        const found = (readGlobal.data?.intercom?.messages ?? [])
          .some(m => m.content.includes('Important notice cross-posted to global'));
        expect(found).toBe(true);
      });

      it('skips self-cross-post without duplicating (ok=true, no target write)', async () => {
        // First append creates the workspace dashboard; cross-post back to self should be a no-op.
        const result = await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: 'Self-cross-post should be skipped',
          crossPost: [{ type: 'workspace', workspace: 'test-workspace' }]
        });

        expect(result.success).toBe(true);
        expect(result.crossPost).toBeDefined();
        expect(result.crossPost!.length).toBe(1);
        expect(result.crossPost![0].ok).toBe(true);

        // Read back the source dashboard and verify the message appears exactly once.
        const read = await roosyncDashboard({
          action: 'read',
          type: 'workspace',
          section: 'intercom'
        });
        const count = (read.data?.intercom?.messages ?? [])
          .filter(m => m.content.includes('Self-cross-post should be skipped'))
          .length;
        expect(count).toBe(1);
      });

      it('reports error entry when cross-post target missing and createIfNotExists=false', async () => {
        // Ensure the source workspace dashboard exists first (default createIfNotExists=true)
        await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: 'Bootstrap source dashboard before cross-post test'
        });

        // Now attempt append with cross-post to a non-existent machine dashboard,
        // explicitly forbidding creation. Source exists → handleAppend reaches the
        // cross-post loop → target is missing → error entry is recorded.
        const result = await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: 'Attempting cross-post to non-existent machine dashboard',
          crossPost: [{ type: 'machine', machineId: 'does-not-exist' }],
          createIfNotExists: false
        });

        expect(result.crossPost).toBeDefined();
        expect(result.crossPost!.length).toBe(1);
        const entry = result.crossPost![0];
        expect(entry.key).toBe('machine-does-not-exist');
        expect(entry.ok).toBe(false);
        expect(typeof entry.error).toBe('string');
      });
    });

    describe('messageId v3 round-trip', () => {
      it('persists messageId in v3 format machineId:workspace:ic-YYYY-MM-DD...', async () => {
        await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: 'Message to inspect for v3 messageId format'
        });

        const read = await roosyncDashboard({
          action: 'read',
          type: 'workspace',
          section: 'intercom'
        });
        const messages = read.data?.intercom?.messages ?? [];
        expect(messages.length).toBeGreaterThan(0);
        const target = messages.find(m => m.content.includes('Message to inspect for v3 messageId format'));
        expect(target).toBeDefined();
        expect(target!.id).toMatch(/^test-machine:test-workspace:ic-\d{4}-\d{2}-\d{2}/);
      });
    });
  });

  // ============================================================
  // Tests detectStatusContradictions (#1502)
  // ============================================================
  describe('detectStatusContradictions (#1502)', () => {
    it('returns empty for a clean status with no contradictions', () => {
      const status = `## Status
### État des systèmes
- **vllm** : UP (source: 2026-04-18)
- **myia-ai-01** : online (source: 2026-04-18)`;
      const contradictions = detectStatusContradictions(status);
      expect(contradictions).toHaveLength(0);
    });

    it('detects UP vs DOWN contradiction for same entity', () => {
      const status = `## Status
- **vllm** : DOWN (ancien statut)
- vllm is now UP and running fine`;
      const contradictions = detectStatusContradictions(status);
      expect(contradictions.length).toBeGreaterThanOrEqual(1);
      const vllmContradiction = contradictions.find(c => c.entity === 'vllm');
      expect(vllmContradiction).toBeDefined();
      expect(vllmContradiction!.conflictingStates.length).toBeGreaterThanOrEqual(2);
    });

    it('detects actif vs inactif contradiction for a machine', () => {
      const status = `## Status
- myia-po-2024 est actif et fonctionne
- myia-po-2024 inactif ce matin`;
      const contradictions = detectStatusContradictions(status);
      const po2024 = contradictions.find(c => c.entity === 'myia-po-2024' || c.entity === 'po-2024');
      expect(po2024).toBeDefined();
    });

    it('detects terminé vs en cours contradiction for same entity', () => {
      const status = `## Status
- myia-ai-01 : tâche X terminée (PR merged)
- myia-ai-01 : tâche X en cours de déploiement`;
      const contradictions = detectStatusContradictions(status);
      const ai01 = contradictions.find(c => c.entity === 'myia-ai-01' || c.entity === 'ai-01');
      expect(ai01).toBeDefined();
    });

    it('does not flag a single state as contradiction', () => {
      const status = `## Status
- **vllm** : DOWN since yesterday`;
      const contradictions = detectStatusContradictions(status);
      expect(contradictions).toHaveLength(0);
    });

    it('handles empty status gracefully', () => {
      const contradictions = detectStatusContradictions('');
      expect(contradictions).toHaveLength(0);
    });

    it('detects multiple contradictory entities simultaneously', () => {
      const status = `## Status
- vllm : DOWN (ancien statut)
- vllm : UP et opérationnel (mis à jour)
- myia-web1 : offline ce matin
- myia-web1 : active et running maintenant`;
      const contradictions = detectStatusContradictions(status);
      expect(contradictions.length).toBeGreaterThanOrEqual(2);
    });
  });
});
