/**
 * #3544 — the harmonization service against the PG store.
 *
 * ai-01's decision (issue comment 6710974383): **PG is the AUTHORITY, G: is
 * the fallback mirror.** This file pins the four consequences the service
 * must honour:
 *
 *   1. READ — a campaign that exists in PG is returned even when NO file is
 *      reachable (the new-tree seat: this is the acceptance shape of the
 *      issue, "status returns 8/8 from a seat that cannot see the tree").
 *   2. FALLBACK — a PG miss still serves the file, unchanged.
 *   3. PROOF — a confirmation re-read live reaches PG with the SAME eventId
 *      as the file journal, and PG confirmations of OTHER machines are
 *      visible in `status` (the fleet reads one journal, not one seat's files).
 *   4. CONCURRENCY — the `rev` CAS compares against PG when it is the store,
 *      so a stale file copy cannot silently overwrite a fresher campaign.
 *   5. MIRROR — a G: write that throws AFTER PG accepted the mutation stays a
 *      success (PG holds it; the caller's retry would meet an unknown `rev`).
 *      Without PG primary, the same throw is still an error.
 *
 * The store module is mocked (no Postgres): this file tests the WIRING, the
 * store's own SQL and gating are covered by
 * unified-store/__tests__/roosync-harmonization-store.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `vi.hoisted` — the factory below runs BEFORE this module's `const`s exist,
// so the spies must be created in the hoisted scope or the factory throws
// "Cannot access '…' before initialization".
const store = vi.hoisted(() => ({
  readCampaignFromPg: vi.fn(),
  listCampaignsFromPg: vi.fn(),
  readConfirmationsFromPg: vi.fn(),
  writeCampaignToPg: vi.fn(),
  writeConfirmationToPg: vi.fn(),
  isHarmonizationPgPrimary: vi.fn(),
}));

// #3544 review ms#1691 — a mirror write that throws. The flag turns the
// module-level `fs.writeFile` into a rejection for the mirror tmp files only
// (`.tmp-`): every other write in the service goes through a FileHandle
// (`handle.writeFile`), so the hole is surgical.
const mirror = vi.hoisted(() => ({ fails: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const writeFile = async (path: unknown, data: unknown, enc: unknown) => {
    if (mirror.fails && typeof path === 'string' && path.includes('.tmp-')) {
      throw Object.assign(new Error('EPERM: G: mirror unreachable'), { code: 'EPERM' });
    }
    return actual.promises.writeFile(path as never, data as never, enc as never);
  };
  return { ...actual, default: actual, promises: { ...actual.promises, writeFile } };
});

vi.mock('../unified-store/roosync-harmonization-store.js', () => ({
  readCampaignFromPg: store.readCampaignFromPg,
  listCampaignsFromPg: store.listCampaignsFromPg,
  readConfirmationsFromPg: store.readConfirmationsFromPg,
  writeCampaignToPg: store.writeCampaignToPg,
  writeConfirmationToPg: store.writeConfirmationToPg,
  isHarmonizationPgPrimary: store.isHarmonizationPgPrimary,
  getHarmonizationPgReader: vi.fn(() => null),
  backfillCampaignToStore: vi.fn(),
  backfillConfirmationToStore: vi.fn(),
  mapCampaignToRow: vi.fn(),
  mapRowToCampaign: vi.fn(),
  mapConfirmationToRow: vi.fn(),
}));

import {
  HarmonizationCampaignService,
  type CampaignServiceDeps,
  type HarmonizationCampaignRecord,
  type SendMessageFn,
} from '../HarmonizationCampaignService.js';

const CAMPAIGN_ID = 'hc-claude-settings-2026.09.08-1';

let fakeShared: string;
let fakeSettings: string;
let machineId: string;
let sent: string[];

const sendMessage: SendMessageFn = async (_from, to) => {
  sent.push(to);
  return { id: `msg-${sent.length}` };
};

function makeService(over: Partial<CampaignServiceDeps> = {}): HarmonizationCampaignService {
  return new HarmonizationCampaignService({
    sharedStatePath: fakeShared,
    machineId,
    settingsPath: fakeSettings,
    fromFullId: `${machineId}:roo-extensions`,
    sendMessage,
    now: () => new Date('2026-09-08T12:00:00Z'),
    ...over,
  });
}

function writeLocalSettings(content: unknown): void {
  mkdirSync(join(fakeSettings, '..'), { recursive: true });
  writeFileSync(fakeSettings, JSON.stringify(content, null, 2), 'utf-8');
}

/** A campaign the organ created and can confirm against (values match). */
async function createMatchingCampaign(service: HarmonizationCampaignService): Promise<HarmonizationCampaignRecord> {
  writeLocalSettings({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 230000 } });
  return service.createCampaign({
    targetFile: 'claude-settings',
    canon: {
      version: '2026.09.08-1',
      mode: 'enforce-value',
      keys: { 'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS': 230000 },
    },
    fleet: ['myia-po-2023:roo-extensions', 'myia-po-2024'],
  });
}

function fileEvents(machine: string): string[] {
  const dir = join(fakeShared, 'harmonization', 'campaigns', CAMPAIGN_ID, 'events', machine);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

beforeEach(() => {
  fakeShared = mkdtempSync(join(tmpdir(), 'harm-pg-shared-'));
  const home = mkdtempSync(join(tmpdir(), 'harm-pg-home-'));
  fakeSettings = join(home, 'settings.json');
  machineId = 'myia-ai-01';
  sent = [];
  store.readCampaignFromPg.mockReset().mockResolvedValue(null);
  store.listCampaignsFromPg.mockReset().mockResolvedValue(null);
  store.readConfirmationsFromPg.mockReset().mockResolvedValue(null);
  store.writeCampaignToPg.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
  store.writeConfirmationToPg.mockReset().mockResolvedValue({ ok: true, reason: 'written' });
  store.isHarmonizationPgPrimary.mockReset().mockReturnValue(false);
  mirror.fails = false;
});

afterEach(() => {
  rmSync(fakeShared, { recursive: true, force: true });
});

describe('READ — PG is the authority', () => {
  test('a campaign that exists only in PG is served (no file reachable at all)', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);

    // Simulate the new-tree seat: the file is gone, PG holds the campaign.
    rmSync(join(fakeShared, 'harmonization', 'campaigns', `${record.id}.json`), { force: true });
    store.readCampaignFromPg.mockResolvedValue({ ...record, rev: 4 });

    const loaded = await service.getCampaign(record.id);
    expect(loaded.id).toBe(record.id);
    expect(loaded.rev).toBe(4);
    expect(store.readCampaignFromPg).toHaveBeenCalledWith(record.id);
  });

  test('a PG miss still falls back to the file — and only then to CAMPAIGN_NOT_FOUND', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    store.readCampaignFromPg.mockResolvedValue(null);

    await expect(service.getCampaign(record.id)).resolves.toMatchObject({ id: record.id });
    await expect(service.getCampaign('hc-claude-settings-2099.1.1-1')).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_FOUND',
    });
  });

  test('listCampaigns reads PG when it answers, files otherwise', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);

    store.listCampaignsFromPg.mockResolvedValue([record]);
    expect((await service.listCampaigns(true)).map((r) => r.id)).toEqual([record.id]);

    store.listCampaignsFromPg.mockResolvedValue(null); // gate off / PG failed
    expect((await service.listCampaigns(true)).map((r) => r.id)).toEqual([record.id]);
  });
});

describe('PROOF — confirmations are fleet knowledge', () => {
  test('a live confirmation reaches PG with the same eventId as the file journal', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);

    const result = await service.confirm(record.id);
    expect(result.status).toBe('confirmed');

    const local = fileEvents(machineId);
    expect(local).toHaveLength(1);
    const eventId = local[0].replace(/\.json$/, '');

    expect(store.writeConfirmationToPg).toHaveBeenCalledTimes(1);
    const [campaignId, observation] = store.writeConfirmationToPg.mock.calls[0];
    expect(campaignId).toBe(record.id);
    expect(observation).toMatchObject({
      kind: 'confirm',
      machine: machineId,
      canonHash: record.canon.hash,
      source: 'live-read',
      eventId,
    });
  });

  test('a PG failure on the confirmation does not turn a real re-read into a failure', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    store.writeConfirmationToPg.mockResolvedValue({ ok: false, reason: 'exhausted' });

    await expect(service.confirm(record.id)).resolves.toMatchObject({ status: 'confirmed' });
    expect(fileEvents(machineId)).toHaveLength(1); // the local journal still holds it
  });

  test('a mismatch is NOT pushed to PG — failures stay local', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    writeLocalSettings({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 1 } });

    await expect(service.confirm(record.id)).resolves.toMatchObject({ status: 'mismatch' });
    expect(store.writeConfirmationToPg).not.toHaveBeenCalled();
  });

  test('status shows a remote machine as confirmed from PG alone (8/8 from a seat that cannot see its files)', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    expect(fileEvents('myia-po-2023')).toHaveLength(0);

    store.readConfirmationsFromPg.mockImplementation(async (_id: string, machine?: string) =>
      machine === 'myia-po-2023'
        ? [
            {
              kind: 'confirm' as const,
              machine: 'myia-po-2023',
              at: '2026-09-08T09:15:00.000Z',
              canonHash: record.canon.hash,
              observedHash: record.canon.hash,
              source: 'live-read' as const,
              eventId: 'evt-po2023-1',
            },
          ]
        : []
    );

    const status = await service.status(record.id);
    const remote = status.machines.find((m) => m.recipient === 'myia-po-2023:roo-extensions');
    expect(remote?.confirmationState).toBe('confirmed');
    expect(remote?.confirmedAt).toBe('2026-09-08T09:15:00.000Z');
    expect(store.readConfirmationsFromPg).toHaveBeenCalledWith(record.id, 'myia-po-2023');
  });

  test('a stale-canon confirmation from PG is not counted as confirmed', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    store.readConfirmationsFromPg.mockImplementation(async (_id: string, machine?: string) =>
      machine === 'myia-po-2023'
        ? [
            {
              kind: 'confirm' as const,
              machine: 'myia-po-2023',
              at: '2026-09-08T09:15:00.000Z',
              canonHash: 'sha256:other-canon',
              observedHash: 'sha256:other-canon',
              source: 'live-read' as const,
              eventId: 'evt-po2023-0',
            },
          ]
        : []
    );

    const status = await service.status(record.id);
    const remote = status.machines.find((m) => m.recipient === 'myia-po-2023:roo-extensions');
    expect(remote?.confirmationState).toBe('stale-canon');
  });
});

describe('WRITE — the organ mirrors to PG, the CAS follows the authority', () => {
  test('create writes the campaign through to PG at rev 0', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    expect(store.writeCampaignToPg).toHaveBeenCalledTimes(1);
    const [written, opts] = store.writeCampaignToPg.mock.calls[0];
    expect(written).toMatchObject({ id: record.id, rev: 0, status: 'active' });
    expect(opts).toBeUndefined(); // a live create, never the backfill INSERT-only path
  });

  test('a refused PG write does not lose the campaign (the file mirror keeps it)', async () => {
    store.writeCampaignToPg.mockResolvedValue({ ok: false, reason: 'exhausted', detail: 'pool down' });
    const service = makeService();
    const record = await createMatchingCampaign(service);
    await expect(service.getCampaign(record.id)).resolves.toMatchObject({ id: record.id });
  });

  test('a coordinator mutation advances the rev written to PG', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    store.writeCampaignToPg.mockClear();

    const result = await service.dispatch(record.id);
    expect(result.failures).toHaveLength(0);
    expect(result.sent.map((s) => s.to)).toEqual(['myia-po-2023:roo-extensions', 'myia-po-2024']);
    const written = store.writeCampaignToPg.mock.calls.at(-1)?.[0] as HarmonizationCampaignRecord;
    expect(written.rev).toBe(1);
  });

  test('a CAS that no longer matches PG is refused — the authority decides', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    // The load sees rev 0, then PG advances to rev 3 before the save: exactly
    // the race the rev check exists for. The CAS reads PG, so it catches it.
    store.readCampaignFromPg
      .mockResolvedValueOnce(record)
      .mockResolvedValue({ ...record, rev: 3 });

    await expect(service.dispatch(record.id)).rejects.toMatchObject({ code: 'CONCURRENT_WRITE' });
  });

  test('MIRROR — PG primary: a G: mirror write that throws stays a success (PG holds the mutation)', async () => {
    store.isHarmonizationPgPrimary.mockReturnValue(true);
    const service = makeService();
    const record = await createMatchingCampaign(service);
    store.writeCampaignToPg.mockClear();
    mirror.fails = true; // every `.tmp-` write now throws, starting with save()

    // PG accepted the rev-1 write; the G: file never lands. Throwing here
    // would report a mutation the fleet already reads as committed, and the
    // caller's retry would meet a `rev` it no longer recognises — the same
    // reason the divergent re-read is a warn, not an error.
    const result = await service.dispatch(record.id);
    expect(result.failures).toHaveLength(0);
    const written = store.writeCampaignToPg.mock.calls.at(-1)?.[0] as HarmonizationCampaignRecord;
    expect(written.rev).toBe(1);
  });

  test('MIRROR — non-primary: the same throw stays an error (the file IS the store)', async () => {
    const service = makeService();
    const record = await createMatchingCampaign(service);
    mirror.fails = true;

    // Raw error, unchanged behaviour: without PG the file is the only store,
    // a failed write is a failed mutation.
    await expect(service.dispatch(record.id)).rejects.toMatchObject({ code: 'EPERM' });
  });

  test('MIRROR — PG primary but the PG write FAILED: the mirror throw must reject (mutation in no store)', async () => {
    store.isHarmonizationPgPrimary.mockReturnValue(true);
    const service = makeService();
    const record = await createMatchingCampaign(service);
    // `writeCampaignToPg` never throws — it returns { ok:false }. Combined
    // with a G: mirror throw, warn-and-return would report success for a
    // mutation held by NEITHER store (review ms#1693).
    store.writeCampaignToPg.mockResolvedValue({ ok: false, reason: 'exhausted' });
    mirror.fails = true;

    await expect(service.dispatch(record.id)).rejects.toMatchObject({ code: 'EPERM' });
  });
});
