/**
 * #4205 — condensation : ne régénérer le bloc status que s'il a changé (option A).
 *
 * La passe de condensation lance deux appels LLM parallèles ; generateStatusUpdate
 * réécrit en entier le bloc status (~88 % du texte produit, ~120 passes/jour flotte)
 * alors qu'il change peu d'une passe à l'autre. Option A retenue : si la tranche
 * archivée ne porte AUCUN signal d'état (tags porteurs, référence #NNN/ms#N, fusion,
 * mandat, arbitrage), l'appel status n'a PAS lieu — previousStatus conservé tel quel,
 * archive et generateLLMSummary inchangés (zéro perte de données, contrainte #4205).
 *
 * Critères d'acceptation issue #4205 :
 *  - passe sans changement d'état → pas d'appel generateStatusUpdate, statut
 *    précédent conservé, archive écrite ;
 *  - passe avec changement → statut régénéré ;
 *  - mode `always` = comportement historique (chaque passe réécrit le statut).
 *
 * Harness mirrors dashboard-secret-retention.test.ts (#3584) : store mocké à la
 * frontière du module, mock OpenAI capturant chaque prompt — la classification
 * status/summary se fait sur le prompt système (« synthèse de dashboards » =
 * generateStatusUpdate).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockDualWriteDashboardSync, mockReadDashboardFromPg, mockProbeHydration, mockListKeysFromPg, llm } = vi.hoisted(() => ({
    mockDualWriteDashboardSync: vi.fn().mockResolvedValue(undefined),
    mockReadDashboardFromPg: vi.fn().mockResolvedValue(null),
    mockProbeHydration: vi.fn().mockResolvedValue({ kind: 'empty' }),
    mockListKeysFromPg: vi.fn().mockResolvedValue(null),
    llm: {
        enabled: false,
        create: vi.fn(),
    },
}));

vi.mock('@/services/unified-store/roosync-dashboard-store', () => ({
  isDashboardPgPrimary: vi.fn().mockReturnValue(false),
  readDashboardFromPgUngated: vi.fn().mockResolvedValue(null),
  listRooSyncDashboardKeysFromPg: mockListKeysFromPg,
    readDashboardFromPg: mockReadDashboardFromPg,
  probeDashboardJournalForHydration: mockProbeHydration,
    dualWriteDashboardSync: mockDualWriteDashboardSync,
    dualWriteDashboardDelete: vi.fn().mockResolvedValue(undefined),
    getDashboardRetirement: vi.fn().mockResolvedValue(null),
    listRetiredDashboardKeys: vi.fn().mockResolvedValue(new Set<string>()),
    retireDashboardKeyChecked: vi.fn().mockResolvedValue({ ok: true, reason: 'written' }),
    acquireDashboardSharedLock: vi.fn().mockResolvedValue('unavailable'),
    releaseDashboardSharedLock: vi.fn().mockResolvedValue(undefined),
    fetchArchivedDashboardMessageIds: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/openai', () => ({
    getChatOpenAIClient: () => {
        if (!llm.enabled) throw new Error('No chat API key configured');
        return { chat: { completions: { create: llm.create } } };
    },
    resetChatOpenAIClient: vi.fn(),
    getLLMModelId: () => 'test-model',
    getFallbackChatOpenAIClient: () => null,
    getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard, shouldRegenerateStatus } from '../dashboard.js';

const STATUS_PROMPT_MARKER = 'synthèse de dashboards';

vi.setConfig({ testTimeout: 30_000 });

const testTmpBase = path.join(os.tmpdir(), 'dashboard-status-regen-test-');

/** Seeds 6 stateless filler messages, then pads the NEWEST via a single fs write
 *  to cross the ~46 KB preemptive threshold — the NEXT append triggers one
 *  condensation pass archiving FILLER-0/FILLER-1 (CONDENSE_KEEP_MIN=4). */
async function seedFillerDashboardOverThreshold(): Promise<string> {
    const filler = 'F'.repeat(1100);
    for (let i = 0; i < 6; i++) {
        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: `FILLER-${i} ${filler}`,
            createIfNotExists: true,
        });
        expect(r.success).toBe(true);
    }
    const file = path.join(process.env.ROOSYNC_SHARED_PATH!, 'dashboards', 'workspace-test-workspace.md');
    const content = await readFile(file, 'utf8');
    const pad = 'P'.repeat(42 * 1024);
    await writeFile(file, content.replace('FILLER-5', `FILLER-5 ${pad}`), 'utf8');
    return file;
}

async function readArchiveFiles(): Promise<Array<{ name: string; content: string }>> {
    const dir = path.join(process.env.ROOSYNC_SHARED_PATH!, 'dashboards', 'archive');
    const files = await readdir(dir);
    const out: Array<{ name: string; content: string }> = [];
    for (const f of files) {
        out.push({ name: f, content: await readFile(path.join(dir, f), 'utf8') });
    }
    return out;
}

function countCallsByPrompt(): { status: number; summary: number } {
    let status = 0;
    let summary = 0;
    for (const call of llm.create.mock.calls) {
        const msgs = (call[0] as { messages: Array<{ role: string; content: string }> }).messages;
        const sys = msgs[0]?.content ?? '';
        if (sys.includes(STATUS_PROMPT_MARKER)) status++;
        else summary++;
    }
    return { status, summary };
}

describe('shouldRegenerateStatus (#4205) — décision pure', () => {
    const msg = (over: Partial<Parameters<typeof shouldRegenerateStatus>[0][number]>) => ({
        id: 'm1', timestamp: '2026-10-15T10:00:00.000Z',
        author: { machineId: 'myia-po-2024', workspace: 'roo-extensions' },
        content: 'contenu bavard sans état',
        ...over,
    } as Parameters<typeof shouldRegenerateStatus>[0][number]);

    it('archive vide → régénère (garde-fou, ne doit pas arriver en pratique)', () => {
        expect(shouldRegenerateStatus([])).toEqual({ regenerate: true, reason: 'no-archived-messages' });
    });

    it('tags porteurs → régénère', () => {
        for (const tag of ['DONE', 'TASK', 'BLOCKED', 'ERROR', 'WARN', 'ASK', 'PROPOSAL', 'CLAIMED', 'FRICTION']) {
            expect(shouldRegenerateStatus([msg({ tags: [tag] })]).regenerate, `tag ${tag}`).toBe(true);
        }
    });

    it('signaux de contenu → régénère', () => {
        // Review ms#1439 items 1+3 : `mandat` (réclamé par le body, absent de
        // l'ancienne regex) et marqueurs bracket écrits DANS le contenu de
        // messages non taggés — casse quelconque (/i).
        for (const content of ['PR #4131 mergée', 'ms#1432 en review', 'décision actée', 'arbitrage user RX92', '[WAKE-CLAUDE] myia-po-2024', '[GO-ROSTER] posé', 'escalade prod', 'mandat user accepté', '[DONE] cycle clôturé', '[ASK] clé du vLLM', '[BLOCKED] GPU saturé', '[CLAIMED] #4205 lane po-2024', '[RESULT] mesure postée', '[done] en minuscules']) {
            expect(shouldRegenerateStatus([msg({ content })]).regenerate, `content « ${content} »`).toBe(true);
        }
    });

    it('bavardage INFO/REPLY/ACK sans référence → skip', () => {
        const decision = shouldRegenerateStatus([
            msg({ tags: ['INFO', 'claude-interactive'], content: 'ACQ reçu, notation comprise' }),
            msg({ tags: ['REPLY'], content: 'réponse envoyée, rien de nouveau' }),
        ]);
        expect(decision).toEqual({ regenerate: false, reason: 'no-state-signal' });
    });

    it('avis system CONDENSATION ne porte jamais d état → ignorés', () => {
        const decision = shouldRegenerateStatus([
            msg({ author: { machineId: 'system', workspace: 'system' } as never, content: 'CONDENSATION — 15 messages archivés dans archive/x.md' }),
            msg({ tags: ['INFO'], content: 'ACK' }),
        ]);
        expect(decision.regenerate).toBe(false);
    });

    it('un seul signal au milieu du bavardage suffit → régénère', () => {
        const decision = shouldRegenerateStatus([
            msg({ tags: ['INFO'], content: 'ACK' }),
            msg({ tags: ['INFO'], content: 'PR #4205 livrée ce cycle' }),
            msg({ tags: ['INFO'], content: 'ACK' }),
        ]);
        expect(decision.regenerate).toBe(true);
        expect(decision.reason).toBe('content-signal');
    });
});

describe('roosync_dashboard — condensation status regen on-change (#4205)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(testTmpBase);
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
        process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
        delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
        mockDualWriteDashboardSync.mockReset().mockResolvedValue(undefined);
        mockReadDashboardFromPg.mockReset().mockResolvedValue(null);
        mockProbeHydration.mockReset().mockResolvedValue({ kind: 'empty' });
        llm.enabled = true;
        llm.create.mockReset().mockImplementation(async (params: { messages: Array<{ role: string; content: string }> }) => {
            const sys = params.messages[0]?.content ?? '';
            if (sys.includes(STATUS_PROMPT_MARKER)) {
                return { choices: [{ message: { content: '## Status condensé (test)' } }] };
            }
            return { choices: [{ message: { content: '## Résumé des messages archivés (test)' } }] };
        });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.ROOSYNC_SHARED_PATH;
        delete process.env.ROOSYNC_MACHINE_ID;
        delete process.env.ROOSYNC_WORKSPACE_ID;
        delete process.env.DASHBOARD_CONDENSE_STATUS_MODE;
    });

    it('passe sans signal d état → PAS d appel status, statut conservé, archive écrite', async () => {
        const file = await seedFillerDashboardOverThreshold();

        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'post declencheur stateless', createIfNotExists: true,
        });
        expect(r.success).toBe(true);

        // Un seul appel LLM : le résumé. L'appel status n'a PAS eu lieu.
        const counts = countCallsByPrompt();
        expect(counts.status).toBe(0);
        expect(counts.summary).toBe(1);

        // Statut précédent conservé tel quel (marqueur de création intact,
        // aucun remplacement par le statut régénéré du mock).
        const after = await readFile(file, 'utf8');
        expect(after).toContain('# Dashboard workspace-test-workspace');
        expect(after).toContain('*Aucun contenu.*');
        expect(after).not.toContain('## Status condensé (test)');

        // Aucune perte : l'archive existe et porte les messages archivés
        // (+ le statut avant condensation), et le résumé LLM atterrit dans le
        // live comme message système CONDENSATION-SUMMARY (#858) — pas dans
        // l'archive.
        const archives = await readArchiveFiles();
        expect(archives.length).toBeGreaterThan(0);
        const allArchived = archives.map(a => a.content).join('\n');
        expect(allArchived).toContain('FILLER-0');
        expect(allArchived).toContain('## Statut avant condensation (#3962)');
        expect(after).toContain('CONDENSATION-SUMMARY');
        expect(after).toContain('## Résumé des messages archivés (test)');

        // #4205 honnêteté (review ms#1439) : une passe skippée dit « Statut
        // conservé », jamais « Statut mis à jour » — notice ET frontmatter
        // d'archive (statusUpdated: false).
        expect(after).toContain('Statut conservé (skip #4205');
        expect(after).not.toContain('Statut mis à jour');
        for (const a of archives) {
            expect(a.content).toContain('statusUpdated: false');
        }
    });

    it('passe AVEC signal d état dans la tranche archivée → statut régénéré', async () => {
        const file = await seedFillerDashboardOverThreshold();
        // Un référentiel d'état dans le PLUS ANCIEN (donc archivé) : PR #4131.
        const content = await readFile(file, 'utf8');
        await writeFile(file, content.replace('FILLER-0', 'FILLER-0 PR #4131 merge livré'), 'utf8');

        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'post declencheur stateless', createIfNotExists: true,
        });
        expect(r.success).toBe(true);

        const counts = countCallsByPrompt();
        expect(counts.status).toBe(1);
        expect(counts.summary).toBe(1);

        const after = await readFile(file, 'utf8');
        expect(after).toContain('## Status condensé (test)');
    });

    it('mode always → comportement historique : statut régénéré même sans signal', async () => {
        process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
        await seedFillerDashboardOverThreshold();

        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'post declencheur stateless', createIfNotExists: true,
        });
        expect(r.success).toBe(true);

        const counts = countCallsByPrompt();
        expect(counts.status).toBe(1);
        expect(counts.summary).toBe(1);
    });

    it('knob ALWAYS avec espace → rollback quand même (review ms#1439 item 2 : insensible à la casse après trim)', async () => {
        process.env.DASHBOARD_CONDENSE_STATUS_MODE = '  ALWAYS ';
        await seedFillerDashboardOverThreshold();

        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: 'post declencheur stateless', createIfNotExists: true,
        });
        expect(r.success).toBe(true);

        // Valeur non exacte « always » mais reconnue : le statut est régénéré.
        const counts = countCallsByPrompt();
        expect(counts.status).toBe(1);
        expect(counts.summary).toBe(1);
    });
});
