/**
 * Tests pour roosync_update_baseline
 *
 * Vérifie les schemas et métadonnées de l'outil de mise à jour de baseline.
 *
 * @module roosync/update-baseline.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_update_baseline - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosyncUpdateBaseline', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');

    expect(module.roosyncUpdateBaseline).toBeDefined();
    expect(typeof module.roosyncUpdateBaseline).toBe('function');
  });

  it('devrait exporter UpdateBaselineArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');

    expect(module.UpdateBaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter updateBaselineToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');

    expect(module.updateBaselineToolMetadata).toBeDefined();
    expect(module.updateBaselineToolMetadata.name).toBe('roosync_update_baseline');
  });
});

describe('roosync_update_baseline - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter machineId seul', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter mode standard', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01',
      mode: 'standard'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter mode profile', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'dev-profile',
      mode: 'profile'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter tous les paramètres optionnels', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
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

  it('devrait rejeter un mode invalide', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
    const result = module.UpdateBaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01',
      mode: 'invalid'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter si machineId est manquant', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
    const result = module.UpdateBaselineArgsSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('roosync_update_baseline - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/update-baseline.js');
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
