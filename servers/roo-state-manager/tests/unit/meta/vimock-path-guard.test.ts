/**
 * CI Guard: vi.mock relative-path resolution (#2642 follow-on).
 *
 * Prevents the silent no-op regression documented in PRs #869/#870. A
 * `vi.mock('../X.js')` whose path does NOT resolve to a real module file
 * silently no-ops — vitest registers the mock for a non-existent module, the
 * SUT imports its OWN (different) resolution of the same string, and the test
 * runs on the real dependency instead of the mock. The file passes green while
 * exercising nothing.
 *
 * This guard walks every non-archived test file, resolves each static
 * `vi.mock('./...' | '../...')` specifier from the TEST FILE's directory (the
 * gotcha — not the SUT's), and fails if the target doesn't exist on disk.
 *
 * The earlier diagnostic sweep (c.71, scratchpad `vimock-sweep3.mjs`) carried a
 * `testImportsIt` exemption that classified a phantom as a "legit virtual mock"
 * when the test file itself imported the same specifier. That exemption is
 * UNSOUND: in `diagnose-index.tool.test.ts` both the `vi.mock` and the `import`
 * used the same phantom path, so the mock only fed the test's own direct import
 * while the SUT still ran on the real service module. The guard therefore has
 * NO exemption — a relative path to a non-existent file is always a bug.
 *
 * Legit virtual mocks should use bare/virtual specifiers, not relative paths to
 * files that don't exist.
 *
 * @see PRs #869, #870 — vi.mock phantom-path fixes
 * @see memory vimock-path-tests-subdir-depth.md
 */
import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, basename, join, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = resolve(fileURLToPath(import.meta.url));
// tests/unit/meta/vimock-path-guard.test.ts → servers/roo-state-manager/
const SERVER_ROOT = resolve(dirname(__filename), '..', '..', '..');
const SERVER_ROOT_NORM = SERVER_ROOT.replace(/\\/g, '/');

// Static relative specifiers only: './x' or '../x' (one or two dots + slash).
// Dynamic/template-literal vi.mock() args are out of scope (different concern;
// vitest already warns about non-hoistable dynamic mocks).
const VI_MOCK_RE = /vi\.mock\(\s*['"](\.{1,2}\/[^'"]+)['"]/g;

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git', '_archives', 'backups', 'coverage']);

function walkTestFiles(dir: string, out: string[], requireTestsSubdir: boolean): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st: { isDirectory(): boolean; isFile(): boolean };
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTestFiles(p, out, requireTestsSubdir);
    } else if (st.isFile() && /\.test\.tsx?$/.test(entry)) {
      // For src/ walks, only collect tests inside __tests__/ (mirrors the CI
      // include glob `src/**/__tests__/**`). tests/unit/ collects all.
      if (requireTestsSubdir && !p.includes(`${sep}__tests__${sep}`)) continue;
      out.push(p);
    }
  }
}

interface Phantom {
  /** repo-relative test file path */
  file: string;
  /** the vi.mock specifier as written in the test */
  mockpath: string;
  /** repo-relative resolved target (without extension) */
  resolved: string;
}

function findPhantoms(): Phantom[] {
  const files: string[] = [];
  // Scan exactly the set the CI/unit configs execute:
  //   tests/unit/**/*.test.ts  +  src/**/__tests__/**/*.test.ts
  // Files outside these globs (tests/e2e, tests/integration, archived) are not
  // run in CI, so a broken mock there is inert — flagging it would be noise.
  walkTestFiles(join(SERVER_ROOT, 'tests', 'unit'), files, false);
  walkTestFiles(join(SERVER_ROOT, 'src'), files, true);

  const phantoms: Phantom[] = [];
  for (const abs of files) {
    // Don't analyse this guard file itself.
    if (resolve(abs) === __filename) continue;

    let txt: string;
    try {
      txt = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // Perf skip: only regex files that actually call vi.mock.
    if (!txt.includes('vi.mock(')) continue;

    VI_MOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VI_MOCK_RE.exec(txt)) !== null) {
      const mockpath = m[1];
      // CRUCIAL: resolve relative to the TEST FILE's directory.
      const resolvedDir = resolve(dirname(abs), dirname(mockpath));
      const baseRaw = basename(mockpath).replace(/\.(js|ts|tsx|jsx|mjs|cjs|json)$/, '');
      const candidates = [
        `${baseRaw}.ts`,
        `${baseRaw}.tsx`,
        `${baseRaw}.d.ts`,
        `${baseRaw}.js`,
        `${baseRaw}.jsx`,
        `${baseRaw}.mjs`,
        `${baseRaw}.cjs`,
        `${baseRaw}.json`,
      ];
      // Directory import ('utils/') → check for an index module.
      if (mockpath.endsWith('/')) {
        candidates.push(join(baseRaw, 'index.ts'));
        candidates.push(join(baseRaw, 'index.js'));
        candidates.push(join(baseRaw, 'index.tsx'));
      }
      const exists = candidates.some((c) => existsSync(join(resolvedDir, c)));
      if (!exists) {
        phantoms.push({
          file: abs.replace(/\\/g, '/').replace(SERVER_ROOT_NORM + '/', ''),
          mockpath,
          resolved: join(resolvedDir, baseRaw).replace(/\\/g, '/').replace(SERVER_ROOT_NORM + '/', '') + '.*',
        });
      }
    }
  }
  return phantoms;
}

/**
 * Ratchet allowlist of pre-existing phantom-path violations.
 *
 * When this guard was introduced it found these violations already present on
 * main. They are allowlisted so the guard ships green and catches NEW
 * regressions; each is tracked for a focused fix in #2851.
 *
 * The ratchet is self-tightening: the test ALSO fails if an entry here is no
 * longer a live phantom (the path was fixed) but not removed from this list —
 * so cleanup is forced and the list can only shrink.
 *
 * To remove an entry: fix the path in the listed file, confirm the test passes
 * (`npx vitest run <file> --config vitest.config.ci.ts`), then delete the entry.
 */
const KNOWN_VIOLATIONS: ReadonlyArray<{ file: string; mockpath: string }> = [
  {
    file: 'src/tools/indexing/__tests__/diagnose-index.tool.test.ts',
    mockpath: '../../services/qdrant.js',
  },
  {
    file: 'src/tools/indexing/__tests__/diagnose-index.tool.test.ts',
    mockpath: '../../services/openai.js',
  },
  {
    file: 'tests/unit/tools/manage-mcp-settings.test.ts',
    mockpath: '../../src/managers/McpSettingsManager',
  },
  {
    file: 'tests/unit/tools/roosync/decision-helpers.test.ts',
    mockpath: '../../../src/utils/roosync-parsers.js',
  },
];

const phantomKey = (p: { file: string; mockpath: string }) => `${p.file}::${p.mockpath}`;

describe('vi.mock relative-path CI guard (#2642)', () => {
  test('no NEW vi.mock(relative-path) phantom — known violations tracked in #2851', () => {
    const phantoms = findPhantoms();
    const knownKeys = new Set(KNOWN_VIOLATIONS.map(phantomKey));

    const newViolations = phantoms.filter((p) => !knownKeys.has(phantomKey(p)));
    const staleAllowlist = KNOWN_VIOLATIONS.filter(
      (v) => !phantoms.some((p) => phantomKey(p) === phantomKey(v)),
    );

    const sections: string[] = [];

    if (newViolations.length > 0) {
      const lines = newViolations
        .map((p) => `  ${p.file}\n    vi.mock('${p.mockpath}') -> ${p.resolved} (no such file)`)
        .join('\n');
      sections.push(
        `${newViolations.length} NEW vi.mock() phantom(s) — relative path does NOT resolve to a real module file.\n` +
          `These mocks silently no-op: the test runs on the real dependency instead of the mock ` +
          `(bug class #2642; see PRs #869/#870, memory vimock-path-tests-subdir-depth.md).\n` +
          `Fix: correct the path relative to the TEST FILE's directory ` +
          `(from __tests__/, '../X' usually needs '../../X').\n\n${lines}`,
      );
    }

    if (staleAllowlist.length > 0) {
      const lines = staleAllowlist
        .map((v) => `  ${v.file} :: vi.mock('${v.mockpath}')`)
        .join('\n');
      sections.push(
        `${staleAllowlist.length} KNOWN_VIOLATIONS entry(ies) no longer detected — the phantom was fixed.\n` +
          `Remove the entry from KNOWN_VIOLATIONS in tests/unit/meta/vimock-path-guard.test.ts ` +
          `to tighten the ratchet (tracked in #2851).\n\n${lines}`,
      );
    }

    if (sections.length > 0) {
      throw new Error(sections.join('\n\n'));
    }

    // phantoms may be non-empty (== KNOWN_VIOLATIONS), which is allowed.
    expect(newViolations).toEqual([]);
    expect(staleAllowlist).toEqual([]);
  });
});
