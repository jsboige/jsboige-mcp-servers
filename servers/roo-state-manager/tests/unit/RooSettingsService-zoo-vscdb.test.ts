/**
 * Unit tests for RooSettingsService — #2543 Phase 1(a/b) vscdb target routing.
 *
 * Context: the tool-schema bug fixed in PR #626 meant `apply_profile` silently
 * ignored `targetExtension: "zoo"` and always wrote to the Roo vscdb. The fix
 * relies on RooSettingsService resolving the vscdb ItemTable key from the
 * `targetExtension` constructor option. These tests pin that routing so a
 * regression is caught immediately.
 *
 * Coverage gaps these close (from #833 Phase 3 audit): RooSettingsService had
 * ZERO tests. We test the Zoo/Roo key resolution + round-trip of
 * listApiConfigMeta (the exact field apply_profile writes for #2543) against a
 * throwaway sqlite state.vscdb in tmpdir — never the real machine vscdb.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sqlite3 from 'sqlite3';
import { RooSettingsService } from '../../src/services/RooSettingsService';
import {
  DEFAULT_VSCDB_KEY,
  ZOO_CODE_VSCDB_KEY,
} from '../../src/utils/extension-paths';

/**
 * Build a throwaway state.vscdb with an ItemTable pre-seeded with a JSON blob
 * under both the Roo and Zoo keys. This mimics the real VS Code global state
 * layout without touching the operator's machine.
 *
 * Returns a promise that resolves ONLY once the schema is created, both seed
 * rows are committed, and the handle is closed — so callers can safely read
 * the file immediately after.
 */
function buildFakeVscdb(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openErr) => {
      if (openErr) return reject(openErr);
    });
    const seed = JSON.stringify({ existing: 'seed' });
    db.serialize(() => {
      db.run('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE, value BLOB)', (e: Error | null) => {
        if (e) return reject(e);
      });
      db.run(
        'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
        [DEFAULT_VSCDB_KEY, seed],
        (e: Error | null) => {
          if (e) return reject(e);
        }
      );
      db.run(
        'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
        [ZOO_CODE_VSCDB_KEY, seed],
        (e: Error | null) => {
          if (e) return reject(e);
        }
      );
      db.run('PRAGMA wal_checkpoint(FULL)', () => {
        db.close((closeErr: Error | null) => {
          if (closeErr) return reject(closeErr);
          resolve();
        });
      });
    });
  });
}

describe('RooSettingsService — #2543 vscdb target routing', () => {
  let tmpDir: string;
  let vscdbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-zoo-test-'));
    vscdbPath = path.join(tmpDir, 'state.vscdb');
    await buildFakeVscdb(vscdbPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  /**
   * Helper: construct a service pointed at the fake vscdb. We override
   * getStateDbPath() (instance method) to return our tmpdir file instead of
   * the real homedir() path.
   */
  function makeService(targetExtension: 'roo' | 'zoo'): RooSettingsService {
    const svc = new RooSettingsService({ targetExtension });
    // Redirect to the fake vscdb — never the operator's real one.
    (svc as any).getStateDbPath = () => vscdbPath;
    return svc;
  }

  it('defaults to the Roo vscdb key when targetExtension is "roo"', async () => {
    const svc = makeService('roo');
    const listApiConfigMeta = [
      { id: 'cfg-1', name: 'default', apiProvider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ];
    const result = await svc.injectSettings(
      { listApiConfigMeta } as any,
      { keys: ['listApiConfigMeta'] }
    );
    expect(result.applied).toBe(1);

    // A separate Roo service should read back the value we just wrote.
    const reader = makeService('roo');
    const readBack = await reader.extractSettings('safe');
    expect(readBack.settings.listApiConfigMeta).toEqual(listApiConfigMeta);
  });

  it('routes writes to the ZOO vscdb key when targetExtension is "zoo" (#2543 Phase 1a)', async () => {
    const zooSvc = makeService('zoo');
    const zooMeta = [
      { id: 'z1', name: 'glm', apiProvider: 'openai', openAiModelId: 'glm-5.1' },
    ];
    const result = await zooSvc.injectSettings(
      { listApiConfigMeta: zooMeta } as any,
      { keys: ['listApiConfigMeta'] }
    );
    expect(result.applied).toBe(1);

    // The Roo service must NOT see the Zoo write (different ItemTable key).
    const rooReader = makeService('roo');
    const rooSettings = await rooReader.extractSettings('safe');
    expect(rooSettings.settings.listApiConfigMeta).toBeUndefined();

    // The Zoo service must read back exactly what we wrote.
    const zooReader = makeService('zoo');
    const zooSettings = await zooReader.extractSettings('safe');
    expect(zooSettings.settings.listApiConfigMeta).toEqual(zooMeta);
  });

  it('preserves apiProvider + modelId in listApiConfigMeta round-trip (Phase 1b acceptance)', async () => {
    // po-2026 (2026-06-11) found Zoo's listApiConfigMeta was missing apiProvider/modelId.
    // apply_profile now populates these; verify RooSettingsService round-trips them intact.
    const meta = [
      {
        id: 'cfg-full',
        name: 'production',
        apiProvider: 'openai',
        modelId: 'gpt-4o',
        openAiModelId: 'gpt-4o-2024',
      },
      {
        id: 'cfg-min',
        name: 'minimal',
        apiProvider: 'anthropic',
      },
    ];

    const svc = makeService('zoo');
    await svc.injectSettings(
      { listApiConfigMeta: meta } as any,
      { keys: ['listApiConfigMeta'] }
    );

    const reader = makeService('zoo');
    const read = await reader.extractSettings('safe');
    const roundTripped = read.settings.listApiConfigMeta as any[];
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[0]).toMatchObject({
      apiProvider: 'openai',
      modelId: 'gpt-4o',
      openAiModelId: 'gpt-4o-2024',
    });
    // Entries with no modelId must stay absent (not coerced to undefined).
    expect(roundTripped[1]).toMatchObject({ apiProvider: 'anthropic' });
    expect(roundTripped[1]).not.toHaveProperty('modelId');
  });

  it('writes are isolated per extension key — Roo write does not leak into Zoo', async () => {
    const rooSvc = makeService('roo');
    await rooSvc.injectSettings(
      { currentApiConfigName: 'roo-default' } as any,
      { keys: ['currentApiConfigName'] }
    );

    const zooReader = makeService('zoo');
    const zooSettings = await zooReader.extractSettings('safe');
    // Zoo still holds only the seed value — no currentApiConfigName key.
    expect(zooSettings.settings.currentApiConfigName).toBeUndefined();
  });
});
