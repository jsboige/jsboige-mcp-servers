/**
 * End-to-end tests for #3584 — secret redaction at the dashboard publication boundary.
 *
 * These drive the PUBLIC tool actions (append / write) and then assert on BOTH
 * sinks that `writeDashboardFile` feeds: the shared GDrive file and the PG mirror
 * (`dualWriteDashboardSync`). The unit semantics of the redactor itself live in
 * `utils/__tests__/secret-redaction.test.ts`; what is proven here is the WIRING —
 * that the choke point actually applies it, on every write path.
 *
 * Harness mirrors dashboard-pg-store.test.ts (#3151 Phase C): store mocked at the
 * module boundary, OpenAI mock so condensation degrades to the deterministic path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockDualWriteDashboardSync, mockReadDashboardFromPg } = vi.hoisted(() => ({
    mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
    mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
    readDashboardFromPg: mockReadDashboardFromPg,
    dualWriteDashboardSync: mockDualWriteDashboardSync,
    dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/openai', () => ({
    getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
    resetChatOpenAIClient: vi.fn(),
    getLLMModelId: () => 'test-model',
    getFallbackChatOpenAIClient: () => null,
    getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

/** The founding #3584 leak: a bare 64-hex API key, published with no variable name.
 *  No shape-based pattern can catch it without also catching every 40-hex git SHA. */
const LEAKED_KEY = '89ed6fb1' + 'a1b2c3d4'.repeat(7);
const GIT_SHA = 'b'.repeat(40);

const testTmpBase = path.join(os.tmpdir(), 'dashboard-redaction-test-');

describe('roosync_dashboard — secret redaction at the publication boundary (#3584)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(testTmpBase);
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
        process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
        // The secret this machine holds — the value layer can only mask what it knows.
        process.env.EMBEDDINGS_API_KEY = LEAKED_KEY;
        mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
        mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.ROOSYNC_MACHINE_ID;
        delete process.env.ROOSYNC_WORKSPACE_ID;
        delete process.env.EMBEDDINGS_API_KEY;
    });

    it('append: a bare secret in the intercom is masked in the FILE and in the PG mirror', async () => {
        const result = await roosyncDashboard({
            action: 'append',
            type: 'workspace',
            content: `[WARN] clé active : ${LEAKED_KEY} — consommateur non migré`,
            createIfNotExists: true,
        });
        expect(result.success).toBe(true);

        const file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
        expect(file).not.toContain(LEAKED_KEY);
        expect(file).toContain('<redacted:EMBEDDINGS_API_KEY>');

        // The PG mirror is written from the same object — proving the mask is applied
        // BEFORE the dual-write, not only on the markdown rendering.
        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        const content = synced.intercom.messages[0].content;
        expect(content).not.toContain(LEAKED_KEY);
        expect(content).toContain('<redacted:EMBEDDINGS_API_KEY>');
        // Surrounding prose survives — the message stays readable and useful.
        expect(content).toContain('consommateur non migré');
    });

    // Le premier append se fait sur un dossier fraîchement `mkdtemp` : le fichier
    // n'existe pas, `appendDashboardIncremental` tombe dans son fallback et traverse
    // `writeDashboardFile`. En production le dashboard existe TOUJOURS, donc c'est le
    // fast-path qui court — celui de la fuite fondatrice #3584. Ces deux cas créent
    // le fichier d'abord, pour que l'append qui porte le secret emprunte ce chemin.
    it('append fast-path (dashboard existant) : le FICHIER est masqué', async () => {
        await roosyncDashboard({ action: 'append', type: 'workspace',
            content: 'message anodin sans secret', createIfNotExists: true });
        await roosyncDashboard({ action: 'append', type: 'workspace',
            content: `[WARN] clé active : ${LEAKED_KEY} — consommateur non migré`,
            createIfNotExists: true });

        const file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
        expect(file).not.toContain(LEAKED_KEY);
        expect(file).toContain('<redacted:EMBEDDINGS_API_KEY>');
        expect(file).toContain('message anodin sans secret');
    });

    it('append fast-path (dashboard existant) : le MIROIR PG est masqué', async () => {
        await roosyncDashboard({ action: 'append', type: 'workspace',
            content: 'message anodin sans secret', createIfNotExists: true });
        await roosyncDashboard({ action: 'append', type: 'workspace',
            content: `[WARN] clé active : ${LEAKED_KEY} — consommateur non migré`,
            createIfNotExists: true });

        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        expect(JSON.stringify(synced)).not.toContain(LEAKED_KEY);
        const last = synced.intercom.messages.at(-1)!.content;
        expect(last).toContain('<redacted:EMBEDDINGS_API_KEY>');
        expect(last).toContain('consommateur non migré');
    });

    it('write: a bare secret in the status section is masked', async () => {
        await roosyncDashboard({
            action: 'write',
            type: 'workspace',
            content: `## État\n\nclé embeddings : ${LEAKED_KEY}`,
            createIfNotExists: true,
        });

        const file = await readFile(path.join(tmpDir, 'dashboards', 'workspace-test-workspace.md'), 'utf8');
        expect(file).not.toContain(LEAKED_KEY);

        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        expect(synced.status.markdown).not.toContain(LEAKED_KEY);
        expect(synced.status.markdown).toContain('<redacted:EMBEDDINGS_API_KEY>');
    });

    it('does NOT mask a git SHA — over-redaction would break the coordination channel', async () => {
        await roosyncDashboard({
            action: 'append',
            type: 'workspace',
            content: `build frais, gitlink == ${GIT_SHA} sur main`,
            createIfNotExists: true,
        });

        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        expect(synced.intercom.messages[0].content).toContain(GIT_SHA);
    });

    it('leaves an ordinary message byte-for-byte intact', async () => {
        const content = '[DONE] aucun secret ici — travail livré, PR #1234 mergée';
        await roosyncDashboard({
            action: 'append',
            type: 'workspace',
            content,
            createIfNotExists: true,
        });

        const synced = mockDualWriteDashboardSync.mock.calls.at(-1)![0];
        expect(synced.intercom.messages[0].content).toBe(content);
    });
});
