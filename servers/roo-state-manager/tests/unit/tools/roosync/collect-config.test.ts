/**
 * Tests pour roosync_collect_config
 *
 * Vérifie les schemas et métadonnées de l'outil de collecte de configuration.
 *
 * @module roosync/collect-config.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_collect_config - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncCollectConfig', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');

    expect(module.roosyncCollectConfig).toBeDefined();
    expect(typeof module.roosyncCollectConfig).toBe('function');
  });

  it('devrait exporter CollectConfigArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');

    expect(module.CollectConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter collectConfigToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');

    expect(module.collectConfigToolMetadata).toBeDefined();
    expect(module.collectConfigToolMetadata.name).toBe('roosync_collect_config');
  });
});

describe('roosync_collect_config - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter un objet vide (tous optionnels)', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');
    const result = module.CollectConfigArgsSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('devrait accepter targets array', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');
    const result = module.CollectConfigArgsSchema.safeParse({
      targets: ['modes', 'mcp', 'profiles']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter dryRun', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');
    const result = module.CollectConfigArgsSchema.safeParse({
      dryRun: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter targets et dryRun combinés', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');
    const result = module.CollectConfigArgsSchema.safeParse({
      targets: ['modes'],
      dryRun: false
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_collect_config - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/collect-config.js');
    const metadata = module.collectConfigToolMetadata;

    expect(metadata.name).toBe('roosync_collect_config');
    expect(metadata.description).toContain('Collecte');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('targets');
    expect(metadata.inputSchema.properties).toHaveProperty('dryRun');
  });
});
