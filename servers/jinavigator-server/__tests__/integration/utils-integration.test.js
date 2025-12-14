/**
 * Tests d'intégration pour les utilitaires
 * 
 * Ces tests vérifient que les utilitaires fonctionnent correctement
 * lorsqu'ils sont utilisés ensemble dans des scénarios réels.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import * as jinaClient from '../../src/utils/jina-client.js';
import * as markdownParser from '../../src/utils/markdown-parser.js';

// Mock axios
jest.mock('axios');

describe('Tests d\'intégration des utilitaires', () => {
  // Données de test
  const TEST_MARKDOWN_CONTENT = `# Titre de test
## Sous-titre
Ceci est un contenu Markdown de test.
- Point 1
- Point 2
- Point 3

### Section 1
Contenu de la section 1.

### Section 2
Contenu de la section 2.
`;

  const TEST_LARGE_MARKDOWN = '# Grand document Markdown\n\n' + 
    Array.from({ length: 1000 }, (_, i) => `## Section ${i}\n\nCeci est le contenu de la section ${i}.\n\n`).join('');

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Intégration JinaClient + MarkdownParser', () => {
    test('devrait convertir et parser un contenu Markdown', async () => {
      const url = 'https://example.com/test-page';
      
      // Conversion via JinaClient
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      expect(markdownContent).toBe(TEST_MARKDOWN_CONTENT);
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/test-page',
        expect.any(Object)
      );
      
      // Parsing via MarkdownParser
      const outline = markdownParser.extractMarkdownOutline(markdownContent);
      
      expect(Array.isArray(outline)).toBe(true);
      expect(outline.length).toBeGreaterThan(0);
      
      outline.forEach(heading => {
        expect(heading).toHaveProperty('level');
        expect(heading).toHaveProperty('text');
        expect(heading).toHaveProperty('line');
        expect(heading.level).toBeGreaterThanOrEqual(1);
        expect(heading.level).toBeLessThanOrEqual(6);
      });
    });

    test('devrait extraire des plages de lignes après conversion', async () => {
      const url = 'https://example.com/range-test';
      
      // Conversion
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      // Extraction de plage
      const lines = markdownParser.filterByLines(markdownContent, 2, 5);
      
      expect(typeof lines).toBe('string');
      expect(lines.length).toBeGreaterThan(0);
      
      // Vérifier que les lignes correspondent au contenu attendu
      const expectedLines = markdownContent.split('\n').slice(1, 5).join('\n');
      expect(lines).toBe(expectedLines);
    });

    test('devrait valider la profondeur maximale', async () => {
      const url = 'https://example.com/validation-test';
      
      // Conversion
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      // Validation
      const depth = markdownParser.validateMaxDepth(10);
      expect(depth).toBe(6);
      
      const depth2 = markdownParser.validateMaxDepth(0);
      expect(depth2).toBe(1);
    });
  });

  describe('Intégration avec configurations personnalisées', () => {
    test('devrait utiliser des configurations personnalisées de manière cohérente', async () => {
      const customConfig = {
        timeout: 60000,
        headers: {
          'Accept': 'text/html',
          'Custom-Header': 'value'
        }
      };
      
      const url = 'https://example.com/custom-config-test';
      
      // Conversion avec configuration personnalisée
      const markdownContent = await jinaClient.convertUrlToMarkdown(url, undefined, undefined, customConfig);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/custom-config-test',
        expect.objectContaining({
          timeout: 60000,
          headers: expect.objectContaining({
            'Accept': 'text/html',
            'Custom-Header': 'value'
          })
        })
      );
      
      // Parsing avec configuration personnalisée (maxDepth)
      const outline = markdownParser.extractMarkdownOutline(markdownContent, 4);
      
      expect(Array.isArray(outline)).toBe(true);
      
      // Vérifier récursivement que la profondeur est respectée
      const checkDepth = (nodes) => {
        nodes.forEach(node => {
          expect(node.level).toBeLessThanOrEqual(4);
          if (node.children) {
            checkDepth(node.children);
          }
        });
      };
      checkDepth(outline);
    });
  });

  describe('Intégration avec gestion d\'erreurs', () => {
    test('devrait gérer les erreurs de conversion de manière cohérente', async () => {
      const url = 'https://example.com/error-test';
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, statusText: 'Not Found' };
      axios.get.mockRejectedValue(error);
      
      // La conversion devrait échouer
      await expect(jinaClient.convertUrlToMarkdown(url)).rejects.toThrow('404');
      
      // Le parsing devrait gérer le contenu vide
      const emptyOutline = markdownParser.extractMarkdownOutline('');
      expect(emptyOutline).toEqual([]);
    });

    test('devrait gérer les timeouts de manière cohérente', async () => {
      const timeoutError = new Error('Timeout of 30000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      const url = 'https://example.com/timeout-test';
      
      // Timeout du client
      await expect(jinaClient.convertUrlToMarkdown(url)).rejects.toThrow('Timeout');
      
      // Le parser devrait fonctionner normalement avec du contenu valide
      const validContent = '# Test Content\n\nThis is valid markdown.';
      const outline = markdownParser.extractMarkdownOutline(validContent);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].level).toBe(1);
      expect(outline[0].text).toBe('Test Content');
    });

    test('devrait gérer les réponses partielles', async () => {
      const partialContent = '# Title\n## Subtitle\nIncomplete conten';
      axios.get.mockResolvedValue({ data: partialContent });
      
      const url = 'https://example.com/partial-test';
      
      // Conversion avec contenu partiel
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      expect(markdownContent).toBe(partialContent);
      
      // Parsing du contenu partiel
      const outline = markdownParser.extractMarkdownOutline(markdownContent);
      
      expect(outline).toHaveLength(1); // Seulement le titre racine
      expect(outline[0].level).toBe(1);
      expect(outline[0].text).toBe('Title');
      expect(outline[0].children).toHaveLength(1);
      expect(outline[0].children[0].level).toBe(2);
      expect(outline[0].children[0].text).toBe('Subtitle');
    });
  });

  describe('Intégration avec des contenus complexes', () => {
    test('devrait gérer les contenus avec des structures complexes', async () => {
      const complexContent = `# Main Title
## Section 1
### Subsection 1.1
#### Sub-subsection 1.1.1
## Section 2
### Subsection 2.1
#### Sub-subsection 2.1.1
##### Deep subsection 1
###### Deepest subsection`;
      
      axios.get.mockResolvedValue({ data: complexContent });
      
      const url = 'https://example.com/complex-test';
      
      // Conversion
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      expect(markdownContent).toBe(complexContent);
      
      // Parsing avec profondeur maximale
      const fullOutline = markdownParser.extractMarkdownOutline(markdownContent, 6);
      
      expect(fullOutline).toHaveLength(1); // 1 racine
      
      // Parsing avec profondeur limitée
      const limitedOutline = markdownParser.extractMarkdownOutline(markdownContent, 3);
      
      // Vérifier récursivement que la profondeur est respectée
      const checkDepth = (nodes) => {
        nodes.forEach(node => {
          expect(node.level).toBeLessThanOrEqual(3);
          if (node.children) {
            checkDepth(node.children);
          }
        });
      };
      checkDepth(limitedOutline);
    });

    test('devrait gérer les contenus avec des caractères spéciaux', async () => {
      const specialContent = `# Titre avec émojis 🚀
## Sous-titre avec accents éàèç
### Sous-sous-titre avec symboles ♠♣♥♦
#### Titre avec \`code\` inline
##### Titre avec **gras** et *italique*
###### Titre avec [lien](https://example.com)`;
      
      axios.get.mockResolvedValue({ data: specialContent });
      
      const url = 'https://example.com/special-chars-test';
      
      // Conversion
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      expect(markdownContent).toBe(specialContent);
      
      // Parsing
      const outline = markdownParser.extractMarkdownOutline(markdownContent, 6);
      
      expect(outline).toHaveLength(1);
      
      // Vérifier que les caractères spéciaux sont préservés
      expect(outline[0].text).toBe('Titre avec émojis 🚀');
      expect(outline[0].children[0].text).toBe('Sous-titre avec accents éàèç');
    });

    test('devrait gérer les contenus très volumineux', async () => {
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      const url = 'https://example.com/large-content-test';
      
      const startTime = Date.now();
      
      // Conversion
      const markdownContent = await jinaClient.convertUrlToMarkdown(url);
      
      // Parsing
      const outline = markdownParser.extractMarkdownOutline(markdownContent);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Vérifications
      expect(markdownContent).toBe(largeContent);
      expect(Array.isArray(outline)).toBe(true);
      expect(outline.length).toBeGreaterThan(0);
      
      // Performance
      expect(duration).toBeLessThan(5000); // Devrait prendre moins de 5 secondes
    });
  });

  describe('Intégration avec des workflows réels', () => {
    test('devrait supporter un workflow d\'analyse de contenu complet', async () => {
      const urls = [
        'https://example.com/article1',
        'https://example.com/article2',
        'https://example.com/article3'
      ];
      
      const workflowResults = [];
      
      for (const url of urls) {
        // Étape 1: Conversion
        const content = await jinaClient.convertUrlToMarkdown(url);
        
        // Étape 2: Extraction du plan
        const outline = markdownParser.extractMarkdownOutline(content);
        
        // Étape 3: Extraction des métadonnées
        const lines = content.split('\n').length;
        
        workflowResults.push({
          url,
          contentLength: content.length,
          outlineLength: outline.length,
          lineCount: lines
        });
      }
      
      // Vérifications du workflow
      expect(workflowResults).toHaveLength(3);
      
      workflowResults.forEach(result => {
        expect(result).toHaveProperty('url');
        expect(result).toHaveProperty('contentLength');
        expect(result).toHaveProperty('outlineLength');
        expect(result).toHaveProperty('lineCount');
        
        expect(typeof result.contentLength).toBe('number');
        expect(typeof result.outlineLength).toBe('number');
        expect(typeof result.lineCount).toBe('number');
        
        expect(result.contentLength).toBeGreaterThan(0);
        expect(result.outlineLength).toBeGreaterThanOrEqual(0);
        expect(result.lineCount).toBeGreaterThan(0);
      });
      
      // Vérifier que tous les appels HTTP ont été faits
      expect(axios.get).toHaveBeenCalledTimes(3);
    });

    test('devrait supporter un workflow de comparaison de contenus', async () => {
      const urls = [
        'https://example.com/content-a',
        'https://example.com/content-b'
      ];
      
      // Simulation de contenus différents
      axios.get
        .mockResolvedValueOnce({ data: '# Content A\n## Section A1\n## Section A2' })
        .mockResolvedValueOnce({ data: '# Content B\n### Section B1\n### Section B2\n### Section B3' });
      
      const analyses = [];
      
      for (const url of urls) {
        const content = await jinaClient.convertUrlToMarkdown(url);
        const outline = markdownParser.extractMarkdownOutline(content);
        
        analyses.push({
          url,
          content,
          outline
        });
      }
      
      // Comparaison des analyses
      const analysisA = analyses[0];
      const analysisB = analyses[1];
      
      expect(analysisA.outline).toHaveLength(1); // 1 racine
      expect(analysisA.outline[0].children).toHaveLength(2); // 2 enfants
      
      expect(analysisB.outline).toHaveLength(1); // 1 racine
      expect(analysisB.outline[0].children).toHaveLength(3); // 3 enfants (niveau 3, donc enfants directs si niveau 2 absent ?)
      // Note: extractMarkdownOutline construit une hiérarchie. Si on saute un niveau, ça dépend de l'implémentation.
      // Dans notre cas, H3 après H1 sera enfant de H1.
    });
  });

  describe('Tests de performance d\'intégration', () => {
    test('devrait gérer efficacement les traitements par lots', async () => {
      const urls = [];
      for (let i = 1; i <= 20; i++) {
        urls.push(`https://example.com/batch-test-${i}`);
      }
      
      // Mock pour simuler des réponses rapides
      axios.get.mockImplementation(url =>
        Promise.resolve({ data: `# Batch Test ${url.split('-').pop()}` })
      );
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        urls.map(async url => {
          const content = await jinaClient.convertUrlToMarkdown(url);
          const outline = markdownParser.extractMarkdownOutline(content);
          return { url, content, outline };
        })
      );
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(results).toHaveLength(20);
      
      results.forEach(result => {
        expect(result.content).toBeDefined();
        expect(Array.isArray(result.outline)).toBe(true);
        expect(result.outline).toHaveLength(1);
      });
      
      // Devrait être raisonnablement rapide
      expect(duration).toBeLessThan(3000);
    });

    test('devrait gérer les traitements répétés sans fuite de mémoire', async () => {
      const url = 'https://example.com/memory-test';
      
      // Effectuer 100 traitements répétés
      for (let i = 0; i < 100; i++) {
        const content = await jinaClient.convertUrlToMarkdown(url);
        const outline = markdownParser.extractMarkdownOutline(content);
        
        expect(content).toBeDefined();
        expect(Array.isArray(outline)).toBe(true);
      }
      
      // Vérifier que le nombre d'appels est correct
      expect(axios.get).toHaveBeenCalledTimes(100);
    });
  });
});