/**
 * #4293 follow-up — the fail-closed error must name the half that failed.
 *
 * The B16 guard (PG_PRIMARY forbids the GDrive fan-out) raises
 * `SharedStoreInaccessibleError`. That error used to state, in every case,
 * that the shared store was "absent du système de fichiers" and to send the
 * reader after the DriveFS mount — while the store was perfectly readable.
 *
 * Measured 30/10 on po-2027: the store was readable AND writable while the
 * inbox read failed closed with that message; po-2028 and po-2023 nearly
 * "repaired" a healthy directory because of it.
 *
 * The contract pinned here (the B16 behaviour itself is unchanged — this file
 * asserts only WHICH cause the raised error carries):
 *   1. PG down + no warm cache + store READABLE  → cause `pg-unavailable`,
 *      the message names PostgreSQL and never tells the reader to check the
 *      mount;
 *   2. PG down + no warm cache + store GONE       → cause `store-absent`,
 *      the legacy wording (accurate there) is kept;
 *   3. host G: scan lock held by a neighbour       → cause
 *      `scan-lock-contended`, never "store absent";
 *   4. control — the SAME fixture is served over G: when the seat is not
 *      PG_PRIMARY, so the rejections above are decisions, not empty fixtures.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MACHINE = 'myia-po-2027';
const WORKSPACE = 'roo-extensions';

const mocks = vi.hoisted(() => ({
    pgActive: true,
    inboxFails: false,
    inboxItems: [] as Array<Record<string, unknown>>,
    sharedPath: '',
}));

vi.mock('../../utils/logger.js', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// PG channel read surface doubled (transport only — the gates under test are
// the real ones: isChannelPgPrimary reads env, the breaker is the real module).
vi.mock('../unified-store/roosync-channel-read.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        getChannelPgReader: () => (mocks.pgActive ? { stub: true } : null),
        readChannelInboxFromPg: async () => (mocks.inboxFails ? null : mocks.inboxItems),
    };
});

import { MessageManager } from '../MessageManager.js';
import { resetChannelPgBreakerForTests } from '../unified-store/channel-pg-breaker.js';
import { acquireGdriveScanLock } from '../gdrive-scan-lock.js';
import { SharedStoreInaccessibleError } from '../../utils/shared-state-path.js';

const ENV_KEYS = [
    'ROOSYNC_MACHINE_ID',
    'ROOSYNC_WORKSPACE_ID',
    'ROOSYNC_SHARED_PATH',
    'UNIFIED_STORE_CHANNEL_READ_PG',
    'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
    'UNIFIED_STORE_DUAL_WRITE',
    'UNIFIED_STORE_PG_URL',
    'CHANNEL_PG_BREAKER_MS',
] as const;

let previousEnv: Record<string, string | undefined>;
let manager: MessageManager;

function writeInboxFile(id: string): void {
    writeFileSync(
        join(mocks.sharedPath, 'messages', 'inbox', `${id}.json`),
        JSON.stringify(
            {
                id,
                from: 'myia-ai-01:roo-extensions',
                to: MACHINE,
                subject: `cause fixture ${id}`,
                body: 'body',
                priority: 'MEDIUM',
                status: 'unread',
                timestamp: new Date().toISOString(),
                tags: [],
            },
            null,
            2
        ),
        'utf-8'
    );
}

function setPgPrimaryEnv(): void {
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_DUAL_WRITE = '1';
    process.env.UNIFIED_STORE_PG_URL = 'postgres://unit-test.invalid:5432/rsm';
}

describe('fail-closed error — the cause names the failing half (#4293 follow-up)', () => {
    beforeEach(() => {
        mocks.pgActive = true;
        mocks.inboxFails = false;
        mocks.inboxItems = [];
        mocks.sharedPath = mkdtempSync(join(tmpdir(), 'rsm-cause-'));
        for (const dir of ['inbox', 'sent', 'archive']) {
            mkdirSync(join(mocks.sharedPath, 'messages', dir), { recursive: true });
        }
        writeInboxFile('msg-20261030T001500-cause-a');

        previousEnv = {};
        for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
        process.env.ROOSYNC_MACHINE_ID = MACHINE;
        process.env.ROOSYNC_WORKSPACE_ID = WORKSPACE;
        // The seat's store, readable — the case the defect mis-described.
        process.env.ROOSYNC_SHARED_PATH = mocks.sharedPath;
        delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
        delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
        delete process.env.UNIFIED_STORE_DUAL_WRITE;
        delete process.env.UNIFIED_STORE_PG_URL;
        resetChannelPgBreakerForTests();

        manager = new MessageManager(mocks.sharedPath);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetChannelPgBreakerForTests();
        for (const key of ENV_KEYS) {
            const value = previousEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(mocks.sharedPath, { recursive: true, force: true });
    });

    test('PG down + no warm cache + store READABLE → cause pg-unavailable, the mount is not blamed', async () => {
        setPgPrimaryEnv();
        mocks.inboxFails = true;

        const error = await manager
            .readInbox(MACHINE, 'all', undefined, WORKSPACE)
            .then(() => null)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SharedStoreInaccessibleError);
        const typed = error as SharedStoreInaccessibleError;
        expect(typed.cause).toBe('pg-unavailable');
        expect(typed.message).toContain('PostgreSQL');
        expect(typed.message).not.toContain('absent du système de fichiers');
        expect(typed.message).not.toContain('vérifiez le montage du lecteur');
    });

    test('PG down + no warm cache + store GONE → cause store-absent, legacy wording kept', async () => {
        setPgPrimaryEnv();
        mocks.inboxFails = true;
        process.env.ROOSYNC_SHARED_PATH = join(mocks.sharedPath, 'not-there');

        const error = await manager
            .readInbox(MACHINE, 'all', undefined, WORKSPACE)
            .then(() => null)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SharedStoreInaccessibleError);
        const typed = error as SharedStoreInaccessibleError;
        expect(typed.cause).toBe('store-absent');
        expect(typed.message).toContain('absent du système de fichiers');
        expect(typed.message).toContain('vérifiez le montage du lecteur');
    });

    test('host G: scan lock held by a neighbour under PG_PRIMARY → cause scan-lock-contended', async () => {
        writeInboxFile('msg-20261030T001500-cause-b');
        setPgPrimaryEnv();

        const release = await acquireGdriveScanLock('inbox-pool');
        expect(release).not.toBeNull();
        let error: unknown = null;
        try {
            error = await (manager as unknown as { ensureInboxCache: () => Promise<unknown> })
                .ensureInboxCache()
                .then(() => null)
                .catch((e: unknown) => e);
        } finally {
            await release!();
        }

        expect(error).toBeInstanceOf(SharedStoreInaccessibleError);
        const typed = error as SharedStoreInaccessibleError;
        expect(typed.cause).toBe('scan-lock-contended');
        expect(typed.message).toContain('verrou de scan G:');
        expect(typed.message).not.toContain('absent du système de fichiers');
    });

    test('control — the same fixture IS served over G: when the seat is not PG_PRIMARY', async () => {
        // Without this control the rejections above would not prove that the
        // store is fine: an empty fixture would fail the same way.
        process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
        delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
        mocks.inboxFails = true;

        const items = await manager.readInbox(MACHINE, 'all', undefined, WORKSPACE);

        expect(items.map((i) => i.id)).toContain('msg-20261030T001500-cause-a');
    });
});
