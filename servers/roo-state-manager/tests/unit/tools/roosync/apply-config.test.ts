/**
 * Tests pour roosync_apply_config
 *
 * Vérifie les schemas et métadonnées de l'outil d'application de configuration.
 *
 * @module roosync/apply-config.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_apply_config - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncApplyConfig', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');

    expect(module.roosyncApplyConfig).toBeDefined();
    expect(typeof module.roosyncApplyConfig).toBe('function');
  });

  it('devrait exporter ApplyConfigArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');

    expect(module.ApplyConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter applyConfigToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');

    expect(module.applyConfigToolMetadata).toBeDefined();
    expect(module.applyConfigToolMetadata.name).toBe('roosync_apply_config');
  });
});

describe('roosync_apply_config - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter un objet vide (tous optionnels)', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('devrait accepter version latest', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      version: 'latest'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter une version spécifique', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      version: '2.1.0'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter dryRun et backup', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      dryRun: true,
      backup: false
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter targets array', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      targets: ['modes', 'mcp']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter machineId', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const result = module.ApplyConfigArgsSchema.safeParse({
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_apply_config - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/apply-config.js');
    const metadata = module.applyConfigToolMetadata;

    expect(metadata.name).toBe('roosync_apply_config');
    expect(metadata.description).toContain('configuration');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('version');
    expect(metadata.inputSchema.properties).toHaveProperty('dryRun');
    expect(metadata.inputSchema.properties).toHaveProperty('backup');
  });
});
