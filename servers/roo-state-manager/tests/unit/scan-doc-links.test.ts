/**
 * #2639 / WS3 lot 2 — the doc-link scanner must measure, not guess.
 *
 * Lot 1 repaired the roo-state-manager tree down to `dead_active = 0`. That
 * number is only worth something if the instrument still sees a dead link, and
 * if it does not invent one. Both failure modes were measured on lot 2:
 *
 *   - jinavigator's `USAGE.md` holds `dateRegex = /\b(202\d)[-\/](0[1-9]|1[0-2]).../`
 *     inside a fenced block. The bare `[1-9](0[1-9]|1[0-2])` shape read as a
 *     markdown link and reported TWO dead targets in a file that has none.
 *   - sk-agent's three Markdown files carry no relative link at all, so a scan
 *     there answers `alive=0` — indistinguishable from "the walk found nothing".
 *
 * The script is a top-level side-effect CLI, so the honest way to test it is to
 * run it: fixtures on disk, real subprocess, parse the JSON it prints.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  fileURLToPath(new URL('../../scripts/scan-doc-links.mjs', import.meta.url))
);

let fixtureRoot: string;

function scan(root: string): {
  totals: { alive: number; dead_active: number; dead_frozen: number; code_ref: number; cross_repo: number };
  links: Array<{ file: string; href: string; cls: string }>;
} {
  const out = execFileSync(process.execPath, [SCRIPT, '--root', root, '--json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const deadTargets = (root: string): string[] =>
  scan(root)
    .links.filter((l) => l.cls === 'dead')
    .map((l) => l.href)
    .sort();

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'scan-doc-links-'));

  // Target that exists — a link to it must resolve.
  writeFileSync(join(fixtureRoot, 'exists.md'), '# exists\n');
  mkdirSync(join(fixtureRoot, 'docs', 'reports'), { recursive: true });
  // Freezing is a property of the SOURCE file, not of the target: a dead link
  // written inside docs/reports/ is reported, but outside the active count.
  writeFileSync(join(fixtureRoot, 'docs', 'reports', 'frozen.md'), '# frozen\n\n[gone3](../dead-in-frozen.md)\n');

  writeFileSync(
    join(fixtureRoot, 'PROBE.md'),
    [
      '# probe',
      '',
      '1. real dead link: [gone](./nope.md)',
      '2. real alive link: [ok](./exists.md)',
      '3. backticked text on a real target: [`exists`](./exists.md)',
      '',
      '```js',
      '// shape that must NOT be read as a link',
      'const dateRegex = /\\b(202\\d)[-\\/](0[1-9]|1[0-2])[-\\/](0[1-9]|[12][0-9]|3[01])\\b/g;',
      '```',
      '',
      '4. inline code span: `[gone2](nope2.md)`',
      '',
    ].join('\n')
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('#2639 lot 2 — scan-doc-links.mjs', () => {
  test('a real dead relative link is reported (the instrument is not blind)', () => {
    expect(deadTargets(fixtureRoot)).toContain('./nope.md');
  });

  test('a link to an existing file stays alive, backticked text included', () => {
    const alive = scan(fixtureRoot).links.filter((l) => l.cls === 'alive').map((l) => l.href);
    expect(alive).toContain('./exists.md');
    // Two occurrences: the plain link and the one whose text is code.
    expect(alive.filter((h) => h === './exists.md')).toHaveLength(2);
  });

  test('a regex literal inside a fenced block is not a link', () => {
    // The jinavigator case: `(0[1-9]|1[0-2])` and `(0[1-9]|[12][0-9]|3[01])`.
    const dead = deadTargets(fixtureRoot);
    expect(dead.some((h) => h.includes('1-2') || h.includes('[12]'))).toBe(false);
    expect(dead).toEqual(['../dead-in-frozen.md', './nope.md']);
  });

  test('an inline code span is not a link either', () => {
    expect(deadTargets(fixtureRoot)).not.toContain('nope2.md');
  });

  test('the frozen-tree dead link is counted, but separately from the active count', () => {
    const totals = scan(fixtureRoot).totals;
    expect(totals.dead_active).toBe(1);
    expect(totals.dead_frozen).toBe(1);
  });
});
