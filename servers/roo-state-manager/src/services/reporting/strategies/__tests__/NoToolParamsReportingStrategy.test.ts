/**
 * Tests unitaires pour NoToolParamsReportingStrategy
 *
 * Couvre :
 * - Propriétés : detailLevel, description, isTocOnlyMode (= false)
 * - formatMessageContent : UserMessage, ToolResult, Assistant
 * - formatToolResult : résultats complets avec détails
 * - formatAssistantMessage : paramètres d'outils masqués
 * - Comportement spécifique : résultats affichés, paramètres masqués
 *
 * @module services/reporting/strategies/__tests__/NoToolParamsReportingStrategy.test
 * @version 1.0.0
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { NoToolParamsReportingStrategy } from '../NoToolParamsReportingStrategy.js';
import type { ClassifiedContent, EnhancedSummaryOptions } from '../../../../types/enhanced-conversation.js';

// ─────────────────── helpers ───────────────────

const classicOptions: EnhancedSummaryOptions = {};

function makeContent(overrides: Partial<ClassifiedContent> = {}): ClassifiedContent {
  return {
    type: 'User',
    subType: 'UserMessage',
    content: 'Hello world',
    index: 0,
    contentSize: 11,
    isRelevant: true,
    confidenceScore: 1,
    ...overrides,
  };
}

// ─────────────────── setup ───────────────────

let strategy: NoToolParamsReportingStrategy;

beforeEach(() => {
  strategy = new NoToolParamsReportingStrategy();
});

// ─────────────────── tests ───────────────────

describe('NoToolParamsReportingStrategy', () => {

  // ============================================================
  // Propriétés de base
  // ============================================================

  describe('properties', () => {
    test('detailLevel = "NoToolParams"', () => {
      expect(strategy.detailLevel).toBe('NoToolParams');
    });

    test('description mentionne "paramètres masqués"', () => {
      expect(typeof strategy.description).toBe('string');
      expect(strategy.description.length).toBeGreaterThan(0);
      expect(strategy.description).toContain('paramètres');
      expect(strategy.description).toContain('masqués');
    });

    test('isTocOnlyMode() = false (pas TOC-only)', () => {
      expect(strategy.isTocOnlyMode()).toBe(false);
    });
  });

  // ============================================================
  // formatMessageContent - UserMessage
  // ============================================================

  describe('formatMessageContent - UserMessage', () => {
    test('shouldRender = true pour UserMessage', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'User input' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('contient le contenu utilisateur complet', () => {
      const content = makeContent({ subType: 'UserMessage', content: 'Full user message content' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Full user message content');
    });

    test('metadata.shouldDisplay = true', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.shouldDisplay).toBe(true);
    });

    test('cssClass est défini', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.cssClass).toBeDefined();
    });
  });

  // ============================================================
  // formatMessageContent - ToolResult (complets)
  // ============================================================

  describe('formatMessageContent - ToolResult (complets)', () => {
    test('shouldRender = true pour ToolResult', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: command output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('contient le résultat COMPLET (pas résumé)', () => {
      const longOutput = 'x'.repeat(1000);
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: `[bash] Result: ${longOutput}`
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      // Le contenu doit contenir les 1000 caractères complets
      expect(result.content).toContain(longOutput);
    });

    test('affiche le nom de l\'outil', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[my_tool] Result: some output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('my_tool');
    });

    test('utilise <details> pour le résultat', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('<details>');
      expect(result.content).toContain('</details>');
    });

    test('contient le type de résultat', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: Command executed'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content.toLowerCase()).toContain('exécution');
    });

    test('metadata.hasToolDetails = false (paramètres masqués)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: output'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.hasToolDetails).toBe(false);
    });
  });

  // ============================================================
  // formatMessageContent - Assistant (paramètres masqués)
  // ============================================================

  describe('formatMessageContent - Assistant (paramètres masqués)', () => {
    test('shouldRender = true pour Assistant', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Assistant response'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.shouldRender).toBe(true);
    });

    test('contient le contenu texte principal', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Main assistant text response'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Main assistant text response');
    });

    test('masque les paramètres d\'outils XML dans le corps (pas dans le titre)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Text <Bash><command>ls</command></Bash> after'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('[Paramètres masqués en mode NoTools]');
      // Le titre peut contenir les premiers caractères, mais le corps ne doit pas avoir les paramètres détaillés
      // Vérifier que les détails de l'outil sont masqués (pas <command>ls</command> dans une section de détails)
      expect(result.content).not.toMatch(/<summary>OUTIL[\s\S]*<command>ls<\/command>/);
    });

    test('garde les blocs <thinking> complets', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: 'Response <thinking>Full reflection content here</thinking> end'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Full reflection content here');
      expect(result.content).toContain('<details>');
    });

    test('étiquette "DETAILS TECHNIQUE" pour les réflexions', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>Reflection</thinking>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('DETAILS TECHNIQUE');
    });

    test('étiquette "OUTIL" pour les outils', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<Bash><command>ls</command></Bash>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('OUTIL - Bash');
    });
  });

  // ============================================================
  // Structure du résultat
  // ============================================================

  describe('structure du résultat', () => {
    test('anchor est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.anchor).toBeDefined();
      expect(typeof result.anchor).toBe('string');
    });

    test('messageType est défini', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.messageType).toBeDefined();
    });

    test('metadata contient messageIndex', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 5, classicOptions);
      expect(result.metadata?.messageIndex).toBe(5);
    });

    test('metadata contient contentLength', () => {
      const content = makeContent({ content: 'test content' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.metadata?.contentLength).toBeDefined();
    });

    test('processingNotes mentionne "paramètres masqués"', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('paramètres') && n.includes('masqués'))).toBe(true);
    });

    test('processingNotes mentionne "résultats complets"', () => {
      const content = makeContent();
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      const notes = result.processingNotes ?? [];
      expect(notes.some(n => n.includes('résultats') && n.includes('complets'))).toBe(true);
    });
  });

  // ============================================================
  // Détection du type de résultat (detectResultType)
  // ============================================================

  describe('détection du type de résultat', () => {
    test('détection "fichiers"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[browser] Result: <files>file1.txt</files>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('fichiers');
    });

    test('détection "écriture fichier"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[write] Result: <file_write_result>success</file_write_result>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('écriture fichier');
    });

    test('détection "exécution commande"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: Command executed successfully'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('exécution commande');
    });

    test('détection "erreur"', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: '[bash] Result: ERROR: failed'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('erreur');
    });
  });

  // ============================================================
  // Lien retour table des matières
  // ============================================================

  describe('navigation', () => {
    test('contient un lien vers la table des matières', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('table-des-matieres');
    });

    test('contient "^ Table des matières"', () => {
      const content = makeContent({ subType: 'UserMessage' });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Table des matières');
    });
  });

  // ============================================================
  // Comparaison avec autres modes
  // ============================================================

  describe('comportement spécifique NoToolParams', () => {
    test('résultats d\'outils sont affichés (contrairement à Compact)', () => {
      const longOutput = 'x'.repeat(500);
      const content = makeContent({
        type: 'Assistant',
        subType: 'ToolResult',
        content: `[bash] Result: ${longOutput}`
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      // Vérifier que le contenu complet est là (pas juste un résumé)
      expect(result.content).toContain(longOutput);
    });

    test('paramètres d\'outils sont masqués (pas dans les détails)', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<Read><path>/very/long/path/to/file.txt</path></Read>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      // Le titre peut contenir un extrait, mais les détails de l'outil doivent être masqués
      expect(result.content).toContain('Paramètres masqués');
      expect(result.content).toContain('OUTIL - Read');
    });

    test('blocs thinking sont préservés', () => {
      const content = makeContent({
        type: 'Assistant',
        subType: 'Completion',
        content: '<thinking>Important reasoning details</thinking>'
      });
      const result = strategy.formatMessageContent(content, 1, classicOptions);
      expect(result.content).toContain('Important reasoning details');
      expect(result.content).toContain('```xml');
    });
  });
});
