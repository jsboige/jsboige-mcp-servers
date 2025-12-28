/**
 * Tests d'intégration pour les outils MCP
 * 
 * Ces tests vérifient que les outils fonctionnent correctement
 * lorsqu'ils sont utilisés ensemble dans des scénarios réels.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { convertWebToMarkdownTool } from '../../src/tools/convert-web-to-markdown.js';
import { accessJinaResourceTool } from '../../src/tools/access-jina-resource.js';
import { convertMultipleWebsToMarkdownTool as multiConvertTool } from '../../src/tools/multi-convert.js';
import { extractMarkdownOutlineTool } from '../../src/tools/extract-markdown-outline.js';

// Mock axios
jest.mock('axios');

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

// Définir les globales pour les tests
global.TEST_MARKDOWN_CONTENT = TEST_MARKDOWN_CONTENT;
global.TEST_LARGE_MARKDOWN = TEST_LARGE_MARKDOWN;
global.axios = axios;

describe('Tests d\'intégration des outils MCP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Intégration convertWebToMarkdown + accessJinaResource', () => {
    test('devrait convertir une URL puis y accéder via ressource', async () => {
      const url = 'https://example.com/test-page';
      
      // Première conversion
      const convertResult = await convertWebToMarkdownTool.execute({
        url,
        start_line: 1,
        end_line: 10
      });
      
      expect(convertResult.content).toBeDefined();
      expect(convertResult.content[0].text).toContain('# Titre de test');
      
      // Accès via ressource
      const accessResult = await accessJinaResourceTool.execute({
        uri: `jina://${url}`,
        start_line: 1,
        end_line: 10
      });
      
      expect(accessResult.content).toBeDefined();
      expect(accessResult.content[0].text).toContain('# Titre de test');
      
      // Vérifier que les deux appels ont été faits
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(axios.get).toHaveBeenNthCalledWith(1,
        'https://r.jina.ai/https://example.com/test-page',
        expect.any(Object)
      );
      expect(axios.get).toHaveBeenNthCalledWith(2,
        'https://r.jina.ai/https://example.com/test-page',
        expect.any(Object)
      );
    });

    test('devrait gérer les erreurs de manière cohérente', async () => {
      const url = 'https://example.com/not-found';
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, statusText: 'Not Found' };
      axios.get.mockRejectedValue(error);
      
      // Conversion
      const convertResult = await convertWebToMarkdownTool.execute({ url });
      
      expect(convertResult.error).toBeDefined();
      expect(convertResult.error.message).toContain('404');
      
      // Accès via ressource
      const accessResult = await accessJinaResourceTool.execute({
        uri: `jina://${url}`
      });
      
      expect(accessResult.error).toBeDefined();
      expect(accessResult.error.message).toContain('404');
      
      // Les deux devraient échouer avec une erreur contenant 404
      expect(convertResult.error.message).toContain('404');
      expect(accessResult.error.message).toContain('404');
    });
  });

  describe('Intégration multiConvert + extractMarkdownOutline', () => {
    test('devrait convertir plusieurs URLs puis extraire les plans', async () => {
      const urls = [
        { url: 'https://example.com/page1' },
        { url: 'https://example.com/page2' },
        { url: 'https://example.com/page3' }
      ];
      
      // Conversion multiple
      const multiResult = await multiConvertTool.execute({ urls });
      
      expect(multiResult.result).toBeDefined();
      expect(multiResult.result).toHaveLength(3);
      
      multiResult.result.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.content).toBeDefined();
      });
      
      // Extraction des plans
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls,
        max_depth: 3
      });
      
      expect(outlineResult.result).toBeDefined();
      expect(outlineResult.result).toHaveLength(3);
      
      outlineResult.result.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.outline).toBeDefined();
        expect(result.max_depth).toBe(3);
      });
      
      // Vérifier que tous les appels ont été faits
      expect(axios.get).toHaveBeenCalledTimes(6); // 3 pour multi + 3 pour outline
    });

    test('devrait gérer les succès partiels dans multi-convert', async () => {
      const urls = [
        { url: 'https://example.com/page1' },
        { url: 'https://example.com/page2' },
        { url: 'https://example.com/page3' }
      ];
      
      // Simuler un échec pour la deuxième URL
      axios.get
        .mockResolvedValueOnce({ data: '# Page 1\nContent 1' })
        .mockRejectedValueOnce(new Error('Request timeout'))
        .mockResolvedValueOnce({ data: '# Page 3\nContent 3' });
      
      // Conversion multiple
      const multiResult = await multiConvertTool.execute({ urls });
      
      expect(multiResult.result).toBeDefined();
      expect(multiResult.result).toHaveLength(3);
      expect(multiResult.result[0].success).toBe(true);
      expect(multiResult.result[1].success).toBe(false);
      expect(multiResult.result[2].success).toBe(true);
      
      // Extraction des plans (seulement pour les URLs réussies)
      const successfulUrls = urls.filter((_, index) => 
        multiResult.result[index].success
      );
      
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls: successfulUrls
      });
      
      expect(outlineResult.result).toBeDefined();
      expect(outlineResult.result).toHaveLength(2);
      
      outlineResult.result.forEach(result => {
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Intégration complète des 4 outils', () => {
    test('devrait exécuter un workflow complet', async () => {
      const workflowUrls = [
        { url: 'https://example.com/workflow1' },
        { url: 'https://example.com/workflow2' }
      ];
      
      // Étape 1: Conversion individuelle
      const individualResults = [];
      for (const { url } of workflowUrls) {
        const result = await convertWebToMarkdownTool.execute({ url });
        individualResults.push(result);
      }
      
      expect(individualResults).toHaveLength(2);
      individualResults.forEach(result => {
        expect(result.content).toBeDefined();
      });
      
      // Étape 2: Conversion multiple
      const multiResult = await multiConvertTool.execute({
        urls: workflowUrls
      });
      
      expect(multiResult.result).toBeDefined();
      expect(multiResult.result).toHaveLength(2);
      
      // Étape 3: Extraction des plans
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls: workflowUrls,
        max_depth: 4
      });
      
      expect(outlineResult.result).toBeDefined();
      expect(outlineResult.result).toHaveLength(2);
      
      // Étape 4: Accès via ressources
      const resourceResults = [];
      for (const { url } of workflowUrls) {
        const result = await accessJinaResourceTool.execute({
          uri: `jina://${url}`
        });
        resourceResults.push(result);
      }
      
      expect(resourceResults).toHaveLength(2);
      resourceResults.forEach(result => {
        expect(result.content).toBeDefined();
      });
      
      // Vérifier la cohérence des résultats
      expect(individualResults[0].content[0].text).toBe(multiResult.result[0].content);
      expect(individualResults[1].content[0].text).toBe(multiResult.result[1].content);
      expect(individualResults[0].content[0].text).toBe(resourceResults[0].content[0].text);
      expect(individualResults[1].content[0].text).toBe(resourceResults[1].content[0].text);
      
      // Vérifier le nombre total d'appels
      expect(axios.get).toHaveBeenCalledTimes(8); // 2 + 2 + 2 + 2
    });

    test('devrait gérer les erreurs de manière cohérente dans le workflow', async () => {
      const workflowUrls = [
        { url: 'https://example.com/success' },
        { url: 'https://example.com/failure' }
      ];
      
      // Simuler un échec pour la deuxième URL
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, statusText: 'Not Found' };
      
      // Configuration des mocks pour la séquence d'appels :
      // 1. convertWebToMarkdown (success)
      // 2. convertWebToMarkdown (failure)
      // 3. multiConvert (success)
      // 4. multiConvert (failure)
      axios.get
        .mockResolvedValueOnce({ data: '# Success Page\nContent' })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: '# Success Page\nContent' })
        .mockRejectedValueOnce(error);
      
      // Étape 1: Conversion individuelle
      const individualResults = [];
      for (const { url } of workflowUrls) {
        const result = await convertWebToMarkdownTool.execute({ url });
        individualResults.push(result);
      }
      
      expect(individualResults[0].content).toBeDefined();
      expect(individualResults[1].error).toBeDefined();
      
      // Étape 2: Conversion multiple
      const multiResult = await multiConvertTool.execute({
        urls: workflowUrls
      });
      
      expect(multiResult.result).toBeDefined();
      expect(multiResult.result[0].success).toBe(true);
      expect(multiResult.result[1].success).toBe(false);
      
      // Étape 3: Extraction des plans (seulement succès)
      const successfulUrls = workflowUrls.filter((_, index) =>
        individualResults[index].content
      );
      
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls: successfulUrls
      });
      
      expect(outlineResult.result).toBeDefined();
      expect(outlineResult.result).toHaveLength(1);
      
      // Étape 4: Accès via ressources (seulement succès)
      const resourceResults = [];
      for (const { url } of successfulUrls) {
        const result = await accessJinaResourceTool.execute({
          uri: `jina://${url}`
        });
        resourceResults.push(result);
      }
      
      expect(resourceResults).toHaveLength(1);
      expect(resourceResults[0].content).toBeDefined();
    });
  });

  describe('Tests de performance d\'intégration', () => {
    test('devrait gérer efficacement les conversions simultanées', async () => {
      const urls = [];
      for (let i = 1; i <= 10; i++) {
        urls.push({ url: `https://example.com/page${i}` });
      }
      
      const startTime = Date.now();
      
      // Conversion multiple
      const multiResult = await multiConvertTool.execute({ urls });
      
      // Extraction des plans
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls,
        max_depth: 3
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(multiResult.result).toBeDefined();
      expect(multiResult.result).toHaveLength(10);
      expect(outlineResult.result).toBeDefined();
      expect(outlineResult.result).toHaveLength(10);
      
      // Devrait être raisonnablement rapide (moins de 5 secondes pour 20 requêtes)
      expect(duration).toBeLessThan(5000);
    });

    test('devrait gérer les gros volumes de données', async () => {
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      const urls = [
        { url: 'https://example.com/large1' },
        { url: 'https://example.com/large2' }
      ];
      
      const startTime = Date.now();
      
      const multiResult = await multiConvertTool.execute({ urls });
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls,
        max_depth: 6
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(multiResult.result).toBeDefined();
      expect(outlineResult.result).toBeDefined();
      
      // Devrait gérer les gros volumes sans timeout
      expect(duration).toBeLessThan(10000);
    });
  });

  describe('Tests de cohérence des données', () => {
    test('devrait maintenir la cohérence des métadonnées', async () => {
      const url = 'https://example.com/metadata-test';
      
      // Conversion
      const convertResult = await convertWebToMarkdownTool.execute({
        url,
        start_line: 1,
        end_line: 5
      });
      
      // Accès via ressource
      const accessResult = await accessJinaResourceTool.execute({
        uri: `jina://${url}`,
        start_line: 1,
        end_line: 5
      });
      
      // Les deux devraient avoir le même contenu
      expect(convertResult.content[0].text).toBe(accessResult.content[0].text);
    });

    test('devrait maintenir la cohérence des plages de lignes', async () => {
      const url = 'https://example.com/line-range-test';
      const startLine = 5;
      const endLine = 15;
      
      // Conversion avec plage
      const convertResult = await convertWebToMarkdownTool.execute({
        url,
        start_line: startLine,
        end_line: endLine
      });
      
      // Accès via ressource avec même plage
      const accessResult = await accessJinaResourceTool.execute({
        uri: `jina://${url}`,
        start_line: startLine,
        end_line: endLine
      });
      
      // Les deux devraient avoir le même contenu
      expect(convertResult.content[0].text).toBe(accessResult.content[0].text);
      
      // Le contenu devrait être une extraction correcte
      expect(convertResult.content).toBeDefined();
      expect(accessResult.content).toBeDefined();
    });

    test('devrait maintenir la cohérence des profondeurs d\'extraction', async () => {
      const urls = [
        { url: 'https://example.com/depth-test1' },
        { url: 'https://example.com/depth-test2' }
      ];
      const maxDepth = 4;
      
      // Extraction avec profondeur spécifiée
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls,
        max_depth: maxDepth
      });
      
      expect(outlineResult.result).toBeDefined();
      expect(outlineResult.result).toHaveLength(2);
      
      outlineResult.result.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.max_depth).toBe(maxDepth);
        
        // Vérifier que tous les titres ont un niveau <= maxDepth
        if (result.outline && result.outline.length > 0) {
          result.outline.forEach(heading => {
            expect(heading.level).toBeLessThanOrEqual(maxDepth);
          });
        }
      });
    });
  });

  describe('Tests de gestion des erreurs d\'intégration', () => {
    test('devrait gérer les timeouts réseau de manière cohérente', async () => {
      const timeoutError = new Error('Timeout of 30000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      const url = 'https://example.com/timeout-test';
      
      // Tous les outils devraient échouer avec la même erreur
      const convertResult = await convertWebToMarkdownTool.execute({ url });
      const accessResult = await accessJinaResourceTool.execute({
        uri: `jina://${url}`
      });
      const multiResult = await multiConvertTool.execute({
        urls: [{ url }]
      });
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls: [{ url }]
      });
      
      expect(convertResult.error).toBeDefined();
      expect(accessResult.error).toBeDefined();
      expect(multiResult.result[0].success).toBe(false);
      expect(outlineResult.result[0].success).toBe(false);
      
      // Les messages d'erreur devraient être cohérents
      expect(convertResult.error.message).toContain('Timeout');
      expect(accessResult.error.message).toContain('Timeout');
      expect(multiResult.result[0].error).toContain('Timeout');
      expect(outlineResult.result[0].error).toContain('Timeout');
    });

    test('devrait gérer les erreurs de serveur de manière cohérente', async () => {
      const serverError = new Error('Request failed with status code 500');
      serverError.response = { status: 500, statusText: 'Internal Server Error' };
      axios.get.mockRejectedValue(serverError);
      
      const url = 'https://example.com/server-error';
      
      // Tous les outils devraient échouer avec la même erreur
      const convertResult = await convertWebToMarkdownTool.execute({ url });
      const accessResult = await accessJinaResourceTool.execute({
        uri: `jina://${url}`
      });
      const multiResult = await multiConvertTool.execute({
        urls: [{ url }]
      });
      const outlineResult = await extractMarkdownOutlineTool.execute({
        urls: [{ url }]
      });
      
      expect(convertResult.error).toBeDefined();
      expect(accessResult.error).toBeDefined();
      expect(multiResult.result[0].success).toBe(false);
      expect(outlineResult.result[0].success).toBe(false);
      
      // Les messages d'erreur devraient contenir le code d'erreur
      expect(convertResult.error.message).toContain('500');
      expect(accessResult.error.message).toContain('500');
      expect(multiResult.result[0].error).toContain('500');
      expect(outlineResult.result[0].error).toContain('500');
    });
  });
});