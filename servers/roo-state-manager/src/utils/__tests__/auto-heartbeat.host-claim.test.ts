/**
 * #4131 Phase D — one inventory refresh per HOST, per boot, per UTC day.
 *
 * Measured on ai-01, 02/11 12:10:40Z: a rebuild hot-swapped ~20 RSM processes,
 * each refreshed the inventory on its first heartbeat, one PG upsert hit
 * `timeout expired` and the failure path rewrote the GDrive mirror. These tests
 * pin the claim that keeps a deploy burst to a single refresh per host, and the
 * heartbeat → timer → claim wiring that applies it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
    claimHostDailyInventoryRefresh,
    releaseHostDailyInventoryRefresh,
    autoHeartbeat,
    initAutoHeartbeat,
} from '../auto-heartbeat.js';

const h = vi.hoisted(() => ({
    claimDir: '',
    bootAt: 0,
    collect: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    const mocked = {
        ...actual,
        tmpdir: () => h.claimDir || actual.tmpdir(),
        hostname: () => 'Test-Host',
        uptime: () => (Date.now() - h.bootAt) / 1000,
    };
    return { ...mocked, default: mocked };
});

vi.mock('../../services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(async () => ({ registerHeartbeat: vi.fn(async () => undefined) })),
}));

vi.mock('../../services/roosync/InventoryService.js', () => ({
    InventoryService: { getInstance: () => ({ getMachineInventory: h.collect }) },
}));

const realTmp = (await vi.importActual<typeof import('os')>('os')).tmpdir();
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-02T12:10:40Z');
const BOOT = 2943000;

describe('claimHostDailyInventoryRefresh (#4131)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(realTmp, 'rsm-inv-claim-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('first claim of the day wins, every later claim the same day and boot loses', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(true);
        // the deploy burst: the other processes of the host, seconds later
        for (let i = 1; i <= 19; i++) {
            expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0 + i * 1000, BOOT)).toBe(false);
        }
        // and the end of the same UTC day
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', Date.parse('2026-11-02T23:59:59Z'), BOOT)).toBe(false);
    });

    it('a reboot the same day is claimable again: the boot state is what it publishes', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0 + 8 * 3600 * 1000, BOOT + 48)).toBe(true);
        expect(readdirSync(dir)).toEqual([`rsm-inventory-refresh-myia-ai-01-20261102-b${BOOT + 48}.claim`]);
    });

    it('the next UTC day is claimable again and removes the previous claim', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0 + DAY, BOOT)).toBe(true);
        expect(readdirSync(dir)).toEqual([`rsm-inventory-refresh-myia-ai-01-20261103-b${BOOT}.claim`]);
    });

    it('the winner removes every older claim of its id (skipped days too), never another id', () => {
        writeFileSync(join(dir, `rsm-inventory-refresh-myia-ai-01-20261029-b${BOOT}.claim`), '');
        writeFileSync(join(dir, 'rsm-inventory-refresh-myia-ai-01-20261031-b-5.claim'), '');
        writeFileSync(join(dir, `rsm-inventory-refresh-myia-ai-01-x-20261031-b${BOOT}.claim`), '');
        writeFileSync(join(dir, 'unrelated.txt'), '');

        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(true);

        expect(readdirSync(dir).sort()).toEqual([
            `rsm-inventory-refresh-myia-ai-01-20261102-b${BOOT}.claim`,
            `rsm-inventory-refresh-myia-ai-01-x-20261031-b${BOOT}.claim`,
            'unrelated.txt',
        ]);
    });

    it('the day is the UTC day, not a 24 h window from the first claim', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', Date.parse('2026-11-02T23:59:00Z'), BOOT)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', Date.parse('2026-11-03T00:01:00Z'), BOOT)).toBe(true);
    });

    it('the machine id is case-insensitive (same host, two spellings = one claim)', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'MyIA-AI-01', T0, BOOT)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(false);
    });

    it('a different machine id on the same host has its own claim', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-po-2023', T0, BOOT)).toBe(true);
    });

    it('an id with path characters cannot escape the claim directory', () => {
        expect(claimHostDailyInventoryRefresh(dir, '../evil/..\\x', T0, BOOT)).toBe(true);
        expect(readdirSync(dir)).toEqual([`rsm-inventory-refresh-___evil____x-20261102-b${BOOT}.claim`]);
    });

    it('fails OPEN when the claim cannot be written (unwritable dir)', () => {
        const missing = join(dir, 'does-not-exist');
        expect(claimHostDailyInventoryRefresh(missing, 'myia-ai-01', T0, BOOT)).toBe(true);
        expect(claimHostDailyInventoryRefresh(missing, 'myia-ai-01', T0, BOOT)).toBe(true);
        expect(existsSync(missing)).toBe(false);
    });

    it('a released claim can be taken again the same day', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT)).toBe(true);
        releaseHostDailyInventoryRefresh(dir, 'myia-ai-01', T0, BOOT);
        expect(readdirSync(dir)).toEqual([]);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0 + 1000, BOOT)).toBe(true);
    });
});

describe('autoHeartbeat schedules no inventory refresh under vitest (#4131)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T0));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a heartbeat leaves no pending timer behind', async () => {
        initAutoHeartbeat();
        expect(await autoHeartbeat('test-tool')).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('heartbeat → timer → claim wiring, outside the vitest guard (#4131)', () => {
    let dir: string;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        dir = mkdtempSync(join(realTmp, 'rsm-inv-wire-'));
        h.claimDir = dir;
        h.bootAt = T0 - 3600 * 1000;
        h.collect.mockReset();
        h.collect.mockResolvedValue({});
        for (const k of ['VITEST', 'NODE_ENV']) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T0));
        vi.spyOn(Math, 'random').mockReturnValue(0); // delay = the 2 min floor
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        for (const k of ['VITEST', 'NODE_ENV']) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
        h.claimDir = '';
        rmSync(dir, { recursive: true, force: true });
    });

    /** One RSM process = one fresh module instance, first heartbeat now. */
    async function startProcesses(n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            vi.resetModules();
            const mod = await import('../auto-heartbeat.js');
            mod.initAutoHeartbeat();
            expect(await mod.autoHeartbeat('deploy-burst')).toBe(true);
        }
    }

    it('a 20-process deploy burst collects the inventory ONCE, and not before the 2 min delay', async () => {
        await startProcesses(20);

        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 - 1);
        expect(readdirSync(dir)).toEqual([]);
        expect(h.collect).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(h.collect).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(60 * 1000);

        expect(h.collect).toHaveBeenCalledTimes(1);
        expect(readdirSync(dir)).toHaveLength(1);
    });

    it('a failed refresh gives the claim back, so a later process of the host retries', async () => {
        h.collect.mockRejectedValueOnce(new Error('powershell spawn failed'));
        await startProcesses(1);
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
        expect(readdirSync(dir)).toEqual([]);

        await startProcesses(1);
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        await vi.waitFor(() => expect(h.collect).toHaveBeenCalledTimes(2));
        expect(readdirSync(dir)).toHaveLength(1);
    });
});
