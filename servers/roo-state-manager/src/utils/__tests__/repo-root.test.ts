import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRooExtensionsRoot } from '../repo-root';

/**
 * #2406 P1-c — findRooExtensionsRoot extraite d'InventoryService (walk-up
 * CLAUDE.md + override ROO_EXTENSIONS_PATH), désormais partagée avec
 * ConfigNormalizationService pour %ROO_ROOT%.
 */
describe('findRooExtensionsRoot (#2406 P1-c)', () => {
  const savedEnv = process.env.ROO_EXTENSIONS_PATH;
  let tempRoot: string;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ROO_EXTENSIONS_PATH;
    else process.env.ROO_EXTENSIONS_PATH = savedEnv;
    vi.restoreAllMocks();
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns ROO_EXTENSIONS_PATH when set (override wins over walk-up)', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-env-'));
    const override = path.join(tempRoot, 'explicit-root');
    process.env.ROO_EXTENSIONS_PATH = override;

    expect(findRooExtensionsRoot()).toBe(override);
  });

  it('walks up from cwd to the nearest ancestor containing CLAUDE.md', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-walk-'));
    fs.writeFileSync(path.join(tempRoot, 'CLAUDE.md'), '# root\n', 'utf-8');
    const deep = path.join(tempRoot, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    delete process.env.ROO_EXTENSIONS_PATH;
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(deep);

    expect(findRooExtensionsRoot()).toBe(tempRoot);
    expect(cwdSpy).toHaveBeenCalled();
  });

  it('falls back to cwd when no ancestor (within 10 levels) has CLAUDE.md', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-fallback-'));
    const nested = path.join(tempRoot, 'x');
    fs.mkdirSync(nested, { recursive: true });
    delete process.env.ROO_EXTENSIONS_PATH;
    vi.spyOn(process, 'cwd').mockReturnValue(nested);

    expect(findRooExtensionsRoot()).toBe(nested);
  });
});
