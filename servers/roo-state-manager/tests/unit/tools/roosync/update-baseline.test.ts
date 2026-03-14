/**
 * Tests pour roosync_update_baseline
 *
 * Vérifie les schemas et métadonnées de l'outil de mise à jour de baseline.
 *
 * @module roosync/update-baseline.test
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_update_baseline - Interface', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/update-baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait exporter roosyncUpdateBaseline', () => {
    expect(module.roosyncUpdateBaseline).toBeDefined();
    expect(typeof module.roosyncUpdateBaseline).toBe('function');
  });

  it('devrait exporter UpdateBaselineArgsSchema', () => {
    expect(module.UpdateBaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter updateBaselineToolMetadata', () => {
    expect(module.updateBaselineToolMetadata).toBeDefined();
    expect(module.updateBaselineToolMetadata.name).toBe('roosync_update_baseline');
  });
});

describe('roosync_update_baseline - Schema Validation', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/update-baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait accepter machineId seul', () => {
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter mode standard', () => {
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01',
      mode: 'standard'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter mode profile', () => {
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'dev-profile',
      mode: 'profile'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter tous les paramètres optionnels', () => {
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01',
      mode: 'standard',
      version: '2026.01.15-1200',
      createBackup: true,
      updateReason: 'Test de mise à jour',
      updatedBy: 'test-machine'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter un mode invalide', () => {
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01',
      mode: 'invalid'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter si machineId est manquant', () => {
    const result = module.UpdateBaselineArgsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('roosync_update_baseline - Metadata', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/update-baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait avoir les métadonnées correctes', () => {
    const metadata = module.updateBaselineToolMetadata;

    expect(metadata.name).toBe('roosync_update_baseline');
    expect(metadata.description).toContain('baseline');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('machineId');
    expect(metadata.inputSchema.properties).toHaveProperty('mode');
    expect(metadata.inputSchema.required).toContain('machineId');
  });
});
