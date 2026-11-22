import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Domain = 'V' | 'C';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE_MODULE_GROUPS: Record<string, string> = {
  // Shared logging, with no tool- or conversation-domain state.
  logger: 'src/utils/logger.ts',
  // Server configuration and per-tool timeout policy.
  'server-config': 'src/config/server-config.ts',
  'tool-timeouts': 'src/config/tool-timeouts.ts',
  // Shared-state paths and lane identity.
  'shared-state-path': 'src/utils/shared-state-path.ts',
  'message-helpers': 'src/utils/message-helpers.ts',
  // Host capability and secret-publication helpers.
  'server-capabilities': 'src/utils/server-capabilities.ts',
  'secret-redaction': 'src/utils/secret-redaction.ts',
  'int-validator': 'src/utils/int-validator.ts',
  // Domain-neutral error contracts.
  errors: 'src/types/errors.ts',
  'diagnose-contracts': 'src/types/diagnose-contracts.ts',
  'diagnose-registry': 'src/services/diagnose-registry.ts',
  // PostgreSQL primitives shared by both future servers.
  'store-types': 'src/services/unified-store/types.ts',
  'pg-flags': 'src/services/unified-store/pg-flags.ts',
  'pg-backfill-marker': 'src/services/unified-store/pg-backfill-marker.ts',
  'read-gates': 'src/services/unified-store/read-gates.ts',
  'pg-read-gates': 'src/services/unified-store/pg-read-gates.ts',
  // Chat and embedding clients share their provider and credential lifecycle (G5).
  openai: 'src/services/openai.ts',
};
const CORE_MODULES = new Set(Object.values(CORE_MODULE_GROUPS));

const TOOL_MODULES: Record<Domain, string[]> = {
  V: [
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
  ],
  C: [
    'src/tools/conversation/conversation-browser.ts',
    'src/tools/search/search-codebase.tool.ts',
    'src/tools/search/roosync-search.tool.ts',
    'src/tools/indexing/roosync-indexing.tool.ts',
    'src/tools/export/export-data.ts',
    'src/tools/roosync/storage-management.ts',
    'src/tools/roosync/diagnose.ts',
    'src/tools/read-vscode-logs.ts',
  ],
};

function resolveImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (target.endsWith('.js')) target = `${target.slice(0, -3)}.ts`;
  return target;
}

type ImportEdge = { specifier: string; target: string | null; line: number };

function collectImports(file: string, text: string): ImportEdge[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: ImportEdge[] = [];

  function visit(node: ts.Node): void {
    let specifier: string | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier) {
      imports.push({
        specifier,
        target: resolveImport(file, specifier),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return imports;
}

const DOMAIN_BY_DIRECTORY: Record<string, Domain> = {
  // Fleet configuration, messaging, dashboard and presence services stay in V.
  'src/tools/roosync/': 'V',
  'src/services/roosync/': 'V',
  'src/services/lazy-roosync.ts': 'V',
  // Conversation/index/export helpers and their storage services stay in C.
  'src/tools/conversation/': 'C',
  'src/tools/search/': 'C',
  'src/tools/indexing/': 'C',
  'src/tools/export/': 'C',
  'src/tools/storage/': 'C',
  'src/tools/maintenance/': 'C',
  'src/tools/task/': 'C',
  'src/tools/repair/': 'C',
  'src/tools/diagnostic/': 'C',
  'src/services/task-indexer/': 'C',
  'src/services/code-index/': 'C',
  'src/services/task-archiver/': 'C',
  // Conversation-only services reached directly by a C tool.
  'src/services/XmlExporterService.ts': 'C',
  'src/services/TraceSummaryService.ts': 'C',
  'src/services/ExportConfigManager.ts': 'C',
  'src/services/state-manager.service.ts': 'C',
  'src/services/skeleton-cache.service.ts': 'C',
  'src/services/unified-store/conversation-list-store.ts': 'C',
};

function domainOf(file: string): Domain | 'core' | null {
  if (TOOL_MODULES.V.includes(file)) return 'V';
  if (TOOL_MODULES.C.includes(file)) return 'C';
  if (CORE_MODULES.has(file)) return 'core';
  for (const [prefix, domain] of Object.entries(DOMAIN_BY_DIRECTORY)) {
    if (file.startsWith(prefix)) return domain;
  }
  return null;
}

function importsOf(file: string): ImportEdge[] {
  return collectImports(file, readFileSync(path.join(ROOT, file), 'utf8'));
}

function crossingsOf(file: string, domain: Domain, edges: ImportEdge[]): string[] {
  return edges
    .filter(edge => edge.target && domainOf(edge.target) === (domain === 'V' ? 'C' : 'V'))
    .map(edge => `${file}:${edge.line} (${domain}) -> ${edge.target} (${domainOf(edge.target)})`);
}

describe('#2190 step 1 — VibeSync / Vibe-Conversations module boundary', () => {

  it('classifies static, re-exported and dynamic imports without executing application code', () => {
    const fixture = path.join(ROOT, 'tests/unit/architecture/vibesync-boundary.fixture.ts');
    expect(importsOf('tests/unit/architecture/vibesync-boundary.fixture.ts')).toEqual([
      { specifier: '../../../src/types/errors.js', target: 'src/types/errors.ts', line: 1 },
      { specifier: '../../../src/utils/logger.js', target: 'src/utils/logger.ts', line: 2 },
      { specifier: '../../../src/services/lazy-roosync.js', target: 'src/services/lazy-roosync.ts', line: 5 },
    ]);
    expect(readFileSync(fixture, 'utf8')).toContain("import('../../../src/services/lazy-roosync.js')");
    expect(domainOf('src/services/lazy-roosync.ts')).toBe('V');
    expect(domainOf('src/services/task-indexer/VectorIndexer.ts')).toBe('C');
    expect(domainOf('src/services/openai.ts')).toBe('core');
  });

  it('detects V-to-C, C-to-V and dynamic crossings on synthetic mutants', () => {
    expect(crossingsOf(
      'src/tools/roosync/dashboard.ts',
      'V',
      collectImports('src/tools/roosync/dashboard.ts', "import '../../services/task-indexer/VectorIndexer.js';"),
    )).toEqual(['src/tools/roosync/dashboard.ts:1 (V) -> src/services/task-indexer/VectorIndexer.ts (C)']);
    expect(crossingsOf(
      'src/tools/roosync/diagnose.ts',
      'C',
      collectImports('src/tools/roosync/diagnose.ts', "export * from '../../services/roosync/HeartbeatService.js';"),
    )).toEqual(['src/tools/roosync/diagnose.ts:1 (C) -> src/services/roosync/HeartbeatService.ts (V)']);
    expect(crossingsOf(
      'src/tools/roosync/diagnose.ts',
      'C',
      collectImports('src/tools/roosync/diagnose.ts', "void import('../../services/lazy-roosync.js');"),
    )).toEqual(['src/tools/roosync/diagnose.ts:1 (C) -> src/services/lazy-roosync.ts (V)']);
  });

  it('keeps every tool on its own side of the boundary, with no exception outside core', () => {
    const violations: string[] = [];
    for (const files of Object.values(TOOL_MODULES)) {
      for (const file of files) {
        violations.push(...crossingsOf(file, domainOf(file) as Domain, importsOf(file)));
      }
    }
    expect(violations, 'Cross-domain imports must be removed, not allowlisted').toEqual([]);
  });
});
