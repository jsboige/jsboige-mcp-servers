/**
 * Tests pour roosync_export_baseline
 *
 * Vérifie les schemas et métadonnées de l'outil d'export de baseline.
 *
 * @module roosync/export-baseline.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_export_baseline - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosync_export_baseline', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');

    expect(module.roosync_export_baseline).toBeDefined();
    expect(typeof module.roosync_export_baseline).toBe('function');
  });

  it('devrait exporter ExportBaselineArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');

    expect(module.ExportBaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter ExportBaselineResultSchema', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');

    expect(module.ExportBaselineResultSchema).toBeDefined();
  });
});

describe('roosync_export_baseline - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter format json', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineArgsSchema.safeParse({
      format: 'json'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter format yaml', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineArgsSchema.safeParse({
      format: 'yaml'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter format csv', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineArgsSchema.safeParse({
      format: 'csv'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter un format invalide', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineArgsSchema.safeParse({
      format: 'xml'
    });

    expect(result.success).toBe(false);
  });

  it('devrait accepter tous les paramètres optionnels', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineArgsSchema.safeParse({
      format: 'json',
      outputPath: '/tmp/export.json',
      machineId: 'myia-ai-01',
      includeHistory: true,
      includeMetadata: true,
      prettyPrint: false
    });

    expect(result.success).toBe(true);
  });

  it('devrait avoir des valeurs par défaut', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineArgsSchema.safeParse({
      format: 'json'
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeHistory).toBe(false);
      expect(result.data.includeMetadata).toBe(true);
      expect(result.data.prettyPrint).toBe(true);
    }
  });
});

describe('roosync_export_baseline - Result Schema', () => {
  it('devrait valider une structure de résultat complète', async () => {
    const module = await import('../../../../src/tools/roosync/export-baseline.js');
    const result = module.ExportBaselineResultSchema.safeParse({
      success: true,
      machineId: 'myia-ai-01',
      version: '2.1.0',
      format: 'json',
      outputPath: '/tmp/export.json',
      size: 1024,
      includeHistory: false,
      includeMetadata: true,
      message: 'Export réussi'
    });

    expect(result.success).toBe(true);
  });
});
