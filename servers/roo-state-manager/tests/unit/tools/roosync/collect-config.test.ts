/**
 * Tests pour roosync_collect_config
 *
 * Vérifie les schemas et métadonnées de l'outil de collecte de configuration.
 *
 * Pattern modifié (#609) : Utilise beforeAll pour l'import unique au lieu de
 * vi.resetModules() qui causait des timeouts dans le suite complet.
 *
 * @module roosync/collect-config.test
 * @version 1.1.0 (#609 fix)
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_collect_config - Interface', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/collect-config.js');
  });

  it('devrait exporter roosyncCollectConfig', () => {
    expect(module.roosyncCollectConfig).toBeDefined();
    expect(typeof module.roosyncCollectConfig).toBe('function');
  });

  it('devrait exporter CollectConfigArgsSchema', () => {
    expect(module.CollectConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter collectConfigToolMetadata', () => {
    expect(module.collectConfigToolMetadata).toBeDefined();
    expect(module.collectConfigToolMetadata.name).toBe('roosync_collect_config');
  });
});

describe('roosync_collect_config - Schema Validation', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/collect-config.js');
  });

  it('devrait accepter un objet vide (tous optionnels)', () => {
    const result = module.CollectConfigArgsSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('devrait accepter targets array', () => {
    const result = module.CollectConfigArgsSchema.safeParse({
      targets: ['modes', 'mcp', 'profiles']
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter dryRun', () => {
    const result = module.CollectConfigArgsSchema.safeParse({
      dryRun: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter targets et dryRun combinés', () => {
    const result = module.CollectConfigArgsSchema.safeParse({
      targets: ['modes'],
      dryRun: false
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_collect_config - Metadata', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/collect-config.js');
  });

  it('devrait avoir les métadonnées correctes', () => {
    const metadata = module.collectConfigToolMetadata;

    expect(metadata.name).toBe('roosync_collect_config');
    expect(metadata.description).toContain('Collecte');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('targets');
    expect(metadata.inputSchema.properties).toHaveProperty('dryRun');
  });
});
