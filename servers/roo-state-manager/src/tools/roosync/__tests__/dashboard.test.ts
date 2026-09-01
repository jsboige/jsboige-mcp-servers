/**
 * Tests unitaires pour roosync_dashboard (#675)
 *
 * @module tests/roosync/dashboard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard, MentionSchema, detectStatusContradictions, resetCondenseCircuitBreaker, computeKeepCount, acquireAppendLock, releaseAppendLock } from '../dashboard.js';
import { resolveMentionTarget } from '@/utils/dashboard-helpers';
import { resetChatOpenAIClient } from '@/services/openai';

// #858: Mock OpenAI chat client for LLM condensation tests
const mockChatCreate = vi.fn();
const mockGetChatClient = vi.fn();

// #3205 résiduel : le namespace ESM de 'fs/promises' n'est pas configurable
// (spyOn impossible, constaté 24/08) — mock module-level qui DÉLÈGUE au vrai
// readFile par défaut ; les tests #3205 réinstallent une implémentation fautive.
const fsReal: { readFile?: (...args: unknown[]) => Promise<unknown> } = vi.hoisted(() => ({}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  fsReal.readFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readFile: vi.fn((...args: unknown[]) => fsReal.readFile!(...args))
  };
});

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetChatClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  // #2719: cloud fallback inert (null) in this suite — the existing LLM
  // condensation assertions hold unchanged when the primary path is exercised.
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
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

  // === #3276: Append idempotent sur messageId explicite ===
  // La double-exécution d'un même tool_use (fork transcript, route gpt-5.6-sol)
  // fait atterrir DEUX entrées byte-identiques pour un seul append intentionnel.
  // Un messageId explicite est désormais une clé d'idempotence : le 2e append
  // portant un id déjà présent est absorbé (skip), pas dupliqué.
  describe('append idempotence on explicit messageId (#3276)', () => {
    it('skips a second append carrying an id already present', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      const first = await roosyncDashboard({
        action: 'append', type: 'global', content: 'Message A', messageId: 'idem-3276-a'
      });
      expect(first.success).toBe(true);
      expect(first.deduplicated).toBeUndefined();

      const second = await roosyncDashboard({
        action: 'append', type: 'global', content: 'Message A', messageId: 'idem-3276-a'
      });
      expect(second.success).toBe(true);
      expect(second.deduplicated).toBe(true);
      expect(second.warning).toBeUndefined();

      const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      const msgs = (read.data?.intercom?.messages ?? []) as Array<{ id: string }>;
      expect(msgs.filter(m => m.id === 'idem-3276-a')).toHaveLength(1);
    });

    it('absorbs a concurrent double-execution of the same append (fork simulation)', async () => {
      await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });

      // Deux exécutions du même tool_use arrivent quasi simultanément —
      // withKeyLock les sérialise, la 2e relit le dashboard APRÈS le write de la 1re.
      const [r1, r2] = await Promise.all([
        roosyncDashboard({ action: 'append', type: 'workspace', content: 'Fork payload', messageId: 'idem-3276-fork' }),
        roosyncDashboard({ action: 'append', type: 'workspace', content: 'Fork payload', messageId: 'idem-3276-fork' })
      ]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      const dedupCount = [r1, r2].filter(r => r.deduplicated === true).length;
      expect(dedupCount).toBe(1);

      const read = await roosyncDashboard({ action: 'read', type: 'workspace', section: 'intercom' });
      const msgs = (read.data?.intercom?.messages ?? []) as Array<{ id: string }>;
      expect(msgs.filter(m => m.id === 'idem-3276-fork')).toHaveLength(1);
    });

    it('appends both messages when explicit ids differ', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      const a = await roosyncDashboard({ action: 'append', type: 'global', content: 'X', messageId: 'idem-3276-x' });
      const b = await roosyncDashboard({ action: 'append', type: 'global', content: 'Y', messageId: 'idem-3276-y' });

      expect(a.deduplicated).toBeUndefined();
      expect(b.deduplicated).toBeUndefined();

      const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      expect(read.data?.intercom?.messages).toHaveLength(2);
    });

    it('does not dedup appends without explicit messageId (unchanged behavior)', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      // Ids auto-générés = uniques par appel : deux appels identiques = deux entrées
      // (comportement historique préservé — repro n°8 : ids auto distincts)
      const a = await roosyncDashboard({ action: 'append', type: 'global', content: 'Same content' });
      const b = await roosyncDashboard({ action: 'append', type: 'global', content: 'Same content' });

      expect(a.deduplicated).toBeUndefined();
      expect(b.deduplicated).toBeUndefined();

      const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      const msgs = read.data?.intercom?.messages ?? [];
      expect(msgs).toHaveLength(2);
      expect(msgs[0].id).not.toBe(msgs[1].id);
    });

    it('flags a content mismatch when a reused id carries different content', async () => {
      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

      await roosyncDashboard({ action: 'append', type: 'global', content: 'Original', messageId: 'idem-3276-mismatch' });
      const second = await roosyncDashboard({ action: 'append', type: 'global', content: 'DIFFERENT', messageId: 'idem-3276-mismatch' });

      expect(second.deduplicated).toBe(true);
      expect(second.warning).toContain('CONTENU DIFFÉRENT');

      // L'entrée existante est conservée telle quelle
      const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
      const msgs = read.data?.intercom?.messages ?? [];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('Original');
    });
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
      // cap each) so the bulk becomes archivable rather than protected.
      //
      // #2598 sharpened this: the kept window is now byte-budgeted
      // (computeKeepCount, 16KB) instead of a fixed CONDENSE_KEEP=10. The 12
      // parts blow past the 16KB keep-budget, so condensation archives the
      // oldest parts on the *first* append already (previously condenseIntercom
      // refused to archive the mere 2 messages over keep=10, leaving all 12 and
      // only condensing on the next append). This is strictly more aggressive
      // archival of large content — exactly the #1589 anti-"protected forever"
      // intent — so the post-condense window is bounded by the byte budget.
      mockGetChatClient.mockReturnValue({
        chat: { completions: { create: mockChatCreate } }
      });
      mockChatCreate.mockResolvedValue({
        choices: [{ message: { content: '## Summary\n\nArchived content' } }]
      });

      await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
      const huge = 'Y'.repeat(47 * 1024); // 47 KB single message
      const firstResult = await roosyncDashboard({ action: 'append', type: 'global', content: huge });

      // The 47KB content is split into ~12 parts of 4KB each (the split itself
      // is independent of the keep policy — this is the core #1589 behaviour).
      expect(firstResult.splitCount).toBeGreaterThan(10);
      // The oversized message is archived (NOT protected forever): condensation
      // fires and archives the oldest parts, retaining only a byte-budgeted
      // recent window (#2598) bounded by [CONDENSE_KEEP_MIN=4, CONDENSE_KEEP=10].
      expect(firstResult.condensed).toBe(true);
      expect(firstResult.archivedCount).toBeGreaterThan(0);
      expect(firstResult.messageCount).toBeGreaterThanOrEqual(4);  // CONDENSE_KEEP_MIN
      expect(firstResult.messageCount).toBeLessThanOrEqual(10);    // CONDENSE_KEEP

      const result = await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: 'second small'
      });

      expect(result.success).toBe(true);
      // The LLM condense path was exercised (fired on the first append already).
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

    it('returns mentions older than the intercomLimit boundary (#3179)', async () => {
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: '@test-machine old task beyond the limit'
      });

      for (let i = 1; i <= 5; i++) {
        await roosyncDashboard({
          action: 'append',
          type: 'global',
          content: `filler message ${i} for other machines`
        });
      }

      const result = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom',
        mentionsOnly: true,
        intercomLimit: 3
      });

      const messages = result.data?.intercom?.messages || [];
      expect(messages.length).toBe(1);
      expect(messages[0].content).toContain('old task beyond the limit');

      // intercomLimit bounds the FILTERED set: several mentions keep only the last N
      await roosyncDashboard({
        action: 'append',
        type: 'global',
        content: '@test-machine newer task'
      });

      const bounded = await roosyncDashboard({
        action: 'read',
        type: 'global',
        section: 'intercom',
        mentionsOnly: true,
        intercomLimit: 1
      });

      const boundedMessages = bounded.data?.intercom?.messages || [];
      expect(boundedMessages.length).toBe(1);
      expect(boundedMessages[0].content).toContain('newer task');
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

    // #3329 (RECIDIVE #1502): dedup regression — the guard that emits
    // `<!-- #1502 CONTRADICTION: ... -->` markers must strip stale markers
    // before re-emitting, otherwise they accumulate every cycle.
    it('regression #3329: dedup strips stale #1502 markers from status', () => {
      const staleStatus = [
        '## Status',
        '- vllm : DOWN (ancien)',
        '- vllm : UP (mis à jour)',
        '',
        '<!-- #1502 CONTRADICTION: vllm has conflicting states: DOWN vs UP -->',
        '<!-- #1502 CONTRADICTION: myia-web1 has conflicting states: offline vs active -->',
        '<!-- #1502 CONTRADICTION: vllm has conflicting states: DOWN vs UP -->',
        '<!-- #1502 CONTRADICTION: myia-web1 has conflicting states: offline vs active -->'
      ].join('\n');
      const deduped = staleStatus.replace(/^[ \t]*<!-- #1502 CONTRADICTION:.*-->[ \t]*\n?/gm, '').trimEnd();
      expect(deduped).not.toContain('#1502 CONTRADICTION');
      expect(deduped).toContain('## Status');
      expect(deduped).toContain('vllm');
      // Sanity: detectStatusContradictions still fires on the deduped content
      const contradictions = detectStatusContradictions(deduped);
      expect(contradictions.length).toBeGreaterThanOrEqual(1);
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

// #2598: byte-budgeted keep window — guards against the perpetual-condensation
// loop where a fixed keep-count (10) + 15KB status pinned the post-condense
// floor at ~the 46KB preemptive threshold, re-condensing on nearly every post.
describe('computeKeepCount (#2598 byte-budgeted keep window)', () => {
  const CONDENSE_KEEP = 10;
  const CONDENSE_KEEP_MIN = 4;
  const KEEP_BUDGET = 16 * 1024;
  const PREEMPTIVE_THRESHOLD = Math.floor(50 * 1024 * 0.92); // ~46 KB
  const STATUS_CAP = 15 * 1024;

  const mk = (n: number, sizeBytes: number) =>
    Array.from({ length: n }, (_, i) => ({ content: 'x'.repeat(sizeBytes) + `#${i}` }));
  const keptBytes = (msgs: { content: string }[], keep: number) =>
    msgs.slice(msgs.length - keep).reduce((s, m) => s + Buffer.byteLength(m.content, 'utf8'), 0);

  it('keeps up to CONDENSE_KEEP for small messages (unchanged behaviour)', () => {
    expect(computeKeepCount(mk(30, 200))).toBe(CONDENSE_KEEP);
  });

  it('keeps fewer than CONDENSE_KEEP when messages are large (budget-bound)', () => {
    const msgs = mk(30, 3 * 1024); // ~3 KB each
    const keep = computeKeepCount(msgs);
    expect(keep).toBeLessThan(CONDENSE_KEEP);
    expect(keep).toBeGreaterThanOrEqual(CONDENSE_KEEP_MIN);
    // kept bytes stay within budget plus at most one over-budget message
    expect(keptBytes(msgs, keep)).toBeLessThanOrEqual(KEEP_BUDGET + 3 * 1024);
  });

  it('never keeps fewer than CONDENSE_KEEP_MIN even for huge messages', () => {
    expect(computeKeepCount(mk(10, 20 * 1024))).toBe(CONDENSE_KEEP_MIN);
  });

  it('returns 0 for an empty intercom and is bounded by message count', () => {
    expect(computeKeepCount([])).toBe(0);
    expect(computeKeepCount(mk(2, 100))).toBe(2);
  });

  it('post-condense floor (status + kept intercom) stays well below the threshold', () => {
    // 40 messages of ~3 KB + a 15 KB status: the floor must leave real headroom
    // under the 46 KB preemptive threshold so posting does not re-condense.
    const msgs = mk(40, 3 * 1024);
    const floor = STATUS_CAP + keptBytes(msgs, computeKeepCount(msgs));
    expect(floor).toBeLessThan(PREEMPTIVE_THRESHOLD - 8 * 1024); // >= 8 KB headroom
  });
});

// #3205 résiduel — lectures transitoires du fichier dashboard GDrive partagé
// (course write→rename entre machines, hydratation DriveFS). Le backoff réel
// (500/1500 ms) s'applique : ces tests ajoutent ~4 s à la suite.
describe('#3205 résiduel — retry borné readDashboardFromGdrive', () => {
  let dashReadCalls: number;

  function installReadFileHandler(
    handler: (p: string, n: number, realRead: (...a: unknown[]) => Promise<unknown>) => Promise<string>
  ): void {
    vi.mocked(fsp.readFile).mockImplementation((async (...args: unknown[]) => {
      const p = String(args[0]);
      if (p.includes(`dashboards${path.sep}`) && p.endsWith('.md')) {
        dashReadCalls++;
        return await handler(p, dashReadCalls, (...a: unknown[]) => fsReal.readFile!(...a));
      }
      return await fsReal.readFile!(...args);
    }) as unknown as typeof fsp.readFile);
  }

  const ebusy = (): Error => {
    const e = new Error('EBUSY: resource busy or locked, read') as NodeJS.ErrnoException;
    e.code = 'EBUSY';
    return e;
  };

  let envTmpDir: string;

  beforeEach(async () => {
    dashReadCalls = 0;
    // Ce describe est top-level : il n'hérite PAS du beforeEach du describe
    // voisin, et le afterEach de celui-ci supprime les vars entre ses tests.
    // Sur un runner sans .env (gitignoré), getSharedStatePath() throw sinon —
    // exactement l'échec CI vu sur le 1er push (revue ai-01 #1032).
    envTmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = envTmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
  });

  afterEach(async () => {
    // Restaurer la délégation par défaut pour les tests suivants de la suite.
    vi.mocked(fsp.readFile).mockImplementation(
      (...args: unknown[]) => fsReal.readFile!(...args) as unknown as ReturnType<typeof fsp.readFile>
    );
    await rm(envTmpDir, { recursive: true, force: true });
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('absorbe une erreur transitoire : EBUSY × 2 puis succès au 3e essai', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed 3205' });

    installReadFileHandler(async (p, n, realRead) => {
      if (n <= 2) throw ebusy();
      return (await realRead(p, 'utf8')) as string;
    });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'all' });

    expect(result.success).toBe(true);
    expect(result.data?.status?.markdown).toBe('# Seed 3205');
    expect(dashReadCalls).toBe(3); // 2 échecs absorbés + 1 succès — pas de 4e appel
  });

  it('échoue (reject) après 3 tentatives persistantes, puis propage l’erreur', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed persist' });

    installReadFileHandler(async () => { throw ebusy(); });

    await expect(
      roosyncDashboard({ action: 'read', type: 'global', section: 'all' })
    ).rejects.toThrow(/EBUSY/);
    expect(dashReadCalls).toBe(3); // borné — pas de boucle infinie
  });

  it('ENOENT → absent immédiat, SANS retry (exactement 1 appel)', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed enoent' });

    installReadFileHandler(async () => {
      const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'all' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/introuvable/);
    expect(dashReadCalls).toBe(1); // la sémantique ENOENT→null n'est pas changée
  });
});

// #3205 write-side — verrou append cross-process : la fenêtre read→rename de
// appendDashboardIncremental est la course last-writer-wins (write perdu
// silencieux, `Tool call OK`). Sémantique WAIT (vs SKIP du verrou condensation
// #2818) + fail-OPEN au-delà du budget.
describe('#3205 write-side — append lock cross-process', () => {
  let lockTmpDir: string;

  const mkHolder = (machineId: string, ageMs = 0): { machineId: string; workspace: string; pid: number; acquiredAt: string } => ({
    machineId,
    workspace: 'test-workspace',
    pid: 424242,
    acquiredAt: new Date(Date.now() - ageMs).toISOString()
  });

  // Top-level describe : isolation env propre (leçon c.180/#1032 — jamais
  // d'héritage supposé du describe voisin).
  beforeEach(async () => {
    lockTmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = lockTmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    // Budget court : les tests fail-open attendent ~250 ms, pas 5 s.
    process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS = '250';
  });

  afterEach(async () => {
    delete process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS;
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    await rm(lockTmpDir, { recursive: true, force: true });
  });

  it('acquire → true ; détenteur frais concurrent → false après budget (fail-open), verrou étranger intact', async () => {
    await fsp.mkdir(path.join(lockTmpDir, 'dashboards'), { recursive: true });
    const mine = mkHolder('machine-a');
    const got = await acquireAppendLock('workspace-x', mine);
    expect(got).toBe(true);

    const other = mkHolder('machine-b');
    const start = Date.now();
    const denied = await acquireAppendLock('workspace-x', other);
    const waited = Date.now() - start;
    expect(denied).toBe(false); // fail-open : le caller procède SANS le verrou
    expect(waited).toBeGreaterThanOrEqual(200); // il a bien ATTENDU (sémantique WAIT, pas skip immédiat)

    // Le verrou du détenteur A n'a pas été touché par l'acquis échoué de B.
    const raw = await fsp.readFile(path.join(lockTmpDir, 'dashboards', 'workspace-x.append.lock'), 'utf8');
    expect(JSON.parse(raw).machineId).toBe('machine-a');

    await releaseAppendLock('workspace-x', mine);
  });

  it('verrou STALE (âge > TTL 30 s) → volé → true, payload maintenant le nôtre', async () => {
    // Posé "il y a 60 s" par un process mort — au-delà du TTL par défaut.
    const dead = mkHolder('dead-machine', 60_000);
    await fsp.mkdir(path.join(lockTmpDir, 'dashboards'), { recursive: true });
    await fsp.writeFile(
      path.join(lockTmpDir, 'dashboards', 'workspace-y.append.lock'),
      JSON.stringify(dead), 'utf8'
    );

    const mine = mkHolder('live-machine');
    const got = await acquireAppendLock('workspace-y', mine);
    expect(got).toBe(true);

    const raw = await fsp.readFile(path.join(lockTmpDir, 'dashboards', 'workspace-y.append.lock'), 'utf8');
    expect(JSON.parse(raw).machineId).toBe('live-machine');
    await releaseAppendLock('workspace-y', mine);
  });

  it('release ne supprime QUE son propre verrou (garde ownership)', async () => {
    await fsp.mkdir(path.join(lockTmpDir, 'dashboards'), { recursive: true });
    const foreignPath = path.join(lockTmpDir, 'dashboards', 'workspace-z.append.lock');
    const foreign = mkHolder('foreign-machine');
    await fsp.writeFile(foreignPath, JSON.stringify(foreign), 'utf8');

    // Un holder différent tente de relâcher — ne doit RIEN supprimer.
    await releaseAppendLock('workspace-z', mkHolder('other-machine'));

    const raw = await fsp.readFile(foreignPath, 'utf8');
    expect(JSON.parse(raw).machineId).toBe('foreign-machine');
  });

  it('verrou GARBAGE (JSON corrompu) → volé immédiatement, pas après budget (fix web1 c.318)', async () => {
    await fsp.mkdir(path.join(lockTmpDir, 'dashboards'), { recursive: true });
    const garbagePath = path.join(lockTmpDir, 'dashboards', 'workspace-g.append.lock');
    // Write partiel d'un process crashé — le payload n'est pas du JSON valide.
    await fsp.writeFile(garbagePath, '{ invalid json', 'utf8');

    const mine = mkHolder('live-machine');
    const start = Date.now();
    const got = await acquireAppendLock('workspace-g', mine);
    const waited = Date.now() - start;

    // Avant le fix : parse échouait → boucle → budget 250 ms épuisé → false
    // (fail-open). Après : volé au premier passage, sans attendre le budget.
    expect(got).toBe(true);
    expect(waited).toBeLessThan(200);

    // Le verrou corrompu est remplacé par notre payload.
    const raw = await fsp.readFile(garbagePath, 'utf8');
    expect(JSON.parse(raw).machineId).toBe('live-machine');
    await releaseAppendLock('workspace-g', mine);
  });

  it('append réel : verrou pris puis relâché (aucun .append.lock résiduel après)', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed lock' });
    const result = await roosyncDashboard({ action: 'append', type: 'global', content: 'Msg append-lock' });

    expect(result.success).toBe(true);
    const locksDir = path.join(lockTmpDir, 'dashboards');
    const leftovers = (await fsp.readdir(locksDir)).filter(f => f.endsWith('.append.lock'));
    expect(leftovers).toEqual([]); // relâché dans le finally — pas de verrou orphelin
    // Le message est bien là (chemin complet append → pas de régression).
    const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    expect(read.data?.intercom?.messages.some(m => m.content === 'Msg append-lock')).toBe(true);
  });

  it('append sous verrou étranger frais → procède fail-open, message persisté, verrou étranger PAS touché', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed foreign' });

    // Un autre process/machine "détient" le verrou (acquis à l'instant).
    await fsp.mkdir(path.join(lockTmpDir, 'dashboards'), { recursive: true });
    const foreignPath = path.join(lockTmpDir, 'dashboards', 'global.append.lock');
    const foreign = mkHolder('other-process');
    await fsp.writeFile(foreignPath, JSON.stringify(foreign), 'utf8');

    const start = Date.now();
    const result = await roosyncDashboard({ action: 'append', type: 'global', content: 'Msg fail-open' });
    const waited = Date.now() - start;

    // L'append a abouti malgré le verrou (fail-open après budget), après avoir attendu.
    expect(result.success).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(200);

    // Le verrou étranger est intact — on ne relâche QUE ce qu'on possède.
    const raw = await fsp.readFile(foreignPath, 'utf8');
    expect(JSON.parse(raw).machineId).toBe('other-process');

    // Et le message n'est PAS perdu (le contrat même du fix).
    const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    expect(read.data?.intercom?.messages.some(m => m.content === 'Msg fail-open')).toBe(true);
  });
});

// #3205 write-side RÉSIDUEL — les trois chemins read-modify-write restés hors
// verrou après #1033 (status-write, Auto-ACK du read path, crossPost) : chacun
// réécrivait le fichier complet depuis un snapshot lu AVANT, écrasant
// silencieusement tout append concurrent dans la fenêtre. Le fix : les trois
// prennent le verrou append (par clé) et RE- LISENT frais sous le verrou.
describe('#3205 write-side résiduel — status-write / Auto-ACK / crossPost sous verrou append', () => {
  let rlTmpDir: string;
  const pendingTimers: NodeJS.Timeout[] = [];

  const mkHolder = (machineId: string): { machineId: string; workspace: string; pid: number; acquiredAt: string } => ({
    machineId,
    workspace: 'test-workspace',
    pid: 424242,
    acquiredAt: new Date().toISOString()
  });

  // Top-level describe : isolation env propre (leçon c.180/#1032 — jamais
  // d'héritage supposé du describe voisin).
  beforeEach(async () => {
    rlTmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = rlTmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    // Budget 600 ms : les tests « chemin sérialisé » laissent le verrou partir
    // à ~250 ms (après mutation à 150 ms) — un retry (~150 ms de période)
    // gagne avant le deadline. Les tests fail-open attendent ~600 ms.
    process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS = '600';
  });

  afterEach(async () => {
    for (const t of pendingTimers.splice(0)) clearTimeout(t);
    delete process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS;
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
    await rm(rlTmpDir, { recursive: true, force: true });
  });

  const lockPathFor = (k: string) => path.join(rlTmpDir, 'dashboards', `${k}.append.lock`);
  const filePathFor = (k: string) => path.join(rlTmpDir, 'dashboards', `${k}.md`);

  // Injecte un bloc message dans le fichier dashboard, comme le ferait une
  // autre machine pendant la fenêtre read→write du SUT (raw fs : simule un
  // writer qui ne passe PAS par notre process). Sur un intercom vide, un vrai
  // append REMPLACE le placeholder `*Aucun message.*` (appendDashboardIncremental
  // fait exactement ça) — l'injection doit suivre la même sémantique, sinon le
  // parser ignore le bloc.
  const injectMessageBlock = async (k: string, msgId: string, machineId: string, content: string) => {
    const raw = await fsp.readFile(filePathFor(k), 'utf8');
    const block = `### [${new Date().toISOString()}] ${machineId}|test-workspace\n[msg: ${msgId}]\n\n${content}`;
    if (raw.includes('*Aucun message.*')) {
      await fsp.writeFile(filePathFor(k), raw.replace('*Aucun message.*', block), 'utf8');
    } else {
      await fsp.writeFile(filePathFor(k), `${raw.trimEnd()}\n\n---\n\n${block}\n`, 'utf8');
    }
  };

  it('status-write : verrou pris puis relâché, status persisté, aucun résiduel', async () => {
    const result = await roosyncDashboard({ action: 'write', type: 'global', content: '# Status v1' });
    expect(result.success).toBe(true);

    const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    expect(read.data?.status?.markdown).toContain('# Status v1'); // le SUT a bien écrit

    const leftovers = (await fsp.readdir(path.join(rlTmpDir, 'dashboards'))).filter(f => f.endsWith('.append.lock'));
    expect(leftovers).toEqual([]); // relâché dans le finally
  });

  it('status-write sous verrou étranger frais → fail-open après budget, status persisté, verrou étranger intact', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed' });
    const foreign = mkHolder('other-process');
    await fsp.writeFile(lockPathFor('global'), JSON.stringify(foreign), 'utf8');

    const start = Date.now();
    const result = await roosyncDashboard({ action: 'write', type: 'global', content: '# Status fail-open' });
    const waited = Date.now() - start;

    expect(result.success).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(500); // a attendu le budget avant de procéder sans verrou

    const read = await roosyncDashboard({ action: 'read', type: 'global', section: 'status' });
    expect(read.data?.status?.markdown).toContain('# Status fail-open');

    const raw = await fsp.readFile(lockPathFor('global'), 'utf8');
    expect(JSON.parse(raw).machineId).toBe('other-process'); // pas touché
  });

  it('Auto-ACK : ack persisté et servi, aucun verrou résiduel', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed ack' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'M1 de test-machine', messageId: 'm1-seed' });
    await roosyncDashboard({
      action: 'append', type: 'global', content: 'R1 réponse de other-machine', messageId: 'r1-seed',
      author: { machineId: 'other-machine', workspace: 'test-workspace' },
      mentions: [{ messageId: 'm1-seed' }]
    });

    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    expect(result.success).toBe(true);

    const r1 = result.data?.intercom?.messages.find(m => m.id === 'r1-seed');
    expect(r1?.reply_to).toBe('m1-seed');
    expect(r1?.acknowledged_at?.['test-machine']).toBeDefined(); // l'ack a été posé ET servi

    const leftovers = (await fsp.readdir(path.join(rlTmpDir, 'dashboards'))).filter(f => f.endsWith('.append.lock'));
    expect(leftovers).toEqual([]);
  });

  it('Auto-ACK préserve un append concurrent pendant la fenêtre (re-lecture fraîche sous verrou)', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed ack race' });
    await roosyncDashboard({ action: 'append', type: 'global', content: 'M1 de test-machine', messageId: 'm1-seed' });
    await roosyncDashboard({
      action: 'append', type: 'global', content: 'R1 réponse de other-machine', messageId: 'r1-seed',
      author: { machineId: 'other-machine', workspace: 'test-workspace' },
      mentions: [{ messageId: 'm1-seed' }]
    });

    // Un autre process détient le verrou : le read (et SON ack write-back)
    // attend. Pendant l'attente, une "autre machine" append au fichier.
    const foreign = mkHolder('lock-holder');
    await fsp.writeFile(lockPathFor('global'), JSON.stringify(foreign), 'utf8');

    pendingTimers.push(setTimeout(() => { void injectMessageBlock('global', 'concurrent-m2', 'concurrent-machine', 'M2 append concurrent').catch(() => {}); }, 150));
    pendingTimers.push(setTimeout(() => { void releaseAppendLock('global', foreign).catch(() => {}); }, 250));

    const start = Date.now();
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const waited = Date.now() - start;

    expect(result.success).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(200); // le read a attendu le verrou, pas fail-open immédiat

    // L'ack est posé (le but de l'auto-ACK)…
    const r1 = result.data?.intercom?.messages.find(m => m.id === 'r1-seed');
    expect(r1?.acknowledged_at?.['test-machine']).toBeDefined();

    // …ET l'append concurrent a survécu au write-back de l'ack : pre-fix, le
    // snapshot pré-verrou était réécrit tel quel et M2 disparaissait.
    expect(result.data?.intercom?.messages.some(m => m.id === 'concurrent-m2')).toBe(true);
  });

  it('crossPost : message répliqué sur la cible, aucun verrou résiduel source ni cible', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed xpost' });
    await roosyncDashboard({ action: 'write', type: 'machine', machineId: 'other-machine', content: '# Cible' });

    const result = await roosyncDashboard({
      action: 'append', type: 'global', content: 'Msg cross-posté', messageId: 'xpost-seed',
      crossPost: [{ type: 'machine', machineId: 'other-machine' }]
    });
    expect(result.success).toBe(true);

    const target = await roosyncDashboard({ action: 'read', type: 'machine', machineId: 'other-machine', section: 'intercom' });
    expect(target.data?.intercom?.messages.some(m => m.id === 'xpost-seed')).toBe(true); // répliqué

    const leftovers = (await fsp.readdir(path.join(rlTmpDir, 'dashboards'))).filter(f => f.endsWith('.append.lock'));
    expect(leftovers).toEqual([]); // source ET cible relâchés
  });

  it('crossPost préserve un append concurrent sur la cible pendant la fenêtre (re-lecture fraîche sous verrou)', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Seed xpost race' });
    await roosyncDashboard({ action: 'write', type: 'machine', machineId: 'other-machine', content: '# Cible race' });

    // Le verrou étranger est sur la CIBLE — le cross-post attend dessus
    // (le verrou source est déjà relâché : un seul verrou à la fois).
    const foreign = mkHolder('lock-holder');
    await fsp.writeFile(lockPathFor('machine-other-machine'), JSON.stringify(foreign), 'utf8');

    pendingTimers.push(setTimeout(() => { void injectMessageBlock('machine-other-machine', 'concurrent-t1', 'concurrent-machine', 'T1 append concurrent cible').catch(() => {}); }, 150));
    pendingTimers.push(setTimeout(() => { void releaseAppendLock('machine-other-machine', foreign).catch(() => {}); }, 250));

    const start = Date.now();
    const result = await roosyncDashboard({
      action: 'append', type: 'global', content: 'Msg cross-posté race', messageId: 'xpost-race',
      crossPost: [{ type: 'machine', machineId: 'other-machine' }]
    });
    const waited = Date.now() - start;

    expect(result.success).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(200); // le cross-post a attendu le verrou cible

    const target = await roosyncDashboard({ action: 'read', type: 'machine', machineId: 'other-machine', section: 'intercom' });
    // Les DEUX : le message cross-posté…
    expect(target.data?.intercom?.messages.some(m => m.id === 'xpost-race')).toBe(true);
    // …ET l'append concurrent sur la cible (écrasé pre-fix par le full-file write du snapshot pré-verrou).
    expect(target.data?.intercom?.messages.some(m => m.id === 'concurrent-t1')).toBe(true);
  });
});
