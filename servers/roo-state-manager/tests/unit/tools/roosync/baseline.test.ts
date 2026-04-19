/**
 * Tests pour roosync_baseline (CONS-4)
 *
 * Vérifie les schemas et métadonnées de l'outil consolidé de baseline.
 * Remplace les 3 outils : update-baseline, manage-baseline, export-baseline
 *
 * @module roosync/baseline.test
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_baseline - Interface', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait exporter roosync_baseline', () => {
    expect(module.roosync_baseline).toBeDefined();
    expect(typeof module.roosync_baseline).toBe('function');
  });

  it('devrait exporter BaselineArgsSchema', () => {
    expect(module.BaselineArgsSchema).toBeDefined();
  });

  it('devrait exporter BaselineResultSchema', () => {
    expect(module.BaselineResultSchema).toBeDefined();
  });

  it('devrait exporter baselineToolMetadata', () => {
    expect(module.baselineToolMetadata).toBeDefined();
    expect(module.baselineToolMetadata.name).toBe('roosync_baseline');
  });
});

describe('roosync_baseline - Schema Validation - Action: update', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait accepter action update avec machineId seul', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'update',
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action update avec mode standard', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'update',
      machineId: 'myia-ai-01',
      mode: 'standard'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action update avec mode profile', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'update',
      machineId: 'dev-profile',
      mode: 'profile'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter tous les paramètres optionnels pour update', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'update',
      machineId: 'myia-ai-01',
      mode: 'standard',
      version: '2026.01.29-1400',
      createBackup: true,
      updateReason: 'Test de mise à jour',
      updatedBy: 'test-machine'
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_baseline - Schema Validation - Action: version', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait accepter action version avec version seule', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'version',
      version: '2.3.0'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action version avec tous les paramètres', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'version',
      version: '2.3.0',
      message: 'Version de test',
      pushTags: true,
      createChangelog: true
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_baseline - Schema Validation - Action: restore', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait accepter action restore avec source seule', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'restore',
      source: 'baseline-v2.3.0'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action restore avec tous les paramètres', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'restore',
      source: 'baseline-v2.3.0',
      targetVersion: '2.3.0',
      createBackup: true,
      updateReason: 'Rollback to stable version',
      restoredBy: 'test-machine'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action restore depuis un backup file', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'restore',
      source: '/path/to/sync-config.ref.backup.2026-01-29.json'
    });

    expect(result.success).toBe(true);
  });
});

describe('roosync_baseline - Schema Validation - Action: export', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait accepter action export avec format json', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'export',
      format: 'json'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action export avec format yaml', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'export',
      format: 'yaml'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter action export avec format csv', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'export',
      format: 'csv'
    });

    expect(result.success).toBe(true);
  });

  it('devrait accepter tous les paramètres optionnels pour export', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'export',
      format: 'json',
      outputPath: '/path/to/export.json',
      machineId: 'myia-ai-01',
      includeHistory: true,
      includeMetadata: true,
      prettyPrint: true
    });

    expect(result.success).toBe(true);
  });

  it('devrait rejeter un format invalide', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'export',
      format: 'xml'
    });

    expect(result.success).toBe(false);
  });
});

describe('roosync_baseline - Schema Validation - Errors', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait rejeter si action est manquante', () => {
    const result = module.BaselineArgsSchema.safeParse({
      machineId: 'myia-ai-01'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter une action invalide', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'invalid-action'
    });

    expect(result.success).toBe(false);
  });

  it('devrait rejeter un mode invalide pour action update', () => {
    const result = module.BaselineArgsSchema.safeParse({
      action: 'update',
      machineId: 'myia-ai-01',
      mode: 'invalid-mode'
    });

    expect(result.success).toBe(false);
  });
});

describe('roosync_baseline - Metadata', () => {
  let module: any;

  beforeAll(async () => {
    module = await import('../../../../src/tools/roosync/baseline.js');
  }, 60000); // 60s timeout for module import (Issue #609 - cold cache)

  it('devrait avoir le nom correct', () => {
    const metadata = module.baselineToolMetadata;

    expect(metadata.name).toBe('roosync_baseline');
  });

  it('devrait avoir une description', () => {
    const metadata = module.baselineToolMetadata;

    expect(metadata.description).toBeDefined();
    expect(typeof metadata.description).toBe('string');
    expect(metadata.description.length).toBeGreaterThan(0);
  });

  it('devrait avoir un inputSchema valide', () => {
    const metadata = module.baselineToolMetadata;

    expect(metadata.inputSchema).toBeDefined();
    expect(metadata.inputSchema.type).toBe('object');
    expect(metadata.inputSchema.properties).toBeDefined();
    expect(metadata.inputSchema.properties.action).toBeDefined();
    expect(metadata.inputSchema.properties.action.enum).toEqual(['update', 'version', 'restore', 'export', 'list_versions']);
    expect(metadata.inputSchema.required).toEqual(['action']);
  });

  it('devrait documenter tous les paramètres des 4 actions', () => {
    const metadata = module.baselineToolMetadata;
    const props = metadata.inputSchema.properties;

    // Paramètres update
    expect(props.machineId).toBeDefined();
    expect(props.mode).toBeDefined();
    expect(props.aggregationConfig).toBeDefined();

    // Paramètres version
    expect(props.version).toBeDefined();
    expect(props.message).toBeDefined();
    expect(props.pushTags).toBeDefined();
    expect(props.createChangelog).toBeDefined();

    // Paramètres restore
    expect(props.source).toBeDefined();
    expect(props.targetVersion).toBeDefined();
    expect(props.restoredBy).toBeDefined();

    // Paramètres export
    expect(props.format).toBeDefined();
    expect(props.outputPath).toBeDefined();
    expect(props.includeHistory).toBeDefined();
    expect(props.includeMetadata).toBeDefined();
    expect(props.prettyPrint).toBeDefined();

    // Paramètres communs
    expect(props.createBackup).toBeDefined();
    expect(props.updateReason).toBeDefined();
  });
});
