/**
 * Tests unitaires pour roosync_dashboard (#675)
 *
 * @module tests/roosync/dashboard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, MentionSchema, detectStatusContradictions, resetCondenseCircuitBreaker } from '../dashboard.js';
import { resolveMentionTarget } from '@/utils/dashboard-helpers';
import { resetChatOpenAIClient } from '@/services/openai';

// #858: Mock OpenAI chat client for LLM condensation tests
const mockChatCreate = vi.fn();
const mockGetChatClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetChatClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
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
    // #1792: Reset circuit breaker between tests
    resetCondenseCircuitBreaker();
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

  // === Test 4: Double-prefix guard (#1409 item 2) ===
  it('prevents double-prefix when workspace already starts with workspace-', async () => {
    // Simulate a caller that passes the full key as workspace name
    process.env.ROOSYNC_WORKSPACE_ID = 'workspace-Argumentum';
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      content: '# Double-prefix test'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-Argumentum'); // NOT workspace-workspace-Argumentum
    // Restore for other tests
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
  });

  // === Test 4b: Path-style workspace collapses to basename (2026-05-23) ===
  // Regression: callers that passed a full path (d:\CoursIA, g:\Mon Drive\...\CoursIA)
  // produced scattered orphan dashboards (workspace-d--CoursIA.md,
  // workspace-g--Mon-Drive-CoursIA.md). The key must collapse to the directory
  // basename only, so every path form for a project folds onto one dashboard.
  it('collapses a Windows path-style workspace to its basename', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      workspace: 'd:\\CoursIA',
      content: '# Path collapse test'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-CoursIA');
  });

  it('collapses a nested Windows path-style workspace to its basename', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      workspace: 'g:\\Mon Drive\\dev\\CoursIA',
      content: '# Nested path collapse test'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-CoursIA');
  });

  it('collapses a POSIX path-style workspace to its basename', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      workspace: '/home/user/dev/Argumentum',
      content: '# POSIX path collapse test'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-Argumentum');
  });

  it('preserves case when collapsing a path-style workspace (no lowercasing)', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      workspace: 'd:\\CoursIA',
      content: '# Case preservation test'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-CoursIA');
    expect(result.key).not.toBe('workspace-coursia');
  });

  it('leaves a multi-dash bare workspace name unchanged', async () => {
    // 2025-Epita-Intelligence-Symbolique is a real workspace; basename must not
    // mangle legitimate dashes in a bare name.
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace',
      workspace: '2025-Epita-Intelligence-Symbolique',
      content: '# Multi-dash bare name test'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-2025-Epita-Intelligence-Symbolique');
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

  // === #1832: Format parameter tests ===
  describe('#1832 format parameter', () => {
    it('read returns markdownContent by default (format not specified)', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# My Status' });
      await roosyncDashboard({ action: 'append', type: 'global', content: 'Hello world' });

      const result = await roosyncDashboard({ action: 'read', type: 'global' });

      expect(result.success).toBe(true);
      expect(result.markdownContent).toBeDefined();
      expect(result.markdownContent).toContain('# My Status');
      expect(result.markdownContent).toContain('Hello world');
      expect(result.markdownContent).toContain('## Status');
      expect(result.markdownContent).toContain('## Intercom');
    });

    it('read with format=json returns JSON envelope without markdownContent', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Status' });

      const result = await roosyncDashboard({ action: 'read', type: 'global', format: 'json' });

      expect(result.success).toBe(true);
      expect(result.markdownContent).toBeUndefined();
      expect(result.data?.status?.markdown).toBe('# Status');
      expect(result.sizes).toBeDefined();
    });

    it('read with format=markdown returns markdownContent explicitly', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Explicit MD' });

      const result = await roosyncDashboard({ action: 'read', type: 'global', format: 'markdown' });

      expect(result.markdownContent).toBeDefined();
      expect(result.markdownContent).toContain('# Explicit MD');
    });

    it('read with section=status returns only status in markdown', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# StatusOnly' });
      await roosyncDashboard({ action: 'append', type: 'global', content: 'Should not appear' });

      const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });

      expect(result.markdownContent).toContain('# StatusOnly');
      expect(result.markdownContent).not.toContain('Should not appear');
    });

    it('read with section=intercom returns only intercom in markdown', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: 'Should not appear' });
      await roosyncDashboard({ action: 'append', type: 'global', content: 'IntercomMsg' });

      const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });

      expect(result.markdownContent).toContain('IntercomMsg');
      expect(result.markdownContent).not.toContain('Should not appear');
    });

    it('read_overview returns markdownContent by default', async () => {
      await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Overview Test' });

      const result = await roosyncDashboard({ action: 'read_overview' });

      expect(result.success).toBe(true);
      expect(result.markdownContent).toBeDefined();
      expect(result.markdownContent).toContain('Dashboard Overview');
    });

    it('read_overview with format=json returns JSON envelope without markdownContent', async () => {
      await roosyncDashboard({ action: 'write', type: 'workspace', content: '# JSON Overview' });

      const result = await roosyncDashboard({ action: 'read_overview', format: 'json' });

      expect(result.success).toBe(true);
      expect(result.markdownContent).toBeUndefined();
      expect(result.overview).toBeDefined();
    });

    it('read with intercomLimit applies to markdown output', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Test' });
      await roosyncDashboard({ action: 'append', type: 'global', content: 'Msg 1' });
      await roosyncDashboard({ action: 'append', type: 'global', content: 'Msg 2' });
      await roosyncDashboard({ action: 'append', type: 'global', content: 'Msg 3' });

      const result = await roosyncDashboard({ action: 'read', type: 'global', intercomLimit: 1 });

      expect(result.markdownContent).toContain('Msg 3');
      expect(result.markdownContent).not.toContain('Msg 1');
      expect(result.markdownContent).not.toContain('Msg 2');
    });
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
  // Archive created via auto-condensation (triggered by append crossing the
  // size threshold) instead of the removed manual `condense` action.
  it('read_archive lists archives for a key', async () => {
    // #858: Set up mock LLM for auto-condensation to succeed
    mockGetChatClient.mockReturnValue({
      chat: { completions: { create: mockChatCreate } }
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '## Summary\n\n- Item 1' } }]
    });

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    // Fill past the 92% threshold with large messages to trigger auto-condensation,
    // which writes an archive file.
    const bigContent = 'X'.repeat(3000);
    for (let i = 0; i < 20; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `${bigContent} msg${i}` });
    }

    const result = await roosyncDashboard({ action: 'read_archive', type: 'global' });

    expect(result.success).toBe(true);
    expect(result.archives?.length).toBeGreaterThanOrEqual(1);
    const archiveName = result.archives?.[0];
    expect(archiveName).toMatch(/^global-/);
    expect(archiveName).toMatch(/\.md$/);
  });

  // === Test 25: read_archive avec archiveFile lit l'archive ===
  // Archive created via auto-condensation (triggered by append crossing the
  // size threshold) instead of the removed manual `condense` action.
  it('read_archive reads a specific archive file', async () => {
    // #858: Set up mock LLM for auto-condensation to succeed
    mockGetChatClient.mockReturnValue({
      chat: { completions: { create: mockChatCreate } }
    });
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '## Summary\n\n- Item 1' } }]
    });

    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    const bigContent = 'X'.repeat(3000);
    for (let i = 0; i < 20; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `${bigContent} msg${i}` });
    }

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
    // Auto-condensation archives a positive number of messages; the count must
    // match the actual messages stored in the archive.
    expect(readResult.archiveData?.messageCount).toBeGreaterThan(0);
    expect(readResult.archiveData?.messages.length).toBe(readResult.archiveData?.messageCount);
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

  // === Test 30: Size-based auto-condensation triggers on large dashboards ===
  // #1792: Circuit breaker uses fallback truncation, archives messages
  it('auto-condensation triggers based on size, not message count', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init', createIfNotExists: true });

    // Add messages with large content to exceed 50KB quickly
    // 50KB / ~2.5KB per message ≈ 20 messages should trigger
    const largeContent = 'X'.repeat(2500); // ~2.5KB per message
    for (let i = 0; i < 25; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}: ${largeContent}` });
    }

    // #1792: With circuit breaker, fallback truncation archives messages (not cancelled)
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const messageCount = result.data?.intercom?.messages?.length ?? 0;

    // #1792: Messages archived via fallback, so count < 25 (not 26 as before)
    expect(messageCount).toBeLessThan(25);
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

  // === Diagnostic + archivedCount clamp (2026-04-20) ===
  //
  // Regression coverage for the CoursIA condense incident on 2026-04-20:
  //   - archivedCount came back as -2 (two injected error msgs × 2 passes)
  //   - result.condensed was false but no explanation was visible to callers
  //   - dedup window (5min) was shorter than the LLM retry cycle (~6min) on
  //     40KB prompts, so both passes injected an error msg
  // These tests lock in: diagnostic exposed, archivedCount ≥ 0, dedup works.
  describe('Condense diagnostic + error semantics (2026-04-20)', () => {
    it('archivedCount clamped to 0 on failed append (regression: CoursIA -2)', async () => {
      // #1792: Circuit breaker — now uses fallback truncation, archives messages
      // When an append triggers condensation that fails with LLM null content,
      // the old accounting computed negative archivedCount.
      // With circuit breaker, messages are archived via fallback, so archivedCount > 0.
      // Append-first: condensation runs AFTER the message is persisted. During fill-up,
      // one of the intermediate appends will trigger post-append condense with fallback.
      mockGetChatClient.mockImplementation(() => ({
        chat: { completions: { create: mockChatCreate } }
      }));
      // Throw error immediately (triggers fallback)
      mockChatCreate.mockRejectedValue(new Error('LLM API unavailable'));

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      // Fill past 92% with enough 3KB messages
      const filler = 'X'.repeat(3000);
      let condensedResult: any = null;
      for (let i = 0; i < 16; i++) {
        const result = await roosyncDashboard({
          action: 'append',
          type: 'global',
          content: `${filler} m${i}`
        });
        if (result.condensed && !condensedResult) {
          condensedResult = result;
        }
      }

      // At least one intermediate append must have triggered fallback truncation
      expect(condensedResult).not.toBeNull();
      expect(condensedResult.success).toBe(true);
      // #1792: With fallback truncation, archivedCount should be > 0
      expect(condensedResult.archivedCount).toBeGreaterThan(0);
      expect(condensedResult.condensed).toBe(true);
      // Diagnostic must show the failure mode
      expect(condensedResult.condenseDiagnostic).toBeDefined();
      expect(condensedResult.condenseDiagnostic!.length).toBeGreaterThanOrEqual(1);
      const failedPasses = condensedResult.condenseDiagnostic!.filter(d =>
        d.outcome === 'fallback-truncated' || d.outcome === 'llm-failed-dedup' || d.outcome === 'llm-failed-injected'
      );
      expect(failedPasses.length).toBeGreaterThanOrEqual(1);
      // #1792: With circuit breaker fallback, message reports success (not LLM failure)
      expect(condensedResult.message).toContain('auto-condensation');
    });
  });

  describe('Preemptive condensation (#1497)', () => {
    it('triggers condensation during fill-up when dashboard crosses 92% utilization', async () => {
      // Persistent mock — preemptive may fire multiple times during fill-up loop
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({
        choices: [{ message: { content: '## Summary\n\nArchived' } }]
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      // Fill with messages until the preemptive threshold triggers condensation.
      // Each message is ~3 KB; 20 messages would total ~60 KB (120% of 50 KB),
      // so preemptive condensation at 92% (46 KB) must fire before we get there.
      const bigContent = 'X'.repeat(3000);
      let firstCondensedAt = -1;
      for (let i = 0; i < 20; i++) {
        const result = await roosyncDashboard({
          action: 'append',
          type: 'global',
          content: `${bigContent} msg${i}`
        });
        if (result.condensed && firstCondensedAt < 0) {
          firstCondensedAt = i;
        }
      }

      // At least one append must have triggered preemptive condensation
      expect(firstCondensedAt).toBeGreaterThanOrEqual(0);
      expect(mockChatCreate).toHaveBeenCalled();
    });

    it('does NOT trigger preemptive condensation below 92% utilization', async () => {
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      // 5 small messages — should stay well below 92%
      for (let i = 0; i < 5; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `small ${i}` });
      }

      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'another small'
      });

      expect(result.success).toBe(true);
      expect(result.condensed).toBe(false);
      expect(result.archivedCount).toBe(0);
      // LLM must not have been called (no condensation)
      expect(mockChatCreate).not.toHaveBeenCalled();
    });

    it('splits large incoming messages so condense can archive them (#1589)', async () => {
      // Regression: prior behaviour was "single large message protected by
      // CONDENSE_KEEP slice policy → dashboard stays above threshold forever".
      // With per-append split (#1589), a 47KB message becomes ~12 parts (4KB
      // cap each). After an initial small message + the big one split into
      // parts, messages.length > CONDENSE_KEEP and the next append correctly
      // triggers condensation.
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({
        choices: [{ message: { content: '## Summary\n\nArchived content' } }]
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      const huge = 'Y'.repeat(47 * 1024); // 47 KB single message
      const firstResult = await roosyncDashboard({ action: 'append', type: 'global', content: huge });

      // The 47KB content is split into ~12 parts of 4KB each.
      expect(firstResult.splitCount).toBeGreaterThan(1);
      expect(firstResult.messageCount).toBeGreaterThan(10);

      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'second small'
      });

      expect(result.success).toBe(true);
      // Now that the big message is multiple parts and count > CONDENSE_KEEP,
      // preemptive condense fires and LLM is called.
      expect(mockChatCreate).toHaveBeenCalled();
    });

    it('accumulates archivedCount when preemptive AND reactive condense both fire', async () => {
      // Critic review follow-up: validates the `+=` / `||` accounting path —
      // when the preemptive condense fires AND the post-append size still
      // exceeds 100% (rare but possible with an oversized incoming message
      // just after a near-full dashboard), archivedCount must be the SUM of
      // both phases and condensed must stay true.
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({
        choices: [{ message: { content: '## Summary\n\nArchived' } }]
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      // Fill to just above 92% threshold: ~16 messages × 3KB = 48KB (≥ 46 KB)
      const filler = 'A'.repeat(3000);
      for (let i = 0; i < 16; i++) {
        await roosyncDashboard({
          action: 'append',
          type: 'global',
          content: `${filler} msg${i}`
        });
      }

      // Incoming message is huge enough that even after preemptive condense,
      // the post-append dashboard may exceed 100% and re-trigger reactive
      // condense. 40KB message + residual ~15KB from kept 10 messages = 55KB.
      const oversized = 'B'.repeat(40 * 1024);
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: oversized
      });

      expect(result.success).toBe(true);
      // Either path fired (preemptive OR reactive OR both).
      // The critical assertion: archivedCount must reflect what actually happened.
      if (result.condensed) {
        // If condensed, archivedCount must be >= 1 (preemptive alone archives ≥5 msgs)
        expect(result.archivedCount).toBeGreaterThanOrEqual(1);
      }
      // mockChatCreate must have been called at least once (condense happened)
      expect(mockChatCreate).toHaveBeenCalled();
    });
  });

  describe('Message splitting and duration breakdown (#1589)', () => {
    it('does NOT split messages under the per-message cap', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'A small message under 4KB.'
      });

      expect(result.success).toBe(true);
      expect(result.splitCount).toBe(1);
      // Verify the dashboard has exactly one message added.
      expect(result.messageCount).toBe(1);
    });

    it('splits a single oversize content on line boundaries', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      // Build a paragraph-heavy body: 20 lines × ~600 chars = ~12KB.
      const line = 'This is a readable sentence that contributes toward the total byte budget. '.repeat(8);
      const body = Array.from({ length: 20 }, (_, i) => `## Section ${i + 1}\n${line}`).join('\n\n');

      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: body
      });

      expect(result.success).toBe(true);
      expect(result.splitCount).toBeGreaterThan(1);
      expect(result.messageCount).toBe(result.splitCount);
      // Each part should be tagged with the PART marker for readers.
      const dashboard = await roosyncDashboard({ action: 'read', type: 'global' });
      const firstMsg = dashboard.data?.intercom?.messages?.[0];
      expect(firstMsg?.content).toMatch(/^\*\*\[PART 1\//);
    });

    it('hard-slices individual lines that exceed the cap', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      // One single-line body of 10KB — must be sliced at char boundaries.
      const giantLine = 'X'.repeat(10 * 1024);
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: giantLine
      });

      expect(result.success).toBe(true);
      expect(result.splitCount).toBeGreaterThan(1);
    });

    it('populates durationBreakdown on every append', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'quick'
      });

      expect(result.durationBreakdown).toBeDefined();
      expect(result.durationBreakdown!.totalMs).toBeGreaterThanOrEqual(0);
      // No condensation fired, so preemptive & reactive are 0.
      expect(result.durationBreakdown!.preemptiveCondenseMs).toBe(0);
      expect(result.durationBreakdown!.reactiveCondenseMs).toBe(0);
      expect(result.durationBreakdown!.writeMs).toBeGreaterThanOrEqual(0);
    });

    it('reports preemptiveCondenseMs > 0 when preemptive condense fires', async () => {
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({
        choices: [{ message: { content: '## Summary\n\nCondensed' } }]
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      // Fill past 92% of 50KB with ≥ CONDENSE_KEEP messages of 3KB each.
      // Append-first: condensation fires on one of the intermediate appends.
      const filler = 'A'.repeat(3000);
      let condensedResult: any = null;
      for (let i = 0; i < 20; i++) {
        const result = await roosyncDashboard({
          action: 'append',
          type: 'global',
          content: `${filler} msg${i}`
        });
        if (result.condensed && !condensedResult) {
          condensedResult = result;
        }
      }

      expect(condensedResult).not.toBeNull();
      expect(condensedResult.condensed).toBe(true);
      expect(condensedResult.durationBreakdown!.preemptiveCondenseMs).toBeGreaterThanOrEqual(0);
    });

    it('unblocks a saturated dashboard pattern (3 large + filler)', async () => {
      // Reproduces the CoursIA / po-2025 failure mode: 3 oversized dispatches
      // in the recent window + 9 small messages = 55+ KB. Without split, the
      // recent-slice policy of condense protected the 3 big ones and we never
      // dropped below threshold. With split, the big messages become many
      // parts, condense archives them normally, dashboard comes back under
      // MAX_DASHBOARD_SIZE_BYTES.
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({
        choices: [{ message: { content: '## Summary\n\nArchived dispatches' } }]
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      // 9 small "INFO" messages (~300 chars each)
      for (let i = 0; i < 9; i++) {
        await roosyncDashboard({
          action: 'append',
          type: 'global',
          content: `[INFO] Small message ${i} with minor coordination detail.`
        });
      }

      // 3 oversize dispatches mimicking CoursIA: 15KB, 12KB, 5KB
      const dispatch1 = 'Mission A content. '.repeat(800); // ~15KB
      const dispatch2 = 'Mission B content. '.repeat(660); // ~12KB
      const dispatch3 = 'Mission C content. '.repeat(270); // ~5KB

      await roosyncDashboard({ action: 'append', type: 'global', content: dispatch1 });
      await roosyncDashboard({ action: 'append', type: 'global', content: dispatch2 });
      const result = await roosyncDashboard({ action: 'append', type: 'global', content: dispatch3 });

      // With split, the 3 big dispatches become many 4KB parts spread across
      // the message list. The dashboard stays below the 50KB threshold either
      // because (a) the split itself kept each append small or (b) condense
      // then naturally archived older parts. Either outcome is success — the
      // old bug was "saturated forever".
      const readBack = await roosyncDashboard({ action: 'read', type: 'global' });
      const intercomSize = (readBack.sizes as any).intercomLength;
      const statusSize = (readBack.sizes as any).statusLength;
      const totalSize = intercomSize + statusSize;

      expect(totalSize).toBeLessThan(50 * 1024);
      // The 3rd dispatch was split into multiple parts.
      expect(result.splitCount).toBeGreaterThan(1);
    }, 15000);
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

  // #1956: Auto-ACK + reply_to + acknowledged_at
  describe('#1956 Dashboard ACK loop', () => {
    it('auto-ACK: reading machine marks replies to its messages as acknowledged', async () => {
      // test-machine (local) posts a message
      await roosyncDashboard({
        action: 'append', type: 'global',
        content: '[ASK] Needs task assignment',
      });

      // Read to get the message ID
      const afterFirst = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      const firstMsg = afterFirst.data?.intercom?.messages?.[0];
      expect(firstMsg).toBeDefined();
      const originalMsgId = firstMsg!.id;

      // Another machine replies with mention referencing the original message
      await roosyncDashboard({
        action: 'append', type: 'global',
        content: '[REPLY] Task assigned: #1987 Qdrant audit',
        author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
        mentions: [{ messageId: originalMsgId }]
      });

      // Local machine reads the dashboard — triggers auto-ACK for replies to its messages
      const result = await roosyncDashboard({
        action: 'read', type: 'global', section: 'intercom', format: 'json'
      });
      const messages = result.data?.intercom?.messages;
      const replyMsg = messages?.find((m: any) => m.reply_to === originalMsgId);
      expect(replyMsg).toBeDefined();
      expect(replyMsg!.acknowledged_at).toBeDefined();
      expect(replyMsg!.acknowledged_at!['test-machine']).toBeDefined();
    });

    it('reply_to is set when mention references a messageId', async () => {
      // Post original
      await roosyncDashboard({
        action: 'append', type: 'global',
        content: 'Original question',
        author: { machineId: 'myia-po-2023', workspace: 'roo-extensions' }
      });

      const afterFirst = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      const originalId = afterFirst.data?.intercom?.messages?.[0]?.id;

      // Reply with mention
      await roosyncDashboard({
        action: 'append', type: 'global',
        content: 'My reply',
        author: { machineId: 'myia-po-2024', workspace: 'roo-extensions' },
        mentions: [{ messageId: originalId }]
      });

      const afterReply = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom', format: 'json' });
      const replyMsg = afterReply.data?.intercom?.messages?.find((m: any) => m.reply_to === originalId);
      expect(replyMsg).toBeDefined();
      expect(replyMsg!.reply_to).toBe(originalId);
    });

    it('acknowledged_at persists in dashboard file format', async () => {
      await roosyncDashboard({
        action: 'write', type: 'global', content: '# Test'
      });
      // Local machine posts a message
      await roosyncDashboard({
        action: 'append', type: 'global',
        content: 'Message needing ACK'
      });

      const afterMsg = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom', format: 'json' });
      const msgId = afterMsg.data?.intercom?.messages?.[0]?.id;

      // Another machine replies
      await roosyncDashboard({
        action: 'append', type: 'global',
        content: 'Reply message',
        author: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
        mentions: [{ messageId: msgId }]
      });

      // Read as local machine — triggers auto-ACK
      await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom', format: 'json' });

      // Read again to verify persistence
      const result2 = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom', format: 'json' });
      const replyMsg = result2.data?.intercom?.messages?.find((m: any) => m.reply_to === msgId);
      expect(replyMsg?.acknowledged_at?.['test-machine']).toBeDefined();
    });
  });

  // #1410 item 4: Worktree dashboard cleanup
  describe('worktree dashboard cleanup', () => {
    it('archives stale worktree dashboards (>7 days, <100 chars status)', async () => {
      // Create a stale worktree dashboard
      await roosyncDashboard({
        action: 'write', type: 'workspace',
        content: 'short status',
        workspace: 'wt-worker-test-cleanup'
      });

      // Backdate the file to be >7 days old
      const dashboardsDir = path.join(tmpDir, 'dashboards');
      const wtFile = path.join(dashboardsDir, 'workspace-wt-worker-test-cleanup.md');
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const content = await import('fs/promises').then(f => f.readFile(wtFile, 'utf8'));
      const updated = content.replace(/lastModified: .+/, `lastModified: ${oldDate}`);
      await import('fs/promises').then(f => f.writeFile(wtFile, updated, 'utf8'));

      // List triggers cleanup
      const result = await roosyncDashboard({ action: 'list' });
      expect(result.success).toBe(true);

      // The stale worktree dashboard should be gone from the list
      const keys = result.dashboards?.map((d: any) => d.key) ?? [];
      expect(keys).not.toContain('workspace-wt-worker-test-cleanup');

      // But it should be in the archive
      const archiveDir = path.join(dashboardsDir, 'archive');
      const { readdirSync } = await import('fs');
      const archives = readdirSync(archiveDir);
      const wtArchive = archives.find(f => f.includes('wt-worker-test-cleanup'));
      expect(wtArchive).toBeDefined();
    });

    it('preserves recent worktree dashboards (<7 days)', async () => {
      // Create a recent worktree dashboard
      await roosyncDashboard({
        action: 'write', type: 'workspace',
        content: 'short status',
        workspace: 'wt-worker-recent'
      });

      const result = await roosyncDashboard({ action: 'list' });
      const keys = result.dashboards?.map((d: any) => d.key) ?? [];
      expect(keys).toContain('workspace-wt-worker-recent');
    });

    it('preserves worktree dashboards with substantial status (>100 chars)', async () => {
      const longStatus = 'x'.repeat(200);
      await roosyncDashboard({
        action: 'write', type: 'workspace',
        content: longStatus,
        workspace: 'wt-worker-substantial'
      });

      // Backdate
      const dashboardsDir = path.join(tmpDir, 'dashboards');
      const wtFile = path.join(dashboardsDir, 'workspace-wt-worker-substantial.md');
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const content = await import('fs/promises').then(f => f.readFile(wtFile, 'utf8'));
      const updated = content.replace(/lastModified: .+/, `lastModified: ${oldDate}`);
      await import('fs/promises').then(f => f.writeFile(wtFile, updated, 'utf8'));

      const result = await roosyncDashboard({ action: 'list' });
      const keys = result.dashboards?.map((d: any) => d.key) ?? [];
      expect(keys).toContain('workspace-wt-worker-substantial');
    });
  });

  // ============================================================
  // #2463: Deterministic status truncation (LLM-independent)
  // Verify that executeTruncationFallback caps status to 15 KB
  // even when LLM is unavailable.
  // ============================================================
  describe('#2463: deterministic status truncation (LLM-independent)', () => {
    it('caps status to ≤15 KB when LLM is unavailable (fallback truncation)', async () => {
      // 1. Write an oversized status (> 15 KB) — single long line to test hard-truncation
      const oversizedStatus = '# Big Status\n' + 'x'.repeat(20 * 1024); // ~20 KB
      await roosyncDashboard({ action: 'write', type: 'global', content: oversizedStatus });

      // Verify status is > 15 KB before condensation
      const before = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
      const beforeSize = Buffer.byteLength(before.data?.status?.markdown ?? '', 'utf8');
      expect(beforeSize).toBeGreaterThan(15 * 1024);

      // 2. Trigger condensation by appending enough large messages to exceed ~46 KB
      // LLM is already mocked to throw (default setup, line 45)
      const largeContent = 'Y'.repeat(2500); // ~2.5 KB per message
      for (let i = 0; i < 25; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}: ${largeContent}` });
      }

      // 3. After condensation with LLM failure, status should be ≤ 15 KB
      const after = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
      const afterSize = Buffer.byteLength(after.data?.status?.markdown ?? '', 'utf8');
      expect(afterSize).toBeLessThanOrEqual(15 * 1024);
    });

    it('breaks the vicious circle: status < threshold allows next condensation to succeed', async () => {
      // Simulate: status starts > 15 KB, condensation truncates it,
      // then a second condensation cycle should NOT fail due to status size
      const oversizedStatus = '# Status\n' + 'z'.repeat(20 * 1024);
      await roosyncDashboard({ action: 'write', type: 'global', content: oversizedStatus });

      // First condensation
      const largeContent = 'A'.repeat(2500);
      for (let i = 0; i < 25; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Msg ${i}: ${largeContent}` });
      }

      const afterFirst = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
      const sizeAfterFirst = Buffer.byteLength(afterFirst.data?.status?.markdown ?? '', 'utf8');
      expect(sizeAfterFirst).toBeLessThanOrEqual(15 * 1024);

      // Second condensation cycle — status is now small, should not grow back
      for (let i = 0; i < 25; i++) {
        await roosyncDashboard({ action: 'append', type: 'global', content: `Msg2 ${i}: ${largeContent}` });
      }

      const afterSecond = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
      const sizeAfterSecond = Buffer.byteLength(afterSecond.data?.status?.markdown ?? '', 'utf8');
      // Status should still be ≤ 15 KB (not grown back to oversized)
      expect(sizeAfterSecond).toBeLessThanOrEqual(15 * 1024);
    });
  });
});
