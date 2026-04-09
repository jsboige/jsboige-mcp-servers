/**
 * Tests pour MarkdownFormatterService
 *
 * Ce service implémente un système de formatage Markdown avancé avec :
 * - CSS personnalisé avec couleurs thématiques
 * - Formateurs pour différents types de messages
 * - Générateurs de contenu interactif
 * - Troncature intelligente
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    MarkdownFormatterService,
    type AdvancedFormattingOptions
} from '../../../src/services/MarkdownFormatterService.js';

describe('MarkdownFormatterService', () => {
  describe('initialisation', () => {
    it('devrait initialiser correctement', () => {
      expect(MarkdownFormatterService).toBeDefined();
    });
  });

  describe('generateCSS - options par défaut', () => {
    it('devrait générer CSS avec options par défaut', () => {
      const css = MarkdownFormatterService.generateCSS();

      expect(css).toContain(':root');
      expect(css).toContain('--color-primary');
      expect(css).toContain('--color-user-message');
      expect(css).toContain('--color-assistant-message');
      expect(css).toContain('.message-user');
      expect(css).toContain('.message-assistant');
    });

    it('devrait générer CSS avec options custom', () => {
      const options: AdvancedFormattingOptions = {
        enableAdvancedCSS: true,
        responsiveDesign: false,
        syntaxHighlighting: false,
        animationsEnabled: false,
        compactMode: true
      };

      const css = MarkdownFormatterService.generateCSS(options);

      expect(css).toContain('.compact-mode');
      expect(css).toContain('.no-animations');
    });

    it('devrait inclure les couleurs thématiques dans le CSS', () => {
      const css = MarkdownFormatterService.generateCSS();

      // Vérifier les couleurs de messages
      expect(css).toContain('#2563eb'); // userMessage
      expect(css).toContain('#059669'); // assistantMessage
      expect(css).toContain('#ea580c'); // toolCall
      expect(css).toContain('#7c3aed'); // toolResult
      expect(css).toContain('#6b7280'); // metadata
      expect(css).toContain('#dc2626'); // error
    });

    it('devrait inclure les couleurs de fond', () => {
      const css = MarkdownFormatterService.generateCSS();

      expect(css).toContain('#dbeafe'); // background userMessage
      expect(css).toContain('#dcfce7'); // background assistantMessage
      expect(css).toContain('#fed7aa'); // background toolCall
      expect(css).toContain('#e9d5ff'); // background toolResult
    });
  });

  describe('formatUserMessage', () => {
    it('devrait formater un message utilisateur avec timestamp', () => {
      const content = 'Hello, world!';
      const timestamp = '2024-01-01T10:00:00Z';
      const result = MarkdownFormatterService.formatUserMessage(content, timestamp);

      expect(result).toContain('<div class="message-user">');
      expect(result).toContain('<div class="message-content">Hello, world!</div>');
      expect(result).toContain('<div class="message-timestamp">2024-01-01T10:00:00Z</div>');
      expect(result).toContain('#2563eb'); // Couleur de l'utilisateur
    });

    it('devrait formater un message utilisateur sans timestamp', () => {
      const content = 'Hello, world!';
      const result = MarkdownFormatterService.formatUserMessage(content);

      expect(result).toContain('<div class="message-user">');
      expect(result).toContain('<div class="message-content">Hello, world!</div>');
      expect(result).not.toContain('message-timestamp');
    });
  });

  describe('formatAssistantMessage', () => {
    it('devrait formater un message assistant avec timestamp', () => {
      const content = 'How can I help you?';
      const timestamp = '2024-01-01T10:01:00Z';
      const result = MarkdownFormatterService.formatAssistantMessage(content, timestamp);

      expect(result).toContain('<div class="message-assistant">');
      expect(result).toContain('<div class="message-content">How can I help you?</div>');
      expect(result).toContain('<div class="message-timestamp">2024-01-01T10:01:00Z</div>');
      expect(result).toContain('#059669'); // Couleur de l'assistant
    });

    it('devrait formater un message assistant avec contenu HTML', () => {
      const content = '<strong>Bold text</strong> and <em>italic</em>';
      const result = MarkdownFormatterService.formatAssistantMessage(content);

      expect(result).toContain('<strong>Bold text</strong>');
      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('formatToolCall', () => {
    it('devrait formater un appel d\'outil simple', () => {
      const toolName = 'readFile';
      const parameters = { path: '/test.txt' };
      const timestamp = '2024-01-01T10:02:00Z';
      const result = MarkdownFormatterService.formatToolCall(toolName, parameters, timestamp);

      expect(result).toContain('<div class="message-tool-call">');
      expect(result).toContain('<div class="tool-name">readFile</div>');
      expect(result).toContain('<pre class="tool-parameters">{\n  "path": "/test.txt"\n}</pre>');
      expect(result).toContain('#ea580c'); // Couleur de l'appel d'outil
    });

    it('devrait formater un appel d\'outil avec parameters null', () => {
      const toolName = 'sendNotification';
      const parameters = null;
      const result = MarkdownFormatterService.formatToolCall(toolName, parameters);

      expect(result).toContain('<pre class="tool-parameters">null</pre>');
    });

    it('devrait formater un appel d\'outil avec parameters undefined', () => {
      const toolName = 'log';
      const parameters = undefined;
      const result = MarkdownFormatterService.formatToolCall(toolName, parameters);

      expect(result).toContain('<pre class="tool-parameters">undefined</pre>');
    });
  });

  describe('formatToolResult', () => {
    it('devrait formater un résultat d\'outil avec succès', () => {
      const toolName = 'readFile';
      const result = { content: 'File content', success: true };
      const timestamp = '2024-01-01T10:03:00Z';
      const formatted = MarkdownFormatterService.formatToolResult(toolName, result, timestamp);

      expect(formatted).toContain('<div class="message-tool-result">');
      expect(formatted).toContain('<div class="tool-name">readFile</div>');
      expect(formatted).toContain('<div class="tool-result-status">✓ Success</div>');
      expect(formatted).toContain('#7c3aed'); // Couleur du résultat d'outil
    });

    it('devrait formater un résultat d\'outil avec erreur', () => {
      const toolName = 'readFile';
      const result = { error: 'File not found', success: false };
      const formatted = MarkdownFormatterService.formatToolResult(toolName, result);

      expect(formatted).toContain('<div class="tool-result-status">✗ Error</div>');
      expect(formatted).toContain('File not found');
    });
  });

  describe('formatConversationHeader', () => {
    it('devrait générer un en-tête complet', () => {
      const metadata = {
        taskId: 'task-123',
        title: 'Test Conversation',
        createdAt: '2024-01-01T10:00:00Z',
        messageCount: 10,
        totalSize: '15KB'
      };
      const result = MarkdownFormatterService.formatConversationHeader(metadata);

      expect(result).toContain('Test Conversation');
      expect(result).toContain('task-123');
      expect(result).toContain('2024-01-01T10:00:00Z');
      expect(result).toContain('10 messages');
      expect(result).toContain('15KB');
    });

    it('devrait gérer les métadonnées partielles', () => {
      const metadata = {
        taskId: 'task-456'
      };
      const result = MarkdownFormatterService.formatConversationHeader(metadata);

      expect(result).toContain('task-456');
      expect(result).not.toContain('Title');
      expect(result).not.toContain('Message Count');
    });
  });

  describe('formatSectionSeparator', () => {
    it('devrait générer un séparateur avec titre', () => {
      const title = 'Configuration';
      const color = '#3b82f6';
      const result = MarkdownFormatterService.formatSectionSeparator(title, color);

      expect(result).toContain('<hr class="section-divider">');
      expect(result).toContain(`style="background-color: ${color}"`);
      expect(result).toContain('Configuration');
    });
  });

  describe('formatMetadataTable', () => {
    it('devrait formater un tableau de métadonnées simple', () => {
      const data = {
        key1: 'value1',
        key2: 'value2',
        key3: 123
      };
      const result = MarkdownFormatterService.formatMetadataTable(data);

      expect(result).toContain('<table class="metadata-table">');
      expect(result).toContain('<tr><th>key1</th><td>value1</td></tr>');
      expect(result).toContain('<tr><th>key2</th><td>value2</td></tr>');
      expect(result).toContain('<tr><th>key3</th><td>123</td></tr>');
    });

    it('devrait gérer les valeurs complexes', () => {
      const data = {
        nested: { value: true },
        array: [1, 2, 3],
        date: new Date('2024-01-01')
      };
      const result = MarkdownFormatterService.formatMetadataTable(data);

      expect(result).toContain('object');
      expect(result).toContain('[1, 2, 3]');
      expect(result).toContain('2024-01-01T00:00:00.000Z');
    });
  });

  describe('formatToolParametersTable', () => {
    it('devrait formater les paramètres d\'outil en tableau', () => {
      const params = {
        path: '/test.txt',
        options: {
          encoding: 'utf8',
          flag: 'r'
        }
      };
      const result = MarkdownFormatterService.formatToolParametersTable(params);

      expect(result).toContain('<table class="tool-parameters-table">');
      expect(result).toContain('<tr><th>path</th><td>/test.txt</td></tr>');
      expect(result).toContain('<tr><th>options.encoding</th><td>utf8</td></tr>');
      expect(result).toContain('<tr><th>options.flag</th><td>r</td></tr>');
    });
  });

  describe('fonctionnalités interactives', () => {
    it('devrait générer une table des matières interactive', () => {
      const messages = [
        { type: 'user', content: 'Hello' },
        { type: 'assistant', content: 'Hi there!' },
        { type: 'tool', toolName: 'test', result: { success: true } }
      ];
      const toc = MarkdownFormatterService.generateTableOfContents(messages);

      expect(toc).toContain('<div class="table-of-contents">');
      expect(toc).toContain('User Messages (1)');
      expect(toc).toContain('Assistant Messages (1)');
      expect(toc).toContain('Tool Results (1)');
    });

    it('devrait générer des ancres de navigation', () => {
      const anchors = MarkdownFormatterService.generateNavigationAnchors(0, 'user');

      expect(anchors).toContain('<a href="#message-0" class="nav-anchor">');
      expect(anchors).toContain('👤');
      expect(anchors).toContain('↑ Top');
    });

    it('devrait calculer des compteurs de messages', () => {
      const messages = [
        { type: 'user', content: 'Hello' },
        { type: 'assistant', content: 'Hi!' },
        { type: 'assistant', content: 'How are you?' },
        { type: 'tool', toolName: 'test', result: {} }
      ];
      const counters = MarkdownFormatterService.generateMessageCounters(messages);

      expect(counters.userMessages).toBe(1);
      expect(counters.assistantMessages).toBe(2);
      expect(counters.toolResults).toBe(1);
      expect(counters.total).toBe(4);
    });
  });

  describe('troncature intelligente', () => {
    it('devrait tronquer les paramètres d\'outil', () => {
      const largeParams = {
        data: 'x'.repeat(1000),
        nested: { deep: { value: 'very long string...' } }
      };
      const result = MarkdownFormatterService.truncateToolParameters(largeParams, {
        maxLength: 500
      });

      expect(result.wasTruncated).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(500);
    });

    it('devrait tronquer les résultats d\'outil', () => {
      const largeResult = { content: 'x'.repeat(2000), items: Array(100).fill('item') };
      const result = MarkdownFormatterService.truncateToolResult(largeResult, {
        maxLength: 1000
      });

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('... [truncated]');
    });

    it('devrait générer un bouton de toggle pour le contenu tronqué', () => {
      const fullContent = 'Full content with lots of data';
      const truncatedContent = 'Truncated...';
      const toggle = MarkdownFormatterService.generateTruncationToggle(
        fullContent,
        truncatedContent,
        'test-toggle'
      );

      expect(toggle).toContain('button onclick="toggleContent(\'test-toggle\')"');
      expect(toggle).toContain('Show More');
    });

    it('devrait générer un contenu expandable', () => {
      const content = 'Detailed content that should be collapsible';
      const summary = 'Summary';
      const expandable = MarkdownFormatterService.generateExpandableContent(
        content,
        summary,
        'expand-test'
      );

      expect(expandable).toContain('details');
      expect(expandable).toContain('summary');
      expect(expandable).toContain('Summary');
    });
  });

  describe('scripts et CSS interactifs', () => {
    it('devrait générer le JavaScript interactif', () => {
      const script = MarkdownFormatterService.generateInteractiveScript();

      expect(script).toContain('function toggleContent');
      expect(script).toContain('function scrollToMessage');
      expect(script).toContain('.message-content');
    });

    it('devrait générer le CSS interactif', () => {
      const css = MarkdownFormatterService.generateInteractiveCSS();

      expect(css).toContain('.message-toggle');
      expect(css).toContain(':target');
      expect(css).toContain('transition: all');
    });
  });

  describe('cas limites', () => {
    it('devrait gérer les chaînes vides', () => {
      const result = MarkdownFormatterService.formatUserMessage('');

      expect(result).toContain('<div class="message-content"></div>');
    });

    it('devrait gérer les caractères spéciaux', () => {
      const content = 'Contenu avec <script>alert("test")</script>';
      const result = MarkdownFormatterService.formatAssistantMessage(content);

      // Devrait échapper le script
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('devrait gérer les timestamps invalides', () => {
      const result = MarkdownFormatterService.formatUserMessage('test', 'invalid-date');

      expect(result).toContain('invalid-date');
    });

    it('devrait gérer les objects circulaires', () => {
      const obj: any = { value: 'test' };
      obj.circular = obj; // Référence circulaire

      // Ne pas planter, même si l'affichage sera limité
      expect(() => {
        MarkdownFormatterService.formatToolParametersTable(obj);
      }).not.toThrow();
    });

    it('devrait gérer très grands objects', () => {
      const largeObj = {};
      for (let i = 0; i < 10000; i++) {
        largeObj[`key${i}`] = `value${i}`;
      }

      // Ne pas planter
      expect(() => {
        MarkdownFormatterService.formatToolParametersTable(largeObj);
      }).not.toThrow();
    });
  });

  describe('thèmes CSS', () => {
    it('devrait supporter le mode compact', () => {
      const options: AdvancedFormattingOptions = {
        enableAdvancedCSS: true,
        responsiveDesign: true,
        syntaxHighlighting: true,
        animationsEnabled: true,
        compactMode: true
      };
      const css = MarkdownFormatterService.generateCSS(options);

      expect(css).toContain('.compact-mode');
      expect(css).toContain('.message-compact');
    });

    it('devrait supporter le mode sans animations', () => {
      const options: AdvancedFormattingOptions = {
        enableAdvancedCSS: true,
        responsiveDesign: true,
        syntaxHighlighting: false,
        animationsEnabled: false,
        compactMode: false
      };
      const css = MarkdownFormatterService.generateCSS(options);

      expect(css).toContain('.no-animations');
      expect(css).toContain('animation: none');
    });

    it('devrait supporter le mode sans syntax highlighting', () => {
      const options: AdvancedFormattingOptions = {
        enableAdvancedCSS: true,
        responsiveDesign: true,
        syntaxHighlighting: false,
        animationsEnabled: true,
        compactMode: false
      };
      const css = MarkdownFormatterService.generateCSS(options);

      expect(css).not.toContain('.syntax-highlight');
    });
  });
});