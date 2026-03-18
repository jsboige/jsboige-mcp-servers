/**
 * Tests unitaires pour roosync_dashboard (#675)
 *
 * @module tests/roosync/dashboard
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-test-');

describe('roosync_dashboard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
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

  // === Test 4: Clé dashboard workspace+machine ===
  it('creates workspace+machine dashboard (INTERCOM replacement)', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace+machine',
      content: '# Local INTERCOM'
    });

    expect(result.success).toBe(true);
    expect(result.key).toBe('workspace-test-workspace,machine-test-machine');
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

  // === Test 10: Append avec tags ===
  it('stores tags on intercom message', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });
    await roosyncDashboard({
      action: 'append',
      type: 'global',
      content: 'Warning message',
      tags: ['WARN', 'SYSTEM']
    });
    const result = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    const msg = result.data?.intercom?.messages?.[0];

    expect(msg?.tags).toEqual(['WARN', 'SYSTEM']);
  });

  // === Test 11: Condensation manuelle ===
  it('condense keeps N most recent messages and archives the rest', async () => {
    await roosyncDashboard({ action: 'write', type: 'global', content: '# Init' });

    for (let i = 0; i < 10; i++) {
      await roosyncDashboard({ action: 'append', type: 'global', content: `Message ${i}` });
    }

    const condenseResult = await roosyncDashboard({
      action: 'condense',
      type: 'global',
      keepMessages: 3
    });

    expect(condenseResult.success).toBe(true);
    expect(condenseResult.condensed).toBe(true);
    expect(condenseResult.archivedCount).toBe(7);

    // Après condensation: 1 msg système + 3 gardés = 4 total
    const readResult = await roosyncDashboard({ action: 'read', type: 'global', section: 'intercom' });
    expect(readResult.data?.intercom?.messages?.length).toBe(4);
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

  // === Test 15: Auto-détection machine/workspace ===
  it('uses env vars for auto-detection', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace+machine',
      content: '# Auto'
    });

    expect(result.key).toBe('workspace-test-workspace,machine-test-machine');
  });

  // === Test 16: Override explicite machine et workspace ===
  it('accepts explicit machineId and workspace overrides', async () => {
    const result = await roosyncDashboard({
      action: 'write',
      type: 'workspace+machine',
      machineId: 'myia-ai-01',
      workspace: 'roo-extensions',
      content: '# Explicit'
    });

    expect(result.key).toBe('workspace-roo-extensions,machine-myia-ai-01');
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
    expect(archiveName).toMatch(/\.json$/);
  });

  // === Test 25: read_archive avec archiveFile lit l'archive ===
  it('read_archive reads a specific archive file', async () => {
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
      archiveFile: 'global-nonexistent-archive.json'
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('introuvable');
  });
});
