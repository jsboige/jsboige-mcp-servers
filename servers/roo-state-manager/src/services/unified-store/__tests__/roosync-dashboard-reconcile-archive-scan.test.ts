/**
 * Archive-scan heal du reconcile dashboards (#3151 Phase C residual).
 *
 * Incident fondateur (po-2025, 07/10, message « adjoint » de
 * workspace-CoursIA-2) : un append atterrit dans le canon GDrive mais son
 * dual-write PG échoue en silence ; la condensation suivante retire le
 * message du canon ; la passe insert — dont la SEULE source est le fichier
 * courant — ne le voit plus jamais : trou PG permanent. Cette passe scanne
 * les archives de condensation récentes de la clé et réinsère les ids que le
 * journal COMPLET (actif ∪ archivé) ne connaît pas, puis les stampe archivés.
 *
 * Harness : mêmes doubles reader/writer que roosync-dashboard-reconcile.test.ts,
 * plus un seam fetchArchivedIds. Les archives sont de vrais fichiers dans un
 * tmpdir (mtime = maintenant → dans le lookback par défaut).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import {
  reconcileDashboardsFromGDrive,
  parseArchiveIdBearingMessages,
} from '../roosync-dashboard-reconcile.js';
import type { RooSyncDashboardRow, RooSyncDashboardMessageRow } from '../types.js';

function liveFixture(key: string, ids: string[]): string {
  const blocks = ids.map(
    (id, i) => `### [2026-10-07T22:0${i}:00Z] m1|w1\n[msg: ${id}]\ncontent ${i}\n\n---\n`
  );
  return [
    '---',
    'type: workspace',
    `key: ${key}`,
    "lastModified: '2026-10-07T22:00:00Z'",
    'lastModifiedBy:',
    '  machineId: m1',
    '  workspace: w1',
    `totalMessages: ${ids.length}`,
    '---',
    '',
    '## Status',
    '',
    'status body',
    '',
    '## Intercom',
    '',
    ...blocks,
  ].join('\n');
}

/**
 * Archive de condensation. `entries` : soit un id (bloc AVEC [msg:]), soit
 * null (bloc pré-fix SANS [msg:]). Le nom suit la forme réelle
 * `{key}-{yyyy-MM-ddTHH-mm-ss}.md` (deux-points remplacés).
 */
function archiveFixture(key: string, date: string, entries: (string | null)[]): string {
  const blocks = entries.map((id, i) =>
    id === null
      ? `### [2026-10-07T2${i}:00:00Z] myia-po-2025|Maintenance\n\ncontenu pré-fix ${i}`
      : `### [2026-10-07T2${i}:00:00Z] myia-po-2025|Maintenance\n[msg: ${id}]\n\ncontenu ${i}`
  );
  return [
    '---',
    'type: archive',
    `originalKey: ${key}`,
    `archivedAt: ${date}`,
    `messageCount: ${entries.length}`,
    'llmGenerated: true',
    'statusUpdated: true',
    '---',
    '',
    `# Archive : ${key}`,
    '',
    ...blocks.flatMap((b) => [b, '', '---', '']),
  ].join('\n');
}

describe('roosync-dashboard-reconcile archive-scan (#3151 Phase C heal)', () => {
  let dashboardsDir: string;
  let savedEnv: Record<string, string | undefined>;
  let writerCalls: {
    key: string;
    messages: RooSyncDashboardMessageRow[];
    opts?: Record<string, unknown>;
  }[];
  let archiveCalls: { key: string; ids: string[] }[];
  let pgIds: Map<string, string[]>;
  let pgCreatedAt: Map<string, string>;
  let archivedIds: Map<string, Set<string> | null>;
  let syncThrows: boolean;

  const readerDouble = {
    async getRooSyncDashboard(key: string) {
      const ids = pgIds.get(key);
      if (!ids) return null;
      return {
        dashboard: {} as RooSyncDashboardRow,
        messages: ids.map((id) => ({
          dashboard_key: key,
          message_id: id,
          created_at: pgCreatedAt.get(`${key}:${id}`) ?? '2026-09-01T00:00:00Z',
        } as RooSyncDashboardMessageRow)),
      };
    },
  };

  const writerDouble = {
    async syncRooSyncDashboard(
      row: RooSyncDashboardRow,
      messages: RooSyncDashboardMessageRow[],
      opts?: Record<string, unknown>
    ) {
      if (syncThrows) throw new Error('pg insert down');
      writerCalls.push({ key: row.key, messages, opts });
      const ids = pgIds.get(row.key) ?? [];
      ids.push(...messages.map((m) => m.message_id as string));
      pgIds.set(row.key, ids);
    },
    async archiveRooSyncDashboardMessages(key: string, messageIds: string[]) {
      archiveCalls.push({ key, ids: [...messageIds] });
      return messageIds.length;
    },
  };

  const fetchArchivedIdsDouble = async (key: string) => archivedIds.get(key) ?? null;

  const run = () =>
    reconcileDashboardsFromGDrive({
      dashboardsDir,
      reader: readerDouble,
      writer: writerDouble,
      fetchArchivedIds: fetchArchivedIdsDouble,
    });

  const writeLive = (key = 'workspace-a', ids = ['id-live']) =>
    writeFileSync(join(dashboardsDir, `${key}.md`), liveFixture(key, ids));

  const writeArchive = (
    key = 'workspace-a',
    date = '2026-10-07T23-05-18',
    entries: (string | null)[] = ['id-arch'],
    name?: string
  ) => {
    mkdirSync(join(dashboardsDir, 'archive'), { recursive: true });
    const fname = name ?? `${key}-${date}.md`;
    writeFileSync(join(dashboardsDir, 'archive', fname), archiveFixture(key, date, entries));
    return fname;
  };

  beforeEach(() => {
    dashboardsDir = join(__dirname, '../../../__test-data__/reconcile-archive-scan');
    if (existsSync(dashboardsDir)) rmSync(dashboardsDir, { recursive: true, force: true });
    mkdirSync(dashboardsDir, { recursive: true });
    savedEnv = {
      DUAL: process.env.UNIFIED_STORE_DUAL_WRITE,
      PG: process.env.UNIFIED_STORE_PG_URL,
      SCAN: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN,
      DAYS: process.env.ROOSYNC_DASHBOARD_ARCHIVE_SCAN_DAYS,
      ARCH: process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE,
    };
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://user:pass@pg.test:5432/store';
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN;
    delete process.env.ROOSYNC_DASHBOARD_ARCHIVE_SCAN_DAYS;
    delete process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE;
    writerCalls = [];
    archiveCalls = [];
    pgIds = new Map();
    pgCreatedAt = new Map();
    archivedIds = new Map();
    syncThrows = false;
  });

  afterEach(() => {
    process.env.UNIFIED_STORE_DUAL_WRITE = savedEnv.DUAL;
    process.env.UNIFIED_STORE_PG_URL = savedEnv.PG;
    for (const [k, v] of [
      ['ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN', savedEnv.SCAN],
      ['ROOSYNC_DASHBOARD_ARCHIVE_SCAN_DAYS', savedEnv.DAYS],
      ['ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE', savedEnv.ARCH],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (existsSync(dashboardsDir)) rmSync(dashboardsDir, { recursive: true, force: true });
  });

  test('id d’archive inconnu du journal complet → inséré backfill puis stampe archivé', async () => {
    writeLive();
    writeArchive();
    const result = await run();
    expect(result.status).toBe('ok');
    expect(result.archiveFilesScanned).toBe(1);
    expect(result.archiveIdsSeen).toBe(1);
    const healSync = writerCalls.find((c) =>
      c.messages.some((m) => m.message_id === 'id-arch')
    );
    expect(healSync).toBeDefined();
    expect(healSync!.opts).toEqual({ backfill: true });
    expect(healSync!.messages.map((m) => m.message_id)).toEqual(['id-arch']);
    // created_at = l'horodatage ORIGINAL du message, pas celui de la passe.
    expect(healSync!.messages[0].created_at).toBe('2026-10-07T20:00:00Z');
    expect(archiveCalls).toEqual([{ key: 'workspace-a', ids: ['id-arch'] }]);
    expect(result.archiveHealed).toBe(1);
  });

  test('id déjà ACTIF dans le journal → pas de guérison', async () => {
    writeLive();
    writeArchive();
    pgIds.set('workspace-a', ['id-live', 'id-arch']);
    // Jeune : sinon la passe d'archival EXISTANTE (hors périmètre de ce test)
    // l'archive légitimement — row vive absente du fichier courant.
    pgCreatedAt.set('workspace-a:id-arch', new Date().toISOString());
    const result = await run();
    expect(result.archiveHealed).toBe(0);
    expect(archiveCalls).toEqual([]);
    expect(writerCalls.some((c) => c.messages.some((m) => m.message_id === 'id-arch'))).toBe(
      false
    );
  });

  test('id déjà ARCHIVÉ dans le journal → pas de résurrection', async () => {
    writeLive();
    writeArchive();
    archivedIds.set('workspace-a', new Set(['id-arch']));
    const result = await run();
    expect(result.archiveHealed).toBe(0);
    expect(archiveCalls).toEqual([]);
  });

  test('archive pré-fix (sans [msg:]) → comptée idless, aucun insert', async () => {
    writeLive();
    writeArchive('workspace-a', '2026-10-07T23-05-18', [null, null]);
    const result = await run();
    expect(result.archiveIdlessSkipped).toBe(2);
    expect(result.archiveIdsSeen).toBe(0);
    expect(result.archiveHealed).toBe(0);
    expect(archiveCalls).toEqual([]);
  });

  test('nom d’archive hors forme {key}-{ISO} → non indexé, compté unmatched', async () => {
    writeLive();
    writeArchive('workspace-a', '2026-10-07T23-05-18', ['id-x'], 'workspace-a-manuel.md');
    const result = await run();
    expect(result.archiveFilesUnmatched).toBe(1);
    expect(result.archiveFilesScanned).toBe(0);
    expect(result.archiveHealed).toBe(0);
  });

  test('archive plus vieille que le lookback → non scannée', async () => {
    writeLive();
    const fname = writeArchive();
    // mtime posé à 40 j (lookback par défaut 30 j) — déterministe, pas de
    // course avec l'horloge comme un lookback 0 l'aurait été.
    const p = join(dashboardsDir, 'archive', fname);
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(p, old, old);
    const result = await run();
    expect(result.archiveFilesScanned).toBe(0);
    expect(result.archiveHealed).toBe(0);
  });

  test('kill-switch ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN=0 → passe absente', async () => {
    writeLive();
    writeArchive();
    process.env.ROOSYNC_DASHBOARD_RECONCILE_ARCHIVE_SCAN = '0';
    const result = await run();
    expect(result.archiveFilesScanned).toBe(0);
    expect(result.archiveHealed).toBe(0);
    // La passe insert du fichier vivant reste active (contrôle positif).
    expect(result.parsedKeys).toBe(1);
  });

  test('échec d’insert PG → compté en erreur, la passe ne crashe pas', async () => {
    writeLive();
    writeArchive();
    // Journal vivant déjà complet pour id-live : la passe fichier n'insère
    // rien (pas de `continue` sur son échec), seul le heal d'archive échoue.
    pgIds.set('workspace-a', ['id-live']);
    syncThrows = true;
    const result = await run();
    expect(result.status).toBe('ok');
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.failures.some((f) => f.includes('archive-scan'))).toBe(true);
    expect(result.archiveHealed).toBe(0);
  });

  test('même id dans deux archives de la clé → guéri une seule fois', async () => {
    writeLive();
    writeArchive('workspace-a', '2026-10-07T22-00-00', ['id-dup']);
    writeArchive('workspace-a', '2026-10-07T23-00-00', ['id-dup']);
    const result = await run();
    expect(result.archiveFilesScanned).toBe(2);
    expect(result.archiveIdsSeen).toBe(2);
    const heals = writerCalls.filter((c) =>
      c.messages.some((m) => m.message_id === 'id-dup')
    );
    expect(heals).toHaveLength(1);
    expect(archiveCalls).toEqual([{ key: 'workspace-a', ids: ['id-dup'] }]);
  });

  test('gap vivant + gap d’archive → les deux passes guérissent', async () => {
    writeLive('workspace-a', ['id-live']);
    writeArchive('workspace-a', '2026-10-07T23-05-18', ['id-arch']);
    const result = await run();
    expect(result.keysWithGap).toBe(1); // id-live inséré par la passe fichier
    expect(result.reconciled).toBe(1);
    expect(result.archiveHealed).toBe(1); // id-arch par la passe archive
  });

  test('parseArchiveIdBearingMessages : headers non-message ignorés, CRLF normalisé', () => {
    const content = [
      '---',
      'type: archive',
      '---',
      '',
      '# Archive : workspace-a',
      '',
      '## Statut avant condensation',
      '',
      'texte de statut quelconque',
      '',
      '### [2026-10-07T21:00:00Z] m|w\r\n[msg: id-crlf]\r\n\r\ncontenu crlf',
    ].join('\r\n');
    const parsed = parseArchiveIdBearingMessages(content);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].id).toBe('id-crlf');
    expect(parsed.messages[0].content).toBe('contenu crlf');
    expect(parsed.idless).toBe(0);
  });
});
