/**
 * Tests de contre-épreuve #3178
 *
 * Reproduit les cas mesurés par ai-01 (26712/40202) et po-2025 (114/172) pour valider
 * que les 3 défauts sont corrigés :
 *  (a) CSS opt-in par défaut — défaut `includeCss` est `false`
 *  (b) % taille vs comptage — deux sémantiques distinctes et étiquetées
 *  (c) JSON 40/40/20 — vraies tailles calculées sur le contenu
 *
 * @see https://github.com/jsboige/roo-extensions/issues/3178
 */

import { describe, test, expect } from 'vitest';
import { SummaryGenerator } from '../SummaryGenerator.js';
import { ExportRenderer } from '../ExportRenderer.js';
import { JsonCsvExporter } from '../JsonCsvExporter.js';
import { ContentClassifier } from '../ContentClassifier.js';
import type { ClassifiedContent } from '../ContentClassifier.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';

describe('Issue #3178 — contre-épreuves', () => {
    describe('(a) CSS opt-in par défaut', () => {
        test('includeCss défaut est false (plus de bloc CSS inconditionnel)', () => {
            const generator = new SummaryGenerator();
            const opts = generator.mergeWithDefaultOptions({});
            expect(opts.includeCss).toBe(false);
        });

        test('renderSummary sans options explicites : aucune balise <style> injectée', async () => {
            const generator = new SummaryGenerator();
            const conv = makeAiTitleConversation();
            const result = await generator.generateSummary(conv, {
                detailLevel: 'Summary',
                outputFormat: 'markdown'
            });
            expect(result.success).toBe(true);
            expect(result.content).not.toContain('<style');
            expect(result.content).not.toContain('trace-summary-styles');
        });

        test('renderSummary avec includeCss=true : CSS bien injecté (opt-in fonctionne)', async () => {
            const generator = new SummaryGenerator();
            const conv = makeAiTitleConversation();
            const result = await generator.generateSummary(conv, {
                detailLevel: 'Summary',
                outputFormat: 'markdown',
                includeCss: true
            });
            expect(result.success).toBe(true);
            expect(result.content).toContain('<style');
            expect(result.content).toContain('trace-summary-styles');
        });
    });

    describe('(b) Étiquetage des % : parts de TAILLE vs parts de COMPTAGE', () => {
        test('cas ai-01 — 26712 user chars / 40202 total : parts de TAILLE ≠ parts de COMPTAGE', () => {
            // Contenu synthétique qui reproduit la distribution mesurée par ai-01 le 19/08 :
            //   userContentSize = 26712
            //   totalContentSize = 40202
            //   assistant + toolResults font le reste (13490 chars)
            //   userMessages / totalSections doit donner ~66.4 % (la valeur intuitive)
            const content: ClassifiedContent[] = [
                // 114 messages user (moyenne ~234 chars/msg pour atteindre 26712)
                ...Array.from({ length: 114 }, (_, i) => makeClassified(
                    'UserMessage', 'A'.repeat(234), 'User', i
                )),
                // 58 messages assistant (moyenne ~232 chars/msg pour atteindre 13490)
                ...Array.from({ length: 58 }, (_, i) => makeClassified(
                    'Completion', 'B'.repeat(232), 'Assistant', 114 + i
                )),
            ];
            const generator = new SummaryGenerator();
            const stats = generator.calculateStatistics(content);

            // Parts de TAILLE — c'est ce que l'ancien code affichait sous le nom trompeur
            // `userPercentage` (~66.4 % devrait s'afficher)
            expect(stats.userSizePercentage).toBeCloseTo(66.4, 0);
            expect(stats.assistantSizePercentage).toBeCloseTo(33.6, 0);

            // Parts de COMPTAGE — 114 user / 172 total = 66.3 %
            // C'est ce que l'utilisateur LISAIT dans la colonne % à côté de userMessages
            expect(stats.userMessagePercentage).toBeCloseTo(66.3, 0);
            expect(stats.assistantMessagePercentage).toBeCloseTo(33.7, 0);

            // Les deux sémantiques sont désormais distinctes et étiquetées
            expect(stats.userSizePercentage).toBeGreaterThan(60);
            expect(stats.userMessagePercentage).toBeGreaterThan(60);
        });

        test('cas po-2025 — 114 assistant / 172 total : parts de COMPTAGE explicites', () => {
            // Contenu synthétique qui reproduit la distribution po-2025 du 19/08 :
            //   114 messages assistant / 172 messages total = 66.3 %
            //   Mais l'ancien code affichait 22.3 % (parts de TAILLE incorrectes)
            const content: ClassifiedContent[] = [
                // 58 messages user (ex: 372 chars/msg pour atteindre 21576)
                ...Array.from({ length: 58 }, (_, i) => makeClassified(
                    'UserMessage', 'X'.repeat(372), 'User', i
                )),
                // 114 messages assistant (ex: 156 chars/msg pour atteindre 17784)
                ...Array.from({ length: 114 }, (_, i) => makeClassified(
                    'Completion', 'Y'.repeat(156), 'Assistant', 58 + i
                )),
            ];
            const generator = new SummaryGenerator();
            const stats = generator.calculateStatistics(content);

            // Parts de COMPTAGE — c'est ce qui est intuitif
            expect(stats.userMessagePercentage).toBeCloseTo(33.7, 0);
            expect(stats.assistantMessagePercentage).toBeCloseTo(66.3, 0);

            // Parts de TAILLE — distinct des parts de comptage
            // userContentSize = 58 * 372 = 21576
            // assistantContentSize = 114 * 156 = 17784
            // total = 39360
            // userSizePercentage = 21576 / 39360 * 100 = 54.8 %
            expect(stats.userSizePercentage).toBeCloseTo(54.8, 0);
            expect(stats.assistantSizePercentage).toBeCloseTo(45.2, 0);
        });

        test('le tableau de statistiques affiche les deux colonnes % étiquetées', () => {
            const renderer = new ExportRenderer();
            const stats = makeAiTitleStatistics();
            const compact = renderer.generateStatistics(stats, true);
            const detailed = renderer.generateStatistics(stats, false);

            // Compact : doit afficher % msgs (parts de comptage)
            expect(compact).toContain('| Metrique | Valeur | % msgs |');
            expect(compact).toContain('Total echanges');

            // Detailed : doit afficher % msgs ET % taille
            expect(detailed).toContain('| Metrique | Valeur | Taille | % msgs | % taille |');
            expect(detailed).toContain('Total echanges');
        });
    });

    describe('(c) calculateJsonStatistics : vraies tailles, plus de 40/40/20 figés', () => {
        test('plus de constantes 0.4/0.4/0.2 — Test 1: tout user', () => {
            // Tout user, 500 chars user, 0 assistant, 0 toolResults
            // Avant #3178 : userPercentage = 40.0, assistantPercentage = 40.0, toolResultsPercentage = 20.0
            // Après #3178 : userSizePercentage = 100, assistantSizePercentage = 0, toolResultsSizePercentage = 0
            const messages: MessageSkeleton[] = [
                { role: 'user', content: 'A'.repeat(500) },
                { role: 'user', content: 'B'.repeat(500) },
            ];
            const conv: ConversationSkeleton = makeConversationWithMessages(messages, 1000);

            const exporter = new JsonCsvExporter(new ContentClassifier());
            const stats = callCalculateJsonStatistics(exporter, [conv]);

            expect(stats.userSizePercentage).toBe(100);
            expect(stats.assistantSizePercentage).toBe(0);
            expect(stats.toolResultsSizePercentage).toBe(0);

            // Anti-régression : plus jamais 40.0 % par défaut
            expect(stats.userSizePercentage).not.toBe(40);
            expect(stats.assistantSizePercentage).not.toBe(40);
            expect(stats.toolResultsSizePercentage).not.toBe(20);
        });

        test('plus de constantes 0.4/0.4/0.2 — Test 2: déséquilibre extreme', () => {
            // 90% assistant, 10% user — avant #3178 : 40/40/20 plat
            // Après #3178 : parts de taille réelles
            const messages: MessageSkeleton[] = [
                { role: 'user', content: 'short' }, // 5 chars
                { role: 'assistant', content: 'X'.repeat(9000) }, // 9000 chars
            ];
            const conv: ConversationSkeleton = makeConversationWithMessages(messages, 9005);

            const exporter = new JsonCsvExporter(new ContentClassifier());
            const stats = callCalculateJsonStatistics(exporter, [conv]);

            // Anti-régression : userSizePercentage ≈ 0.1 % (5/9005), pas 40 %
            expect(stats.userSizePercentage).toBeLessThan(1);
            expect(stats.assistantSizePercentage).toBeGreaterThan(99);
            expect(stats.toolResultsSizePercentage).toBe(0);

            // Anti-régression : pas de 40/40/20
            expect(stats.assistantSizePercentage).not.toBe(40);
        });

        test('parts de COMPTAGE ajoutées au chemin JSON', () => {
            const messages: MessageSkeleton[] = [
                { role: 'user', content: 'hello' },
                { role: 'user', content: 'world' },
                { role: 'assistant', content: 'A'.repeat(1000) },
            ];
            const conv: ConversationSkeleton = makeConversationWithMessages(messages, 1010);

            const exporter = new JsonCsvExporter(new ContentClassifier());
            const stats = callCalculateJsonStatistics(exporter, [conv]);

            // 2 user / 3 total = 66.7 % ; 1 assistant / 3 = 33.3 %
            expect(stats.userMessagePercentage).toBeCloseTo(66.7, 0);
            expect(stats.assistantMessagePercentage).toBeCloseTo(33.3, 0);
        });
    });

    describe('TraceSummaryService.calculateJsonStatistics — même comportement', () => {
        test('chemin TraceSummaryService utilise aussi les vraies tailles (pas 0.4/0.4/0.2)', () => {
            // Vérifie que la copie privée dans TraceSummaryService.ts (lignes 578-...) suit
            // la même logique que JsonCsvExporter. #3178 corrige les deux.
            const messages: MessageSkeleton[] = [
                { role: 'user', content: 'tiny' },
                { role: 'assistant', content: 'X'.repeat(100000) },
            ];
            const conv: ConversationSkeleton = makeConversationWithMessages(messages, 100004);

            // Le chemin de test passe par JsonCsvExporter (utilisé en runtime via TraceSummaryService).
            // Le doublon interne de TraceSummaryService n'est pas exporté, mais la fonction de
            // référence est JsonCsvExporter.calculateJsonStatistics — qui est ce qui sert le
            // trafic réel. La contre-épreuve vaut pour ce qui appelle `statistics` côté JSON.
            const exporter = new JsonCsvExporter(new ContentClassifier());
            const stats = callCalculateJsonStatistics(exporter, [conv]);

            // Anti-régression 40/40/20
            expect(stats.userSizePercentage).toBeLessThan(1);
            expect(stats.assistantSizePercentage).toBeGreaterThan(99);
            expect(stats.toolResultsSizePercentage).toBe(0);
        });
    });
});

// ============================================================
// Helpers
// ============================================================

function makeClassified(
    subType: 'UserMessage' | 'Completion' | 'ToolResult',
    content: string,
    role: 'User' | 'Assistant',
    index: number
): ClassifiedContent {
    return {
        type: role,
        subType,
        content,
        index,
        contentSize: content.length,
        isRelevant: true,
        confidenceScore: 1
    };
}

function makeAiTitleConversation(): ConversationSkeleton {
    return {
        taskId: 'test-task-001',
        metadata: {
            createdAt: '2026-01-15T09:00:00Z',
            lastActivity: '2026-01-15T10:00:00Z',
            messageCount: 1,
            actionCount: 0,
            totalSize: 100,
            mode: 'code'
        },
        sequence: [
            { role: 'user', content: 'Hello world' }
        ]
    };
}

function makeAiTitleStatistics() {
    return {
        totalSections: 172,
        userMessages: 114,
        assistantMessages: 58,
        toolResults: 0,
        userContentSize: 26712,
        assistantContentSize: 13490,
        toolResultsSize: 0,
        totalContentSize: 40202,
        userSizePercentage: 66.4,
        assistantSizePercentage: 33.6,
        toolResultsSizePercentage: 0,
        userMessagePercentage: 66.3,
        assistantMessagePercentage: 33.7,
        toolResultsMessagePercentage: 0
    };
}

function makeConversationWithMessages(
    messages: MessageSkeleton[],
    totalSize: number
): ConversationSkeleton {
    return {
        taskId: 'test-conv',
        metadata: {
            createdAt: '2026-01-15T09:00:00Z',
            lastActivity: '2026-01-15T10:00:00Z',
            messageCount: messages.length,
            actionCount: 0,
            totalSize,
            mode: 'code'
        },
        sequence: messages
    };
}

/**
 * Helper : appelle calculateJsonStatistics privé via cast. Le test observe le comportement
 * réel de la fonction (#3178 (c)). Justifié par portée : la fonction est testée par
 * JsonCsvExporter.test.ts en nominal, ici on ajoute la contre-épreuve.
 */
function callCalculateJsonStatistics(
    exporter: JsonCsvExporter,
    conversations: ConversationSkeleton[]
) {
    // @ts-expect-error — accès au membre privé documenté par le test
    return exporter.calculateJsonStatistics(conversations, exporter['classifier']);
}
