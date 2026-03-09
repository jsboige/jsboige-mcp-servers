/**
 * Tests pour roosync_init
 *
 * Vérifie le comportement de l'outil d'initialisation RooSync.
 *
 * Pattern modifié (#609) : Utilise beforeAll pour l'import unique au lieu de
 * vi.resetModules() qui causait des timeouts dans le suite complet.
 *
 * @module roosync/init.test
 * @version 1.1.0 (#609 fix)
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_init - Interface', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/roosync_init.js');
  });

  it('devrait exporter roosyncInit', () => {
    expect(module.roosyncInit).toBeDefined();
    expect(typeof module.roosyncInit).toBe('function');
  });

  it('devrait exporter InitArgsSchema', () => {
    expect(module.InitArgsSchema).toBeDefined();
  });

  it('devrait exporter initToolMetadata', () => {
    expect(module.initToolMetadata).toBeDefined();
    expect(module.initToolMetadata.name).toBe('roosync_init');
    expect(module.initToolMetadata.description).toContain('RooSync');
  });
});

describe('roosync_init - Schema Validation', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/roosync_init.js');
  });

  it('devrait accepter un objet vide', () => {
    const result = module.InitArgsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('devrait accepter force: true', () => {
    const result = module.InitArgsSchema.safeParse({ force: true });
    expect(result.success).toBe(true);
  });

  it('devrait accepter createRoadmap: false', () => {
    const result = module.InitArgsSchema.safeParse({ createRoadmap: false });
    expect(result.success).toBe(true);
  });

  it('devrait accepter les deux paramètres', () => {
    const result = module.InitArgsSchema.safeParse({
      force: true,
      createRoadmap: true
    });
    expect(result.success).toBe(true);
  });

  it('devrait rejeter les types invalides', () => {
    const result = module.InitArgsSchema.safeParse({ force: 'yes' });
    expect(result.success).toBe(false);
  });
});

describe('roosync_init - Metadata', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/roosync_init.js');
  });

  it('devrait avoir les métadonnées correctes', () => {
    const metadata = module.initToolMetadata;

    expect(metadata.name).toBe('roosync_init');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('force');
    expect(metadata.inputSchema.properties).toHaveProperty('createRoadmap');
  });
});
