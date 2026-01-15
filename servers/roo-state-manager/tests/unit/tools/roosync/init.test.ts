/**
 * Tests pour roosync_init
 *
 * Vérifie le comportement de l'outil d'initialisation RooSync.
 *
 * @module roosync/init.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_init - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncInit', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');

    expect(module.roosyncInit).toBeDefined();
    expect(typeof module.roosyncInit).toBe('function');
  });

  it('devrait exporter InitArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');

    expect(module.InitArgsSchema).toBeDefined();
  });

  it('devrait exporter initToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');

    expect(module.initToolMetadata).toBeDefined();
    expect(module.initToolMetadata.name).toBe('roosync_init');
    expect(module.initToolMetadata.description).toContain('RooSync');
  });
});

describe('roosync_init - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter un objet vide', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');
    const result = module.InitArgsSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('devrait accepter force: true', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');
    const result = module.InitArgsSchema.safeParse({ force: true });

    expect(result.success).toBe(true);
  });

  it('devrait accepter createRoadmap: false', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');
    const result = module.InitArgsSchema.safeParse({ createRoadmap: false });

    expect(result.success).toBe(true);
  });

  it('devrait accepter les deux paramètres', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');
    const result = module.InitArgsSchema.safeParse({
      force: true,
      createRoadmap: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter les types invalides', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');
    const result = module.InitArgsSchema.safeParse({ force: 'yes' });

    expect(result.success).toBe(false);
  });
});

describe('roosync_init - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/init.js');
    const metadata = module.initToolMetadata;

    expect(metadata.name).toBe('roosync_init');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('force');
    expect(metadata.inputSchema.properties).toHaveProperty('createRoadmap');
  });
});
