/**
 * #4434 — budget de sortie PAR SECTION dans le prompt status de production.
 *
 * Mesure fondatrice (po-2025, rejeu N=10 du 02/11) : 4/10 appels status coupés
 * à max_tokens=7200 (finish_reason=length) ; la section perdue est TOUJOURS
 * « Patterns appris », dernière du canevas — la queue est structurellement la
 * première victime d'une sortie non bornée. En production le primaire ne dispose
 * que de ~90 s (deadline 165 s − réserve cloud 75 s) : à ~28 tok/s mesurés, il
 * faut une sortie ≲ 2 500 tokens pour tenir. Le levier retenu (dispatch
 * ai01-queue-20261102c item 1) est le budget par section DANS le prompt — pas
 * un relèvement du plafond max_tokens.
 *
 * Ces tests épinglent la consigne de production ELLE-MÊME, capturée via le
 * harnais de dashboard-status-regen.test.ts (mock OpenAI, prompt réel de
 * generateStatusUpdate). Chaque assertion échoue sur le code d'avant #4434
 * (bloc budget absent, consigne « un peu plus volumineux » présente) : la
 * discrimination contre le défaut réel est par construction — pas besoin de
 * mutant synthétique pour le prouver, l'ancien main EST le mutant.
 *
 * Critères du dispatch : budget respecté (block + totaux + 8 lignes),
 * ordre des sections (canevas === budget === canonique), aucune section
 * perdue (mandat 8-sections-toujours-complètes), queue protégée
 * (« Patterns appris » jamais sacrifiée), plafond NON relevé
 * (max_tokens reste CONDENSE_LLM_MAX_TOKENS = 7200).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
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

import { roosyncDashboard } from '../dashboard.js';

const STATUS_PROMPT_MARKER = 'synthèse de dashboards';

vi.setConfig({ testTimeout: 30_000 });

const testTmpBase = path.join(os.tmpdir(), 'dashboard-status-budget-test-');

/** Ordre canonique des 8 sections — canevas STRUCTURE et liste budget
 *  doivent le respecter TOUT DEUX (budget dans le même ordre que le canevas,
 *  sinon le modèle reçoit deux ordres contradictoires). */
const CANON = [
    'Résumé',
    'État des systèmes',
    'Décisions actées',
    'Blocages structurels',
    'Livrables récents',
    'En cours',
    'Métriques de référence',
    'Patterns appris',
];

/** Capture le prompt système RÉEL de generateStatusUpdate + les params de
 *  l'appel, en forçant la régénération (mode always) au passage de seuil. */
async function captureStatusCall(): Promise<{ system: string; params: Record<string, unknown> }> {
    const filler = 'B'.repeat(1100);
    for (let i = 0; i < 6; i++) {
        const r = await roosyncDashboard({
            action: 'append', type: 'workspace',
            content: `SEED-${i} ${filler}`,
            createIfNotExists: true,
        });
        expect(r.success).toBe(true);
    }
    const file = path.join(process.env.ROOSYNC_SHARED_PATH!, 'dashboards', 'workspace-test-workspace.md');
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace('SEED-5', `SEED-5 ${'P'.repeat(42 * 1024)}`), 'utf8');

    const r = await roosyncDashboard({
        action: 'append', type: 'workspace',
        content: 'post declencheur stateless', createIfNotExists: true,
    });
    expect(r.success).toBe(true);

    for (const call of llm.create.mock.calls) {
        const params = call[0] as { messages: Array<{ role: string; content: string }> };
        const sys = params.messages[0]?.content ?? '';
        if (sys.includes(STATUS_PROMPT_MARKER)) {
            return { system: sys, params: params as unknown as Record<string, unknown> };
        }
    }
    throw new Error('generateStatusUpdate n\'a pas été appelé (mode always attendu)');
}

describe('generateStatusUpdate — budget par section (#4434)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(testTmpBase);
        process.env.ROOSYNC_SHARED_PATH = tmpDir;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
        process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
        process.env.DASHBOARD_CONDENSE_STATUS_MODE = 'always';
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

    it('bloc BUDGET PAR SECTION présent, avec total et une ligne par section (8/8)', async () => {
        const { system } = await captureStatusCall();
        expect(system).toContain('BUDGET PAR SECTION (#4434)');
        expect(system).toContain('LIMITE STRICTE');
        expect(system).toContain('~600 mots');
        for (const name of CANON) {
            // Chaque section canonique porte SA ligne de budget « - <nom> : ≤ N mots »
            const line = system.split('\n').find(l => l.trim().startsWith('-') && l.includes(name) && l.includes('mots'));
            expect(line, `ligne de budget pour « ${name} »`).toBeTruthy();
            expect(line!).toMatch(/≤\s*\d+\s*mots/);
        }
    });

    it('budget dans le MÊME ordre canonique que le canevas STRUCTURE (jamais deux ordres contradictoires)', async () => {
        const { system } = await captureStatusCall();
        const canvasIdx = CANON.map(n => system.indexOf(`### ${n}`));
        const budgetIdx = CANON.map(n => {
            const line = system.split('\n').findIndex(l => l.trim().startsWith('-') && l.includes(n) && l.includes('mots'));
            expect(line, `ligne budget « ${n} »`).toBeGreaterThanOrEqual(0);
            return line;
        });
        // Les 8 headings du canevas existent, dans l'ordre canonique strict
        for (let i = 0; i < CANON.length; i++) {
            expect(canvasIdx[i], `canevas « ### ${CANON[i]} »`).toBeGreaterThanOrEqual(0);
            if (i > 0) expect(canvasIdx[i]).toBeGreaterThan(canvasIdx[i - 1]);
        }
        // Les lignes budget suivent le même ordre strict
        for (let i = 1; i < CANON.length; i++) {
            expect(budgetIdx[i]).toBeGreaterThan(budgetIdx[i - 1]);
        }
    });

    it('l\'ancienne consigne non bornée (« un peu plus volumineux ») est retirée, remplacée par le renvoi au budget', async () => {
        const { system } = await captureStatusCall();
        // Avant #4434 cette ligne disait « la taille est gérée ailleurs — préfère
        // un statut un peu plus volumineux » : non bornée, elle poussait la
        // sortie vers le plafond max_tokens. Elle doit être remplacée, pas
        // cumulée — les deux consignes ensemble sont contradictoires.
        expect(system).not.toContain('un peu plus volumineux');
        expect(system).toContain('bornée par le BUDGET PAR SECTION');
        expect(system).toContain('condense À L\'INTÉRIEUR d\'une section');
    });

    it('mandat « aucune section perdue » : les 8 sections TOUJOURS présentes, complètes, jamais coupées', async () => {
        const { system } = await captureStatusCall();
        expect(system).toContain('Les 8 sections apparaissent TOUJOURS');
        expect(system).toContain('CHACUNE COMPLÈTE');
        expect(system).toContain('jamais une section omise, jamais une section coupée en cours de rédaction');
        // Le remède au dépassement est nommé : condenser DANS la section,
        // jamais supprimer la section ni son titre.
        expect(system).toContain('jamais supprimer la section ni son titre');
    });

    it('queue protégée : « Patterns appris » et « Métriques de référence » jamais sacrifiées', async () => {
        const { system } = await captureStatusCall();
        // « Patterns appris » est la dernière du canevas : première victime
        // mesurée des coupes finish=length (2/2 pertes du rejeu N=10).
        expect(system).toContain('« Patterns appris » et « Métriques de référence » ne sont JAMAIS sacrifiées');
    });

    it('plafond NON relevé : max_tokens reste 7200 et temperature 0.3 sur l\'appel status', async () => {
        const { params } = await captureStatusCall();
        // Le levier retenu est le budget dans le prompt, PAS le plafond : un
        // max_tokens plus haut allongerait le pire cas au-delà de la passerelle
        // ~600 s (dashboard.ts, commentaire CONDENSE_LLM_MAX_TOKENS).
        expect(params.max_tokens).toBe(7200);
        expect(params.temperature).toBe(0.3);
    });
});
