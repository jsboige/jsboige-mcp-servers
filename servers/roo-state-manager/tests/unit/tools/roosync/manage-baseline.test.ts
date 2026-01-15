/**
 * Tests pour roosync_manage_baseline
 *
 * Vérifie les schemas et métadonnées de l'outil de gestion de baseline.
 *
 * @module roosync/manage-baseline.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_manage_baseline - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosync_manage_baseline', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');

    expect(module.roosync_manage_baseline).toBeDefined();
    expect(typeof module.roosync_manage_baseline).toBe('function');
  });

  it('devrait exporter ManageBaselineArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');

    expect(module.ManageBaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter manageBaselineToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');

    expect(module.manageBaselineToolMetadata).toBeDefined();
    expect(module.manageBaselineToolMetadata.name).toBe('roosync_manage_baseline');
  });
});

describe('roosync_manage_baseline - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter action version', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'version'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action restore', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'restore'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter une action invalide', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'invalid'
    });

    expect(result.success).toBe(false);
  });

  it('devrait accepter les paramètres de version', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'version',
      version: '1.0.0',
      message: 'Initial baseline',
      pushTags: true,
      createChangelog: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter les paramètres de restore', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'restore',
      source: 'baseline-v1.0.0',
      createBackup: true,
      updateReason: 'Rollback nécessaire'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter si action est manquante', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const result = module.ManageBaselineArgsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('roosync_manage_baseline - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/manage-baseline.js');
    const metadata = module.manageBaselineToolMetadata;

    expect(metadata.name).toBe('roosync_manage_baseline');
    expect(metadata.description).toContain('versionner');
    expect(metadata.description).toContain('restaurer');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('action');
    expect(metadata.inputSchema.properties).toHaveProperty('version');
    expect(metadata.inputSchema.properties).toHaveProperty('source');
    expect(metadata.inputSchema.required).toContain('action');
  });
});
