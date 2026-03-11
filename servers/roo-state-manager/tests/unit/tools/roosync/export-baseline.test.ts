/**
 * Tests pour roosync_export_baseline
 *
 * Vérifie les schemas et métadonnées de l'outil d'export de baseline.
 *
 * @module roosync/export-baseline.test
 */

import { describe, it, expect } from 'vitest';

// Import direct - les schemas Zod ne nécessitent pas de mocks spéciaux
import {
  roosync_export_baseline,
  ExportBaselineArgsSchema,
  ExportBaselineResultSchema
} from '../../../../src/tools/roosync/export-baseline.js';

describe('roosync_export_baseline - Interface', () => {
  it('devrait exporter roosync_export_baseline', () => {
    expect(roosync_export_baseline).toBeDefined();
    expect(typeof roosync_export_baseline).toBe('function');
  });

  it('devrait exporter ExportBaselineArgsSchema', () => {
    expect(ExportBaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter ExportBaselineResultSchema', () => {
    expect(ExportBaselineResultSchema).toBeDefined();
  });
});

describe('roosync_export_baseline - Schema Validation', () => {
  it('devrait accepter format json', () => {
    const result = ExportBaselineArgsSchema.safeParse({
      format: 'json'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter format yaml', () => {
    const result = ExportBaselineArgsSchema.safeParse({
      format: 'yaml'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter format csv', () => {
    const result = ExportBaselineArgsSchema.safeParse({
      format: 'csv'
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter un format invalide', () => {
    const result = ExportBaselineArgsSchema.safeParse({
      format: 'xml'
    });

    expect(result.success).toBe(false);
  });

  it('devrait accepter tous les paramètres optionnels', () => {
    const result = ExportBaselineArgsSchema.safeParse({
      format: 'json',
      outputPath: '/tmp/export.json',
      machineId: 'myia-ai-01',
      includeHistory: true,
      includeMetadata: true,
      prettyPrint: false
    });

    expect(result.success).toBe(true);
  });

  it('devrait avoir des valeurs par défaut', () => {
    const result = ExportBaselineArgsSchema.safeParse({
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
  it('devrait valider une structure de résultat complète', () => {
    const result = ExportBaselineResultSchema.safeParse({
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
