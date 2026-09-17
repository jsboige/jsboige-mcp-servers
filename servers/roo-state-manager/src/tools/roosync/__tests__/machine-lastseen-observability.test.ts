/**
 * #3695 — machineLastSeen observability: fossil keys + post-condensation regression.
 *
 * Verified facts (po-2027 diagnostic 2026-09-16, reproduced firsthand on po-2023):
 *   A. Fossil keys: old-format headers `### [ts] machine:workspace|path`
 *      (fossilized on prod dashboards since 30/08, e.g. workspace-c--dev-CoursIA-2)
 *      created phantom activity keys `machine:workspace` that the current
 *      `machine|workspace` format never updates — frozen forever.
 *   B. Post-condensation regression (SUPPOSED in the issue, CONFIRMED by the
 *      stage-1 pre-fix reproduction, 2026-09-17): auto-condensation archives
 *      older messages out of the current dashboard file — headers preserved in
 *      dashboards/archive/ — and derivation that read only current files lost
 *      the machine entirely (machineLastSeen regressing to null).
 *
 * Fix under test (dashboard-activity v3.1.0):
 *   1. Parser normalizes the author field to the bare machine id (cut on both
 *      `|` and `:`), so old-format headers feed the real machine key.
 *   2. lookupMachineActivityInArchives() lazily recovers lastSeen from
 *      condensation archives for machines missing from current files —
 *      wired into get-status.ts and health-view.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { roosyncDashboard } from '../dashboard.js';
import {
  extractMachineActivity,
  lookupMachineActivityInArchives
} from '../../../utils/dashboard-activity.js';
import { resetChatOpenAIClient } from '@/services/openai';

const mockChatCreate = vi.fn();
const mockGetChatClient = vi.fn();

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => mockGetChatClient(),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

describe('#3695 — machineLastSeen observability', () => {
  describe('A. fossil keys: old machine:workspace|path headers normalize to the bare machine id', () => {
    it('does not create a phantom machine:workspace key frozen at its old date', () => {
      const fossilSource = [
        '### [2026-08-29T23:54:56.555Z] myia-po-2027:CoursIA-2|c--dev-CoursIA-2',
        'ancien message',
        '---',
        '### [2026-08-30T01:20:32.274Z] myia-po-2027:CoursIA-2|c--dev-CoursIA-2',
        'ancien message 2',
      ].join('\n');

      const activity = extractMachineActivity([fossilSource]);

      expect(activity.has('myia-po-2027:coursia-2')).toBe(false);
      // The fossil's timestamps now feed the REAL machine key (max wins)
      expect(activity.get('myia-po-2027')).toBe('2026-08-30T01:20:32.274Z');
    });

    it('merges old-format entries with current-format entries for the same machine (newest wins)', () => {
      const fossil = '### [2026-08-30T01:20:32.274Z] myia-po-2027:CoursIA-2|c--dev-CoursIA-2\nvieux';
      const fresh = '### [2026-09-16T19:09:15.100Z] myia-po-2027|roo-extensions\nrécent';

      const activity = extractMachineActivity([fossil, fresh]);

      expect(activity.size).toBe(1);
      expect(activity.get('myia-po-2027')).toBe('2026-09-16T19:09:15.100Z');
    });

    it('keeps current-format path-like workspaces untouched (workspace after | is discarded)', () => {
      const content = '### [2026-09-15T21:41:24.760Z] myia-po-2023|D:\\Production\\IISManagement\nmsg';
      const activity = extractMachineActivity([content]);
      expect(activity.get('myia-po-2023')).toBe('2026-09-15T21:41:24.760Z');
    });
  });

  describe('B. lookupMachineActivityInArchives (lazy recovery)', () => {
    let tmpDir: string;
    let dashboardsDir: string;
    let archiveDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'archives-3695-'));
      dashboardsDir = join(tmpDir, 'dashboards');
      archiveDir = join(dashboardsDir, 'archive');
      mkdirSync(archiveDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('recovers a machine whose headers only exist in an archive', () => {
      writeFileSync(
        join(archiveDir, 'workspace-ws-2026-09-10T10-00-00.md'),
        '### [2026-09-10T09:00:00.000Z] myia-silent-01|ws\nmessage archivé',
        'utf-8'
      );
      const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-silent-01']);
      expect(found.get('myia-silent-01')).toBe('2026-09-10T09:00:00.000Z');
    });

    it('returns the newest timestamp across several archives (newest-first scan)', () => {
      writeFileSync(
        join(archiveDir, 'workspace-ws-2026-09-10T10-00-00.md'),
        '### [2026-09-10T09:00:00.000Z] myia-silent-01|ws\nvieux',
        'utf-8'
      );
      writeFileSync(
        join(archiveDir, 'workspace-ws-2026-09-12T10-00-00.md'),
        '### [2026-09-12T08:30:00.000Z] myia-silent-01|ws\nrécent',
        'utf-8'
      );
      const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-silent-01']);
      expect(found.get('myia-silent-01')).toBe('2026-09-12T08:30:00.000Z');
    });

    it('normalizes old-format fossil headers found in archives too', () => {
      writeFileSync(
        join(archiveDir, 'workspace-ws-2026-08-30T10-00-00.md'),
        '### [2026-08-30T01:20:32.274Z] myia-po-2027:CoursIA-2|c--dev-CoursIA-2\nfossile',
        'utf-8'
      );
      const found = lookupMachineActivityInArchives(dashboardsDir, ['myia-po-2027']);
      expect(found.get('myia-po-2027')).toBe('2026-08-30T01:20:32.274Z');
      expect(found.has('myia-po-2027:coursia-2')).toBe(false);
    });

    it('returns an empty map for a machine never archived (honest null stays possible)', () => {
      writeFileSync(
        join(archiveDir, 'workspace-ws-2026-09-10T10-00-00.md'),
        '### [2026-09-10T09:00:00.000Z] myia-other-01|ws\nmessage',
        'utf-8'
      );
      expect(lookupMachineActivityInArchives(dashboardsDir, ['myia-ghost-01']).size).toBe(0);
    });

    it('tolerates a missing archive dir (fresh install) and skips non-.md entries', () => {
      rmSync(archiveDir, { recursive: true, force: true });
      expect(lookupMachineActivityInArchives(dashboardsDir, ['myia-silent-01']).size).toBe(0);
      expect(lookupMachineActivityInArchives(join(tmpDir, 'nope'), ['myia-silent-01']).size).toBe(0);
    });
  });

  describe('C. integration: real auto-condensation + recovery (the #3695 scenario)', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'condense-3695-'));
      process.env.ROOSYNC_SHARED_PATH = tmpDir;
      process.env.ROOSYNC_WORKSPACE_ID = 'ws-3695';
      resetChatOpenAIClient();
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
      mockGetChatClient.mockReturnValue({ chat: { completions: { create: mockChatCreate } } });
      mockChatCreate.mockReset();
      mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '## Résumé\n\n- item' } }] });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      delete process.env.ROOSYNC_SHARED_PATH;
      delete process.env.ROOSYNC_WORKSPACE_ID;
      delete process.env.ROOSYNC_MACHINE_ID;
    });

    it('a machine fully archived by condensation keeps its derived lastSeen (before/after measured)', async () => {
      await roosyncDashboard({ action: 'write', type: 'workspace', content: '# Init' });

      const dashboardsDir = join(tmpDir, 'dashboards');
      const topLevelContents = () =>
        readdirSync(dashboardsDir)
          .filter(f => f.endsWith('.md') && !f.endsWith('.tmp'))
          .map(f => readFileSync(join(dashboardsDir, f), 'utf-8'));

      // SILENT machine posts 12 messages (~1.2 KB each) — under all thresholds
      process.env.ROOSYNC_MACHINE_ID = 'myia-silent-01';
      for (let i = 0; i < 12; i++) {
        await roosyncDashboard({ action: 'append', type: 'workspace', content: `SILENT ${i} ` + 's'.repeat(1100) });
      }

      // BEFORE: silent machine derived from the current file
      const before = extractMachineActivity(topLevelContents());
      expect(before.get('myia-silent-01')).toBeTruthy();

      // FLOOD machine pushes past the 46 KB preemptive threshold — newer messages only
      process.env.ROOSYNC_MACHINE_ID = 'myia-flood-01';
      let condensed = false;
      for (let i = 0; i < 16; i++) {
        const r: any = await roosyncDashboard({ action: 'append', type: 'workspace', content: `FLOOD ${i} ` + 'f'.repeat(3300) });
        if (r?.condensed) condensed = true;
      }
      expect(condensed).toBe(true); // condensation actually ran

      // The archive exists and preserved the silent machine's headers
      const archiveDir = join(dashboardsDir, 'archive');
      const archives = readdirSync(archiveDir).filter(f => f.endsWith('.md'));
      expect(archives.length).toBeGreaterThan(0);
      expect(archives.map(f => readFileSync(join(archiveDir, f), 'utf-8')).join('\n')).toContain('myia-silent-01');

      // AFTER, current files only: the silent machine is gone (why archives are consulted)
      const afterCurrentOnly = extractMachineActivity(topLevelContents());
      expect(afterCurrentOnly.has('myia-silent-01')).toBe(false);
      // Positive control: the living machine's emission registers in derived state
      expect(afterCurrentOnly.get('myia-flood-01')).toBeTruthy();

      // AFTER, with the #3695 recovery (exactly what get-status/health-view do):
      const recovered = lookupMachineActivityInArchives(dashboardsDir, ['myia-silent-01']);
      expect(recovered.get('myia-silent-01')).toBeTruthy();
      const merged = new Map(afterCurrentOnly);
      for (const [mid, ts] of recovered) {
        const existing = merged.get(mid);
        if (!existing || ts > existing) merged.set(mid, ts);
      }
      expect(merged.get('myia-silent-01')).toBeTruthy();
      expect(merged.get('myia-flood-01')).toBeTruthy();
    });
  });
});
