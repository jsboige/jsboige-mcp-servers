/**
 * Tests pour roosync_manage_baseline
 *
 * Vérifie les schemas et métadonnées de l'outil de gestion de baseline.
 *
 * @module roosync/manage-baseline.test
 * @version 1.1.0 (#609 - timeout fix)
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_manage_baseline - Interface', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/manage-baseline.js');
  }, 30000); // 30s timeout for module import (Issue #609)

  it('devrait exporter roosync_manage_baseline', () => {
    expect(module.roosync_manage_baseline).toBeDefined();
    expect(typeof module.roosync_manage_baseline).toBe('function');
  });

  it('devrait exporter ManageBaselineArgsSchema', () => {
    expect(module.ManageBaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter manageBaselineToolMetadata', () => {
    expect(module.manageBaselineToolMetadata).toBeDefined();
    expect(module.manageBaselineToolMetadata.name).toBe('roosync_manage_baseline');
  });
});

describe('roosync_manage_baseline - Schema Validation', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/manage-baseline.js');
  }, 30000); // 30s timeout for module import (Issue #609)

  it('devrait accepter action version', () => {
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'version'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action restore', () => {
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'restore'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter une action invalide', () => {
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'invalid'
    });

    expect(result.success).toBe(false);
  });

  it('devrait accepter les paramètres de version', () => {
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'version',
      version: '1.0.0',
      message: 'Initial baseline',
      pushTags: true,
      createChangelog: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter les paramètres de restore', () => {
    const result = module.ManageBaselineArgsSchema.safeParse({
      action: 'restore',
      source: 'baseline-v1.0.0',
      createBackup: true,
      updateReason: 'Rollback nécessaire'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter si action est manquante', () => {
    const result = module.ManageBaselineArgsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('roosync_manage_baseline - Metadata', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/manage-baseline.js');
  }, 30000); // 30s timeout for module import (Issue #609)

  it('devrait avoir les métadonnées correctes', () => {
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
