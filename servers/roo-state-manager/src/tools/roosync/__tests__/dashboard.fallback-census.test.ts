/**
 * #3962 piste 3 renforcée (META po-2025 21/10) — durable per-key census of
 * fallback-truncation archives, machine-counted.
 *
 * The host counter shipped with ms#1473 dies with the process and never sees
 * other hosts' passes; the `-fallback.md` archive listing is the durable
 * cross-host record. The LLM status was measured hand-typing a wrong count on
 * the very day of the META (announced 3, 5 archives measured, 21/10). These
 * tests pin the census contract:
 *   (c1) pure counting — exact `${key}-<YYYY-MM-DDTHH-MM-SS>-fallback.md`
 *        names count; other keys, normal archives and malformed names never do;
 *   (c2) 48h sliding window on the FILE-NAME timestamp — 47h counts, 49h does
 *        not, a slightly future stamp (clock skew on the writing host) counts;
 *   (c3) idempotent strip — a previously stamped census line is removed before
 *        re-stamping (LLM prose quoting the phrase mid-line survives);
 *   (c4) stamping — 2 recent archives on this key → one machine-counted line;
 *        no history → no line at all;
 *   (c5) end-to-end: a SUCCESSFUL condensation lands the census line in the
 *        committed status section, counted from archives that predate the pass.
 *
 * @module tools/roosync/__tests__/dashboard.fallback-census
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  isDashboardPgPrimary: vi.fn(),
  readDashboardFromPgUngated: vi.fn(),
  readDashboardFromPg: vi.fn(),
  probeDashboardJournalForHydration: vi.fn(),
  dualWriteDashboardSync: vi.fn(),
  dualWriteDashboardDelete: vi.fn(),
  getDashboardRetirement: vi.fn(),
  listRetiredDashboardKeys: vi.fn(),
  retireDashboardKeyChecked: vi.fn(),
  acquireDashboardSharedLock: vi.fn(),
  releaseDashboardSharedLock: vi.fn(),
  fetchArchivedDashboardMessageIds: vi.fn(),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  // Gate OFF + PG null : la condensation ancre tout sur le fichier (même
  // surface mockée que dashboard-condense-status-cas.test.ts).
  ...mocks,
}));

vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => ({
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: 'STATUT RESUME PAR LLM (#3962)' } }] }),
      },
    },
  }),
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import {
  countRecentFallbackArchives,
  stripFallbackCensusLine,
  appendFallbackCensusLine,
  FALLBACK_CENSUS_MARKER_PREFIX,
} from '../dashboard.js';
import { roosyncDashboard } from '../dashboard.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-fallback-census-');

const KEY = 'workspace-test-machine-test-workspace';
const HOUR = 60 * 60 * 1000;

/** Name an archive exactly as executeTruncationFallback does (UTC, `:`→`-`). */
function archiveName(key: string, agoMs: number): string {
  const ts = new Date(Date.now() - agoMs).toISOString().replace(/[:.]/g, '-').substring(0, 19);
  return `${key}-${ts}-fallback.md`;
}

describe('#3962 piste 3 renforcée — machine-counted per-key census of fallback archives', () => {
  describe('countRecentFallbackArchives (pur)', () => {
    const now = Date.UTC(2026, 9, 22, 12, 0, 0); // 2026-10-22T12:00:00Z

    function tsName(key: string, utc: string): string {
      return `${key}-${utc.replace(/[:.]/g, '-')}-fallback.md`;
    }

    it('(c1) compte exactement les archives fallback de LA clé — ni autres clés, ni archives normales, ni noms malformés', () => {
      const names = [
        tsName(KEY, '2026-10-22T09:00:00'),            // recent, this key → count
        tsName(KEY, '2026-10-21T20:30:10'),            // recent, this key → count
        `${KEY}-2026-10-22T09-00-00.md`,               // normal archive (no -fallback) → no
        tsName('workspace-other-machine-other', '2026-10-22T09:00:00'), // other key → no
        tsName('global', '2026-10-22T09:00:00'),       // other key → no
        `${KEY}-2026-10-22T09-00-00-fallback.md.bak`,  // trailing junk → no
        `${KEY}-20261022T09-00-00-fallback.md`,        // malformed timestamp → no
        `${KEY}-fallback.md`,                          // missing timestamp → no
      ];
      expect(countRecentFallbackArchives(names, KEY, now)).toBe(2);
    });

    it('(c2) fenêtre glissante 48h sur l’horodatage du NOM — 47h compte, 49h non, skew futur compte', () => {
      const names = [
        tsName(KEY, '2026-10-20T13:00:00'), // now - 47h → in window
        tsName(KEY, '2026-10-20T11:00:00'), // now - 49h → out
        tsName(KEY, '2026-10-22T12:05:00'), // 5min AHEAD (clock skew on writer) → counts
      ];
      expect(countRecentFallbackArchives(names, KEY, now)).toBe(2);
    });
  });

  describe('stripFallbackCensusLine (pur)', () => {
    it('(c3) retire les lignes de census pré-éstampées (line-anchored), préserve la prose citée', () => {
      const text = [
        'Ligne de corps.',
        `${FALLBACK_CENSUS_MARKER_PREFIX} 3 archives on this key — machine-counted (#3962)`,
        'Prose LLM qui cite «Fallback-truncated (48h):» au milieu d’une ligne.',
        `${FALLBACK_CENSUS_MARKER_PREFIX} ligne périmée d’un cycle précédent`,
      ].join('\n');
      const stripped = stripFallbackCensusLine(text);
      // Line-anchored: NO line may START with the sentinel anymore…
      for (const line of stripped.split('\n')) {
        expect(line.startsWith(FALLBACK_CENSUS_MARKER_PREFIX)).toBe(false);
      }
      // …but prose quoting the phrase mid-line survives.
      expect(stripped).toContain('Ligne de corps.');
      expect(stripped).toContain('Prose LLM qui cite');
      // Idempotent.
      expect(stripFallbackCensusLine(stripped)).toBe(stripped);
    });
  });

  describe('appendFallbackCensusLine (FS réel)', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(testTmpBase);
      process.env.ROOSYNC_SHARED_PATH = tmpDir;
      await mkdir(path.join(tmpDir, 'dashboards', 'archive'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      delete process.env.ROOSYNC_SHARED_PATH;
    });

    it('(c4) 2 archives récentes → une ligne machine-counted «2 archives» ; dir absent → pas de ligne', async () => {
      const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
      await writeFile(path.join(archiveDir, archiveName(KEY, 0.5 * HOUR)), '', 'utf8');
      await writeFile(path.join(archiveDir, archiveName(KEY, 3 * HOUR)), '', 'utf8');
      await writeFile(path.join(archiveDir, archiveName(KEY, 100 * HOUR)), '', 'utf8'); // out of window
      await writeFile(path.join(archiveDir, archiveName('global', 0.5 * HOUR)), '', 'utf8'); // other key

      const stamped = await appendFallbackCensusLine(KEY, '# Statut');
      expect(stamped.startsWith(FALLBACK_CENSUS_MARKER_PREFIX)).toBe(false); // appended AFTER body
      expect(stamped).toContain(`${FALLBACK_CENSUS_MARKER_PREFIX} 2 archives`);
      expect(stamped).toContain('#3962');
      expect(stamped).toContain('machine-counted');

      // Idempotence par strip préalable : re-stamper ne duplique pas.
      const reStamped = await appendFallbackCensusLine(KEY, stamped);
      expect(reStamped.match(new RegExp(FALLBACK_CENSUS_MARKER_PREFIX.replace(/[()]/g, '\\$&'), 'g'))?.length).toBe(1);
    });

    it('(c4b) aucune archive → aucune ligne (strip seul)', async () => {
      const stamped = await appendFallbackCensusLine(KEY, `# Statut\n\n${FALLBACK_CENSUS_MARKER_PREFIX} 7 archives périmées`);
      expect(stamped).toBe('# Statut');
    });

    it('(c4c) dir d’archives absent → pas de ligne, pas de crash', async () => {
      // New shared path without any archive dir.
      const empty = await mkdtemp(testTmpBase);
      try {
        process.env.ROOSYNC_SHARED_PATH = empty;
        const stamped = await appendFallbackCensusLine(KEY, '# Statut');
        expect(stamped).toBe('# Statut');
      } finally {
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        await rm(empty, { recursive: true, force: true });
      }
    });
  });

  describe('end-to-end — condensation réussie', { timeout: 60000 }, () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(testTmpBase);
      process.env.ROOSYNC_SHARED_PATH = tmpDir;
      process.env.ROOSYNC_MACHINE_ID = 'test-machine';
      process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
      process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_CHAT_MODEL_ID;
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.EMBEDDING_API_BASE_URL;
      // mockReset:true wipe les implémentations hoisted — ré-armement par test.
      mocks.isDashboardPgPrimary.mockReturnValue(false);
      mocks.readDashboardFromPgUngated.mockResolvedValue(null);
      mocks.readDashboardFromPg.mockResolvedValue(null);
      mocks.probeDashboardJournalForHydration.mockResolvedValue({ kind: 'empty' });
      mocks.dualWriteDashboardSync.mockResolvedValue(undefined);
      mocks.dualWriteDashboardDelete.mockResolvedValue(undefined);
      mocks.getDashboardRetirement.mockResolvedValue(null);
      mocks.listRetiredDashboardKeys.mockResolvedValue(new Set<string>());
      mocks.retireDashboardKeyChecked.mockResolvedValue({ ok: true, reason: 'written' });
      mocks.acquireDashboardSharedLock.mockResolvedValue('unavailable');
      mocks.releaseDashboardSharedLock.mockResolvedValue(undefined);
      mocks.fetchArchivedDashboardMessageIds.mockResolvedValue(null);
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
      delete process.env.ROOSYNC_SHARED_PATH;
      delete process.env.ROOSYNC_MACHINE_ID;
      delete process.env.ROOSYNC_WORKSPACE_ID;
      delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    });

    async function readStatusSection(key: string): Promise<string> {
      const content = await readFile(path.join(tmpDir, 'dashboards', `${key}.md`), 'utf8');
      const match = content.match(/## Status\n\n([\s\S]*?)\n\n## Intercom/);
      return match ? match[1] : '(section Status introuvable)';
    }

    it('(c5) le status condensé porte la ligne de census comptée depuis les archives préexistantes', async () => {
      const writeResult = await roosyncDashboard({
        action: 'write',
        type: 'workspace',
        content: 'STATUT INITIAL #3962',
        createIfNotExists: true,
      });
      const key = writeResult.key;
      // Degrading history predating this pass: 2 recent fallback archives on
      // this key (+ one stale, one foreign key — neither must count). The key
      // comes from the live dashboard (a workspace key embeds the workspace
      // id, not the machine id — hardcoding it inverted the census once).
      const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
      await mkdir(archiveDir, { recursive: true });
      await writeFile(path.join(archiveDir, archiveName(key, 1 * HOUR)), '', 'utf8');
      await writeFile(path.join(archiveDir, archiveName(key, 4 * HOUR)), '', 'utf8');
      await writeFile(path.join(archiveDir, archiveName(key, 100 * HOUR)), '', 'utf8');
      await writeFile(path.join(archiveDir, archiveName('global', 1 * HOUR)), '', 'utf8');
      const filler = 'x'.repeat(900);
      for (let i = 0; i < 40; i++) {
        await roosyncDashboard({
          action: 'append',
          type: 'workspace',
          content: `Message ${i}: ${filler}`,
          tags: ['INFO'],
        });
      }
      // Calibration sur l'ESTIMÉ du gate needsCondense (cf. condense-status-cas) :
      // le dernier append doit franchir le seuil preemptive (92 % de 50 Ko).
      let estimated = 200 + Buffer.byteLength('STATUT INITIAL #3962', 'utf8');
      for (let i = 0; i < 40; i++) {
        estimated += 110 + Buffer.byteLength(`Message ${i}: ${filler}`, 'utf8');
      }
      const PREEMPTIVE_THRESHOLD = Math.floor(50 * 1024 * 0.92);
      const fill = Math.max(400, PREEMPTIVE_THRESHOLD - estimated + 150);
      const final = await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        content: `Final: ${'y'.repeat(fill)}`,
        tags: ['INFO'],
      });
      expect(final.success).toBe(true);

      const status = await readStatusSection(key);
      // The LLM summary applied…
      expect(status).toContain('STATUT RESUME PAR LLM (#3962)');
      // …and the machine-counted census line landed, with the RIGHT count.
      expect(status).toContain(`${FALLBACK_CENSUS_MARKER_PREFIX} 2 archives`);
      expect(status).toContain('machine-counted');
    });
  });
});
