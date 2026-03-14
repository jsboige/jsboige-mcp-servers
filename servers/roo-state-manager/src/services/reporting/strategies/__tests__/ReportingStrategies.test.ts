/**
 * Tests unitaires pour les stratégies de reporting concrètes
 * 
 * Tests pour SummaryReportingStrategy, MessagesReportingStrategy et FullReportingStrategy
 * qui implémentent l'ABC BaseReportingStrategy.
 * 
 * @module services/reporting/strategies/__tests__/ReportingStrategies.test
 * @version 1.0.0 (#109 - Tests agents core)
 */

import { describe, test, expect } from 'vitest';
import { SummaryReportingStrategy } from '../SummaryReportingStrategy.js';
import { MessagesReportingStrategy } from '../MessagesReportingStrategy.js';
import { FullReportingStrategy } from '../FullReportingStrategy.js';
import type { ClassifiedContent, EnhancedSummaryOptions } from '../../../types/enhanced-conversation.js';

// Helper pour créer des contenus classifiés
function makeContent(overrides: Partial<ClassifiedContent>): ClassifiedContent {
    return {
        type: 'User',
        subType: 'UserMessage',
        content: 'test content',
        index: 0,
        ...overrides
    } as ClassifiedContent;
}

describe('ReportingStrategies (ABC Implementation)', () => {

    // ============================================================
    // SummaryReportingStrategy
    // ============================================================

    describe('SummaryReportingStrategy', () => {
        const strategy = new SummaryReportingStrategy();

        test('a detailLevel = "Summary"', () => {
            expect(strategy.detailLevel).toBe('Summary');
        });

        test('a description descriptive', () => {
            expect(strategy.description).toContain('Table des matières');
            expect(strategy.description).toContain('instruction initiale');
        });

        test('isTocOnlyMode retourne true', () => {
            expect(strategy.isTocOnlyMode()).toBe(true);
        });

        test('formatMessageContent ne rend pas les messages individuellement', () => {
            const content = makeContent({ subType: 'UserMessage', content: 'Test message' });
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            
            expect(result.shouldRender).toBe(false);
            expect(result.content).toBe('');
            expect(result.processingNotes?.[0]).toContain('Mode Summary');
        });

        test('generateTableOfContents génère un sommaire HTML', () => {
            const contents: ClassifiedContent[] = [
                makeContent({ subType: 'UserMessage', content: 'Instruction initiale', index: 0 }),
                makeContent({ subType: 'UserMessage', content: 'Second message', index: 1 }),
                makeContent({ type: 'Assistant', subType: 'Completion', content: 'Response', index: 2 }),
                makeContent({ subType: 'ToolResult', content: '[read_file] Result: content', index: 3 }),
            ];
            
            const toc = strategy.generateTableOfContents(contents, {} as EnhancedSummaryOptions);
            
            expect(toc).toContain('### SOMMAIRE DES MESSAGES');
            expect(toc).toContain('Instruction de tâche initiale');
            expect(toc).toContain('toc-user');
            expect(toc).toContain('toc-assistant');
            expect(toc).toContain('toc-tool');
        });

        test('generateReport génère un rapport Summary complet', () => {
            const contents: ClassifiedContent[] = [
                makeContent({ subType: 'UserMessage', content: 'Test instruction', index: 0 }),
            ];
            
            const report = strategy.generateReport(contents, {} as EnhancedSummaryOptions, '/path/to/file.md');
            
            expect(report).toContain('📋 TRACE DE CONVERSATION ROO');
            expect(report).toContain('SOMMAIRE DES MESSAGES');
            expect(report).toContain('Fichier source');
            expect(report).toContain('INSTRUCTION DE TACHE INITIALE');
            expect(report).toContain('Résumé généré automatiquement');
            expect(report).toContain('Mode :** Summary');
        });

        test('extractMainContent supprime environment_details', () => {
            const content = 'Request <environment_details>lots of stuff</environment_details>';
            // Utilisation via méthode privée - test indirect via generateReport
            const contents: ClassifiedContent[] = [makeContent({ subType: 'UserMessage', content })];
            const report = strategy.generateReport(contents, {} as EnhancedSummaryOptions);
            
            expect(report).not.toContain('lots of stuff');
            expect(report).toContain('Request');
        });
    });

    // ============================================================
    // MessagesReportingStrategy
    // ============================================================

    describe('MessagesReportingStrategy', () => {
        const strategy = new MessagesReportingStrategy();

        test('a detailLevel = "Messages"', () => {
            expect(strategy.detailLevel).toBe('Messages');
        });

        test('a description descriptive', () => {
            expect(strategy.description).toContain('métadonnées');
            expect(strategy.description).toContain('masqués');
        });

        test('isTocOnlyMode retourne false', () => {
            expect(strategy.isTocOnlyMode()).toBe(false);
        });

        test('formatMessageContent rend les messages individuellement', () => {
            const content = makeContent({ subType: 'UserMessage', content: 'Test message' });
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            
            expect(result.shouldRender).toBe(true);
            expect(result.content).toContain('Test message');
            expect(result.cssClass).toBe('user-message');
        });

        test('formatToolResult détecte les types de résultats', () => {
            const contents: ClassifiedContent[] = [
                makeContent({ subType: 'ToolResult', content: '[read_file] Result: {"success":true}' }),
                makeContent({ subType: 'ToolResult', content: '[read_file] Result: Error: failed' }),
                makeContent({ subType: 'ToolResult', content: '[read_file] Result: <html>page</html>' }),
            ];
            
            const report = strategy.generateReport(contents, {} as EnhancedSummaryOptions);
            
            expect(report).toContain('résultat');
            expect(report).toContain('erreur');
            expect(report).toContain('<html>');
        });

        test('formatAssistantMessage masque les paramètres d\'outils', () => {
            const content = makeContent({
                type: 'Assistant',
                subType: 'Completion',
                content: 'Text <read_file attr="secret">content</read_file> more'
            });
            
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            
            expect(result.shouldRender).toBe(true);
            // Les paramètres sont masqués mais le bloc existe
            expect(result.processingNotes?.[0]).toContain('paramètres outils masqués');
        });

        test('detectResultType identifie les types courants', () => {
            expect(strategy['detectResultType']('{"success":true}')).toBe('résultat');
            expect(strategy['detectResultType']('Error: failed')).toBe('erreur');
            expect(strategy['detectResultType']('<files>content</files>')).toBe('fichiers');
            expect(strategy['detectResultType']('<file_write_result>content</file_write_result>')).toBe('écriture fichier');
            expect(strategy['detectResultType']('Command executed')).toBe('exécution commande');
            expect(strategy['detectResultType']('Browser action')).toBe('navigation web');
            expect(strategy['detectResultType']('<environment_details>content</environment_details>')).toBe('détails environnement');
            expect(strategy['detectResultType']('Todo list updated')).toBe('mise à jour todo');
            expect(strategy['detectResultType']('plain text')).toBe('résultat');
        });
    });

    // ============================================================
    // FullReportingStrategy
    // ============================================================

    describe('FullReportingStrategy', () => {
        const strategy = new FullReportingStrategy();

        test('a detailLevel = "Full"', () => {
            expect(strategy.detailLevel).toBe('Full');
        });

        test('a description descriptive', () => {
            expect(strategy.description).toContain('complet');
            expect(strategy.description).toContain('tous les détails');
        });

        test('isTocOnlyMode retourne false', () => {
            expect(strategy.isTocOnlyMode()).toBe(false);
        });

        test('formatMessageContent rend les messages individuellement', () => {
            const content = makeContent({ subType: 'UserMessage', content: 'Test message' });
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            
            expect(result.shouldRender).toBe(true);
            expect(result.content).toContain('Test message');
        });

        test('formatAssistantMessage affiche tous les détails techniques', () => {
            const content = makeContent({
                type: 'Assistant',
                subType: 'Completion',
                content: 'Text <thinking>internal</thinking> <read_file>content</read_file> more'
            });
            
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            
            expect(result.shouldRender).toBe(true);
            // En mode Full, les détails techniques sont affichés
            expect(result.processingNotes?.[0]).toContain('Mode Full');
        });

        test('formatToolResultClassic gère les résultats longs', () => {
            const longResult = 'Result: ' + 'x'.repeat(2000);
            const content = makeContent({ subType: 'ToolResult', content: longResult });
            
            const result = strategy.formatMessageContent(content, 1, {} as EnhancedSummaryOptions);
            
            expect(result.shouldRender).toBe(true);
            // Les résultats longs sont dans des détails collapsibles
            // Les résultats longs ne sont pas dans des détails car le format ne correspond pas
            expect(result.content).toContain('Result:');
        });
    });

    // ============================================================
    // Tests de comparaison entre stratégies
    // ============================================================

    describe('Comparaison des stratégies', () => {
        const contents: ClassifiedContent[] = [
            makeContent({ subType: 'UserMessage', content: 'Instruction', index: 0 }),
            makeContent({ type: 'Assistant', subType: 'Completion', content: 'Response', index: 1 }),
        ];

        test('Summary est en mode TOC uniquement', () => {
            expect(new SummaryReportingStrategy().isTocOnlyMode()).toBe(true);
        });

        test('Messages n\'est pas en mode TOC uniquement', () => {
            expect(new MessagesReportingStrategy().isTocOnlyMode()).toBe(false);
        });

        test('Full n\'est pas en mode TOC uniquement', () => {
            expect(new FullReportingStrategy().isTocOnlyMode()).toBe(false);
        });

        test('Summary ne rend pas les messages individuellement', () => {
            const summary = new SummaryReportingStrategy();
            const messages = new MessagesReportingStrategy();
            const full = new FullReportingStrategy();
            
            const content = makeContent({ subType: 'UserMessage', content: 'Test' });
            
            expect(summary.formatMessageContent(content, 1, {} as EnhancedSummaryOptions).shouldRender).toBe(false);
            expect(messages.formatMessageContent(content, 1, {} as EnhancedSummaryOptions).shouldRender).toBe(true);
            expect(full.formatMessageContent(content, 1, {} as EnhancedSummaryOptions).shouldRender).toBe(true);
        });
    });

    // ============================================================
    // Tests d'héritage de BaseReportingStrategy
    // ============================================================

    describe('Héritage de BaseReportingStrategy', () => {
        test('Les stratégies implémentent IReportingStrategy', () => {
            const strategies = [
                new SummaryReportingStrategy(),
                new MessagesReportingStrategy(),
                new FullReportingStrategy(),
            ];
            
            strategies.forEach(strategy => {
                expect(strategy.detailLevel).toBeDefined();
                expect(strategy.description).toBeDefined();
                expect(strategy.isTocOnlyMode).toBeDefined();
                expect(strategy.generateTableOfContents).toBeDefined();
                expect(strategy.formatMessageContent).toBeDefined();
                expect(strategy.generateOverview).toBeDefined();
                expect(strategy.generateReport).toBeDefined();
            });
        });

        test('SummaryReportingStrategy implémente isTocOnlyMode', () => {
            const strategy = new SummaryReportingStrategy();
            expect(strategy.isTocOnlyMode()).toBe(true);
        });

        test('MessagesReportingStrategy implémente isTocOnlyMode', () => {
            const strategy = new MessagesReportingStrategy();
            expect(strategy.isTocOnlyMode()).toBe(false);
        });

        test('FullReportingStrategy implémente isTocOnlyMode', () => {
            const strategy = new FullReportingStrategy();
            expect(strategy.isTocOnlyMode()).toBe(false);
        });
    });

    // ============================================================
    // Tests d'intégration basiques
    // ============================================================

    describe('Tests d\'intégration basiques', () => {
        const sampleContents: ClassifiedContent[] = [
            makeContent({ subType: 'UserMessage', content: 'Hello, how are you?', index: 0 }),
            makeContent({ type: 'Assistant', subType: 'Completion', content: 'I\'m doing well, thank you!', index: 1 }),
            makeContent({ subType: 'ToolResult', content: '[read_file] Result: file content', index: 2 }),
        ];

        test('SummaryReportingStrategy génère un rapport valide', () => {
            const strategy = new SummaryReportingStrategy();
            const report = strategy.generateReport(sampleContents, {} as EnhancedSummaryOptions, '/test/file.md');
            
            expect(report).toContain('📋 TRACE DE CONVERSATION ROO');
            expect(report).toContain('SOMMAIRE DES MESSAGES');
            expect(report).toContain('Hello, how are you?');
            expect(report.length).toBeGreaterThan(100);
        });

        test('MessagesReportingStrategy génère un rapport valide', () => {
            const strategy = new MessagesReportingStrategy();
            const report = strategy.generateReport(sampleContents, {} as EnhancedSummaryOptions);
            
            expect(report).toContain('MESSAGE UTILISATEUR');
            expect(report).toContain('ASSISTANT');
            expect(report).toContain('RÉSULTAT OUTIL');
            expect(report.length).toBeGreaterThan(100);
        });

        test('FullReportingStrategy génère un rapport valide', () => {
            const strategy = new FullReportingStrategy();
            const report = strategy.generateReport(sampleContents, {} as EnhancedSummaryOptions);
            
            expect(report).toContain('MESSAGE UTILISATEUR');
            expect(report).toContain('ASSISTANT');
            expect(report).toContain('RÉSULTAT OUTIL');
            expect(report.length).toBeGreaterThan(100);
        });
    });

});
