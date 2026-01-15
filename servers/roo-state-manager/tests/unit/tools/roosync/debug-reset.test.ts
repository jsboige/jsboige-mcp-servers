/**
 * Tests pour roosync_debug_reset
 *
 * Vérifie les schemas et métadonnées de l'outil de debug/reset.
 *
 * @module roosync/debug-reset.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_debug_reset - Interface', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait exporter roosync_debug_reset', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');

    expect(module.roosync_debug_reset).toBeDefined();
    expect(typeof module.roosync_debug_reset).toBe('function');
  });

  it('devrait exporter DebugResetArgsSchema', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');

    expect(module.DebugResetArgsSchema).toBeDefined();
  });

  it('devrait exporter debugResetToolMetadata', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');

    expect(module.debugResetToolMetadata).toBeDefined();
    expect(module.debugResetToolMetadata.name).toBe('roosync_debug_reset');
  });
});

describe('roosync_debug_reset - Schema Validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('devrait accepter action debug', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({
      action: 'debug'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action reset', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({
      action: 'reset'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter les options de debug', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({
      action: 'debug',
      verbose: true,
      clearCache: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter les options de reset', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({
      action: 'reset',
      confirm: true,
      clearCache: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter une action invalide', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({
      action: 'invalid'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter si action est manquante', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('devrait avoir des valeurs par défaut', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const result = module.DebugResetArgsSchema.safeParse({
      action: 'debug'
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clearCache).toBe(false);
      expect(result.data.verbose).toBe(false);
      expect(result.data.confirm).toBe(false);
    }
  });
});

describe('roosync_debug_reset - Metadata', () => {
  it('devrait avoir les métadonnées correctes', async () => {
    const module = await import('../../../../src/tools/roosync/debug-reset.js');
    const metadata = module.debugResetToolMetadata;

    expect(metadata.name).toBe('roosync_debug_reset');
    expect(metadata.description).toContain('déboguer');
    expect(metadata.description).toContain('réinitialiser');
    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toHaveProperty('action');
    expect(metadata.inputSchema.properties).toHaveProperty('clearCache');
    expect(metadata.inputSchema.properties).toHaveProperty('verbose');
    expect(metadata.inputSchema.properties).toHaveProperty('confirm');
    expect(metadata.inputSchema.required).toContain('action');
  });
});
