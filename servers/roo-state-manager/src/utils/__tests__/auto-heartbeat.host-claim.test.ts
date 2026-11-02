/**
 * #4131 Phase D — one inventory refresh per HOST per UTC day.
 *
 * Measured on ai-01, 02/11 12:10:40Z: a rebuild hot-swapped ~20 RSM processes,
 * each refreshed the inventory on its first heartbeat, one PG upsert hit
 * `timeout expired` and the failure path rewrote the GDrive mirror. These tests
 * pin the claim that keeps a deploy burst to a single refresh per host.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claimHostDailyInventoryRefresh, autoHeartbeat, initAutoHeartbeat } from '../auto-heartbeat.js';

vi.mock('../../services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-02T12:10:40Z');

describe('claimHostDailyInventoryRefresh (#4131)', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'rsm-inv-claim-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('first claim of the day wins, every later claim the same day loses', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0)).toBe(true);
        // the deploy burst: the other processes of the host, seconds later
        for (let i = 1; i <= 19; i++) {
            expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0 + i * 1000)).toBe(false);
        }
        // and the end of the same UTC day
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', Date.parse('2026-11-02T23:59:59Z'))).toBe(false);
    });

    it('the next UTC day is claimable again and removes the previous claim', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0 + DAY)).toBe(true);
        expect(readdirSync(dir)).toEqual(['rsm-inventory-refresh-myia-ai-01-20261103.claim']);
    });

    it('the day is the UTC day, not a 24 h window from the first claim', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', Date.parse('2026-11-02T23:59:00Z'))).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', Date.parse('2026-11-03T00:01:00Z'))).toBe(true);
    });

    it('the machine id is case-insensitive (same host, two spellings = one claim)', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'MyIA-AI-01', T0)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0)).toBe(false);
    });

    it('a different machine id on the same host has its own claim', () => {
        expect(claimHostDailyInventoryRefresh(dir, 'myia-ai-01', T0)).toBe(true);
        expect(claimHostDailyInventoryRefresh(dir, 'myia-po-2023', T0)).toBe(true);
    });

    it('an id with path characters cannot escape the claim directory', () => {
        expect(claimHostDailyInventoryRefresh(dir, '../evil/..\\x', T0)).toBe(true);
        expect(readdirSync(dir)).toEqual(['rsm-inventory-refresh-___evil____x-20261102.claim']);
    });

    it('fails OPEN when the claim cannot be written (unwritable dir)', () => {
        const missing = join(dir, 'does-not-exist');
        expect(claimHostDailyInventoryRefresh(missing, 'myia-ai-01', T0)).toBe(true);
        expect(claimHostDailyInventoryRefresh(missing, 'myia-ai-01', T0)).toBe(true);
        expect(existsSync(missing)).toBe(false);
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
        const { getRooSyncService } = await import('../../services/lazy-roosync.js');
        vi.mocked(getRooSyncService).mockResolvedValue({
            registerHeartbeat: vi.fn().mockResolvedValue(undefined),
        } as any);

        initAutoHeartbeat();
        expect(await autoHeartbeat('test-tool')).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
