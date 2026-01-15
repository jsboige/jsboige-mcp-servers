/**
 * Tests pour roosync_publish_config
 *
 * Vérifie les schemas et métadonnées de l'outil de publication de configuration.
 *
 * @module roosync/publish-config.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_publish_config - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncPublishConfig', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');

    expect(module.roosyncPublishConfig).toBeDefined();
    expect(typeof module.roosyncPublishConfig).toBe('function');
  });

  it('devrait exporter PublishConfigArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');

    expect(module.PublishConfigArgsSchema).toBeDefined();
  });

  it('devrait exporter publishConfigToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');

    expect(module.publishConfigToolMetadata).toBeDefined();
    expect(module.publishConfigToolMetadata.name).toBe('roosync_publish_config');
  });
});

describe('roosync_publish_config - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter tous les paramètres requis', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');
    const result = module.PublishConfigArgsSchema.safeParse({
      packagePath: '/tmp/config-package',
      version: '2.2.0',
      description: 'Mise à jour des modes'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter machineId optionnel', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');
    const result = module.PublishConfigArgsSchema.safeParse({
      packagePath: '/tmp/config-package',
      version: '2.2.0',
      description: 'Mise à jour des modes',
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter si packagePath est manquant', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');
    const result = module.PublishConfigArgsSchema.safeParse({
      version: '2.2.0',
      description: 'Test'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter si version est manquante', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');
    const result = module.PublishConfigArgsSchema.safeParse({
      packagePath: '/tmp/config-package',
      description: 'Test'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter si description est manquante', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');
    const result = module.PublishConfigArgsSchema.safeParse({
      packagePath: '/tmp/config-package',
      version: '2.2.0'
    });

    expect(result.success).toBe(false);
  });
});

describe('roosync_publish_config - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/publish-config.js');
    const metadata = module.publishConfigToolMetadata;

    expect(metadata.name).toBe('roosync_publish_config');
    expect(metadata.description).toContain('Publie');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('packagePath');
    expect(metadata.inputSchema.properties).toHaveProperty('version');
    expect(metadata.inputSchema.properties).toHaveProperty('description');
    expect(metadata.inputSchema.required).toContain('packagePath');
    expect(metadata.inputSchema.required).toContain('version');
    expect(metadata.inputSchema.required).toContain('description');
  });
});
