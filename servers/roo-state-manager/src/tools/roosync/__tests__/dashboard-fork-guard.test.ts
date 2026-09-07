/**
 * #3482 — unit tests for the post-write fork guard (verifyDashboardWriteLanded).
 *
 * The guard runs after every dashboard write (tmp→rename) and must detect the
 * DriveFS/Windows deviation measured 06/09: the rename "succeeds" but lands on
 * a `<stem> (N).md` fork while the canonical stops advancing — an [ASK USER]
 * stayed invisible from the canonical that way.
 *
 * Discriminators under test:
 *   - totalMessages (fleet-monotonic counter, clock-independent): smaller than
 *     expected = our write never landed; larger = concurrent winner (nominal).
 *   - lastModified lexicographic ISO fallback when totalMessages is absent.
 *   - fresh collision-named sibling (mtime inside the write window) — a stale
 *     archived fork must NOT arm the guard.
 *   - never throws: unverifiable (canonical unreadable) = ok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { verifyDashboardWriteLanded } from '../dashboard.js';

describe('verifyDashboardWriteLanded (#3482 fork guard)', () => {
  let dir: string;
  let canonical: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fork-guard-'));
    canonical = path.join(dir, 'workspace-v2.test.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const frontmatter = (total: number | null, lastModified: string): string =>
    total === null
      ? `---\ntype: workspace\nlastModified: '${lastModified}'\n---\n\n## Intercom\n`
      : `---\ntype: workspace\nlastModified: '${lastModified}'\ntotalMessages: ${total}\n---\n\n## Intercom\n`;

  const expected = (totalMessages: number, lastModified = '2026-09-07T10:00:00.000Z') =>
    ({ lastModified, totalMessages });

  it('ok — canonical reflects the write, no sibling', async () => {
    await writeFile(canonical, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
    expect(r.forkDetail).toBeUndefined();
  });

  it('suspect — canonical totalMessages SMALLER than expected (write never landed)', async () => {
    // The deviation signature: the fork got our write, the canonical kept its
    // previous state (here 8, we computed 10 from a base of 8).
    await writeFile(canonical, frontmatter(8, '2026-09-07T09:59:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/totalMessages canonique 8 < attendu 10/);
  });

  it('ok — canonical totalMessages LARGER than expected (concurrent winner after our rename)', async () => {
    await writeFile(canonical, frontmatter(12, '2026-09-07T10:00:05.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });

  it('suspect — fresh collision-named sibling inside the write window (dotted stem must still match)', async () => {
    await writeFile(canonical, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const forkPath = path.join(dir, 'workspace-v2.test (1).md');
    await writeFile(forkPath, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/fork frais/);
    expect(r.forkPath).toBe(forkPath);
  });

  it('ok — stale archived fork sibling (mtime outside the write window) does NOT arm the guard', async () => {
    await writeFile(canonical, frontmatter(10, '2026-09-07T10:00:00.000Z'), 'utf8');
    const forkPath = path.join(dir, 'workspace-v2.test (1).md');
    await writeFile(forkPath, 'old archived fork', 'utf8');
    const oneHourAgo = new Date(Date.now() - 3600_000);
    await utimes(forkPath, oneHourAgo, oneHourAgo);
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });

  it('ok — canonical unreadable (missing) is unverifiable, not suspected', async () => {
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });

  it('suspect — lastModified fallback fires when totalMessages is absent and canonical is older', async () => {
    await writeFile(canonical, frontmatter(null, '2026-09-07T09:00:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(true);
    expect(r.forkDetail).toMatch(/lastModified canonique/);
  });

  it('ok — lastModified fallback passes when canonical lastModified is newer', async () => {
    await writeFile(canonical, frontmatter(null, '2026-09-07T10:05:00.000Z'), 'utf8');
    const r = await verifyDashboardWriteLanded(canonical, expected(10), Date.now() - 5000);
    expect(r.forkSuspected).toBe(false);
  });
});
