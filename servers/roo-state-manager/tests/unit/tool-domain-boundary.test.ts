/**
 * #4870 grain G6 — boundary test for the future vibesync / vibe-conversations split.
 *
 * Epic #2190 splits roo-state-manager into two MCPs on a shared `@vibesync/core`
 * trunk: V (vibesync — dashboards, messages, config, inventory, harmonisation,
 * claudish) and C (vibe-conversations — conversations, search, indexing, export,
 * storage). This test is the instrument that keeps the boundary from eroding
 * while the split is done on the spot: it reads the STATIC and DYNAMIC imports of
 * the 18 tool entry modules, classifies each resolved target as V, C or trunk,
 * and fails on any V→C or C→V edge.
 *
 * Measured on c1320812 (28/11): zero traversals. The three couplings the issue
 * recorded on 620cbb2e are closed by other routes, which is why the whitelist is
 * empty today — and why it must stay visible rather than silently grow:
 *   G1  dashboard.ts redactSecrets      -> @vibesync/core/utils/secret-redaction (trunk)
 *   G2  storage-management Heartbeat... -> @vibesync/core/types/errors (trunk)
 *   G4  index.ts mirror repair          -> services/roosync/DashboardMirrorService.js
 *   G5  openai.ts is classified TRUNK (shared by the condensation client and embeddings)
 *
 * An unlisted path is trunk by default: utils/, types/, services/openai.ts,
 * services/unified-store/**, notifications/**, @vibesync/core/** are all shared.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Domain = 'V' | 'C';

const V_TOOLS = [
  'src/tools/roosync/dashboard.ts',
  'src/tools/roosync/messages.ts',
  'src/tools/roosync/config.ts',
  'src/tools/roosync/compare-config.ts',
  'src/tools/roosync/baseline.ts',
  'src/tools/roosync/inventory.ts',
  'src/tools/roosync/mcp-management.ts',
  'src/tools/roosync/harmonization.ts',
  'src/tools/roosync/claudish-cascade.ts',
  'src/tools/claudish-traffic.ts',
];

const C_TOOLS = [
  'src/tools/conversation/conversation-browser.ts',
  'src/tools/search/search-codebase.tool.ts',
  'src/tools/search/roosync-search.tool.ts',
  'src/tools/indexing/roosync-indexing.tool.ts',
  'src/tools/export/export-data.ts',
  'src/tools/roosync/storage-management.ts',
  'src/tools/roosync/diagnose.ts',
  'src/tools/read-vscode-logs.ts',
];

const TOOL_DOMAIN = new Map<string, Domain>([
  ...V_TOOLS.map((f) => [f, 'V'] as [string, Domain]),
  ...C_TOOLS.map((f) => [f, 'C'] as [string, Domain]),
]);

/**
 * Paths that belong to ONE domain without being a tool entry module — the
 * engine each side owns. Measured, not guessed: no V tool reaches task-indexer
 * or code-index today, and no C tool reaches services/roosync.
 */
const DOMAIN_PREFIXES: Array<{ prefix: string; domain: Domain }> = [
  { prefix: 'src/services/task-indexer/', domain: 'C' },
  { prefix: 'src/services/code-index/', domain: 'C' },
  { prefix: 'src/services/qdrant.ts', domain: 'C' },
  { prefix: 'src/services/task-archiver/', domain: 'C' },
  { prefix: 'src/services/roosync/', domain: 'V' },
];

/**
 * Deliberate crossings. Empty today (see the header). Every entry must carry a
 * reason AND must still be needed: a stale exception turns the last test red,
 * so the list cannot rot into a permanent blanket.
 */
const WHITELIST: Array<{ from: string; specifier: string; why: string }> = [];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

const STATIC_RE = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module specifier a file reaches, static and dynamic, comments removed. */
export function extractSpecifiers(src: string): string[] {
  const clean = stripComments(src);
  const out: string[] = [];
  for (const m of clean.matchAll(STATIC_RE)) out.push(m[1]);
  for (const m of clean.matchAll(DYNAMIC_RE)) out.push(m[1]);
  return out;
}

/** Resolve a relative specifier to a repo-relative posix path ('.js' -> '.ts'). */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // bare package = @vibesync/core or npm = trunk
  const dir = path.posix.dirname(fromFile);
  let rel = path.posix.normalize(path.posix.join(dir, specifier));
  if (rel.endsWith('.js')) rel = rel.slice(0, -3) + '.ts';
  return rel;
}

function classify(repoRel: string): Domain | 'trunk' {
  const tool = TOOL_DOMAIN.get(repoRel);
  if (tool) return tool;
  for (const { prefix, domain } of DOMAIN_PREFIXES) {
    if (repoRel === prefix || repoRel.startsWith(prefix)) return domain;
  }
  return 'trunk';
}

interface Edge {
  from: string;
  fromDomain: Domain;
  specifier: string;
  target: string;
  targetDomain: Domain;
}

function collectCrossings(): Edge[] {
  const found: Edge[] = [];
  for (const [fromFile, fromDomain] of TOOL_DOMAIN) {
    const src = fs.readFileSync(path.join(ROOT, fromFile), 'utf8');
    for (const specifier of extractSpecifiers(src)) {
      const target = resolveSpecifier(fromFile, specifier);
      if (!target) continue;
      const targetDomain = classify(target);
      if (targetDomain === 'trunk' || targetDomain === fromDomain) continue;
      const whitelisted = WHITELIST.some((w) => w.from === fromFile && w.specifier === specifier);
      if (!whitelisted) found.push({ from: fromFile, fromDomain, specifier, target, targetDomain });
    }
  }
  return found;
}

describe('#4870 G6 — vibesync/vibe-conversations tool boundary', () => {
  it('classifies all 18 tool entry modules, and they exist on disk', () => {
    expect(TOOL_DOMAIN.size).toBe(18);
    expect(V_TOOLS).toHaveLength(10);
    expect(C_TOOLS).toHaveLength(8);
    for (const file of TOOL_DOMAIN.keys()) {
      expect(fs.existsSync(path.join(ROOT, file)), `missing tool module: ${file}`).toBe(true);
    }
  });

  it('an unlisted path is trunk, and the two same-directory opposites stay split', () => {
    expect(classify('src/tools/roosync/dashboard.ts')).toBe('V');
    expect(classify('src/tools/roosync/storage-management.ts')).toBe('C');
    expect(classify('src/services/task-indexer/VectorIndexer.ts')).toBe('C');
    expect(classify('src/services/roosync/DashboardMirrorService.ts')).toBe('V');
    expect(classify('src/services/openai.ts')).toBe('trunk');
    expect(classify('src/services/unified-store/types.ts')).toBe('trunk');
    expect(classify('src/utils/secret-redaction.ts')).toBe('trunk');
  });

  it('detects DYNAMIC imports, not only static ones', () => {
    const sample = [
      "import { a } from '../../services/openai.js';",
      "// import { b } from './commented-out.js';",
      '/* import { c } from "./block-commented.js"; */',
      "const m = await import('../../services/task-indexer/VectorIndexer.js');",
    ].join('\n');
    const specs = extractSpecifiers(sample);
    expect(specs).toEqual([
      '../../services/openai.js',
      '../../services/task-indexer/VectorIndexer.js',
    ]);
  });

  it('no tool module reaches the other domain (0 exception outside trunk)', () => {
    const crossings = collectCrossings();
    const rendered = crossings
      .map((e) => `  ${e.fromDomain} ${e.from} -> ${e.targetDomain} ${e.target} (via '${e.specifier}')`)
      .join('\n');
    expect(crossings, `domain crossings found:\n${rendered}`).toEqual([]);
  });

  it('every whitelist entry is still needed (no stale exception)', () => {
    const crossings = collectCrossings();
    const used = WHITELIST.filter((w) =>
      crossings.some((e) => e.from === w.from && e.specifier === w.specifier)
    );
    expect(used, 'whitelist entries that no longer match a real crossing must be removed').toEqual(
      WHITELIST
    );
  });
});
