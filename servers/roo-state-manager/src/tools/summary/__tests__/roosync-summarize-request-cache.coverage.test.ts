/**
 * #2191 — mémoïsation request-scoped du getter de conversation Claude.
 *
 * Mesuré (web1 c.576, spies nommés post-#1338, fixture 6,3 Mo) :
 *   - trace/cluster hit : detect×1 + analyze×1 PAR requête — re-payé à chaque
 *     requête (pas de cache), mais surtout :
 *   - SYNTHESIS hit : detect×6 + analyze×6 en UNE requête (759 ms) —
 *     `NarrativeContextBuilderService` appelle le getter injecté à 8+ endroits
 *     (l.265/838/875/1416/1637/1821/1860), chaque appel rejouant
 *     `detectStorageLocations` + un re-parse COMPLET du même fichier session.
 *
 * Fix : la closure retournée par `createConversationGetter` est créée PAR
 * REQUÊTE (`handleRooSyncSummarize`) — un Map par closure donne au cache
 * exactement la durée de vie de la requête : 6 fetches → 1 parse à l'intérieur
 * d'une requête ; entre requêtes, la sémantique de fraîcheur est INCHANGÉE
 * (chaque requête ré-analyse au moins une fois, comme aujourd'hui).
 *
 * Framework: Vitest (coverage, add-only #1936)
 *
 * @module summary/__tests__/roosync-summarize-request-cache.coverage
 * @version 1.0.0 (#2191)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (ESM) ---------------------------------------------------
const counters = vi.hoisted(() => ({ detect: 0, analyze: 0 }));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: class {
        public static async detectStorageLocations(): Promise<any[]> {
            counters.detect++;
            return [
                { path: '/fixture', type: 'local', projectName: 'c--proj-alpha', projectPath: '/fixture/c--proj-alpha' },
            ];
        }
        public static async analyzeConversation(taskId: string): Promise<any> {
            counters.analyze++;
            if (taskId.endsWith('6b175c67-1f2a-4c3d-9e4f-0a1b2c3d4e5f')) {
                return {
                    taskId,
                    sequence: [],
                    metadata: {
                        dataSource: 'claude-jsonl',
                        workspace: 'C:\\fixture\\alpha',
                        machineId: 'test-host',
                        messageCount: 10,
                        totalSize: 6600000,
                    },
                };
            }
            return null;
        }
    },
}));

// populateConversationCache (synthèse) — détecteur Roo neutralisé.
vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(async () => []),
    },
}));

// LLM coupé : l'orchestrateur échoue au premier appel LLM → fallback analysis
// cohérent — les 6 fetches du getter ont TOUS lieu AVANT ce point (construction
// du contexte narratif), c'est le chemin mesuré.
vi.mock('../../../services/synthesis/LLMService.js', () => ({
    LLMService: class {
        constructor() {
            return new Proxy(this, {
                get: (_t, prop) => {
                    if (typeof prop === 'string') {
                        return async () => {
                            throw new Error('llm-disabled-in-test');
                        };
                    }
                    return undefined;
                },
            });
        }
    },
}));

import { handleRooSyncSummarize } from '../roosync-summarize.tool.js';
import { createConversationGetter } from '../roosync-summarize.tool.js';

const UUID = '6b175c67-1f2a-4c3d-9e4f-0a1b2c3d4e5f';
const TASK_ID = `claude-c--proj-alpha--${UUID}`;
const OTHER_ID = `claude-c--proj-alpha--aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
const MISS_ID = `claude-c--proj-alpha--ffffffff-0000-0000-0000-000000000000`;

describe('#2191 — getter Claude : mémo request-scoped (1 parse par requête)', () => {
    beforeEach(() => {
        counters.detect = 0;
        counters.analyze = 0;
    });

    test('t1 — 6 fetches du même id en UNE requête → 1 analyze (mesuré: 6)', async () => {
        const getter = createConversationGetter('claude', { maxContentLength: 2000 });
        const results: (typeof TASK_ID | null)[] = [];
        for (let i = 0; i < 6; i++) {
            const sk = await getter(TASK_ID);
            results.push(sk ? (sk.taskId as typeof TASK_ID) : null);
        }
        expect(counters.analyze).toBe(1);
        expect(counters.detect).toBe(1);
        expect(results.every(r => r === TASK_ID)).toBe(true);
    });

    test('t2 — deux ids distincts dans la même requête → 2 analyzes (pas de sur-fusion)', async () => {
        const getter = createConversationGetter('claude', { maxContentLength: 2000 });
        await getter(TASK_ID);
        await getter(OTHER_ID);
        expect(counters.analyze).toBe(2);
    });

    test('t3 — miss (null) également mémoïsé : re-fetch d\'un id absent ne re-scanne pas', async () => {
        const getter = createConversationGetter('claude', { maxContentLength: 2000 });
        const r1 = await getter(MISS_ID);
        const r2 = await getter(MISS_ID);
        const r3 = await getter(MISS_ID);
        expect(r1).toBeNull();
        expect(r2).toBeNull();
        expect(r3).toBeNull();
        expect(counters.analyze).toBe(1);
    });

    test('t4 — INTÉGRATION : une requête synthesis complète paie 1 analyze (mesuré: 6)', async () => {
        const out = await handleRooSyncSummarize({
            type: 'synthesis',
            taskId: TASK_ID,
            source: 'claude',
        } as any);
        // La requête doit aboutir (fallback LLM cohérent), pas crasher.
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
        // Le contrat central : 6+ fetchs internes → 1 parse disque.
        expect(counters.analyze).toBe(1);
    }, 60_000);
});
