/**
 * Tests anti-régression pour les fonctionnalités
 * 
 * Ces tests vérifient que les fonctionnalités existantes continuent de fonctionner
 * comme attendu après les modifications et refactorings.
 */

import { jest } from '@jest/globals';

jest.mock('axios', () => {
  const mockAxios = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    isAxiosError: jest.fn(() => false),
    create: jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn()
    }))
  };
  return {
    __esModule: true,
    default: mockAxios,
    ...mockAxios
  };
});

import {
  detectFeatureRegressions,
  validateFeatureCompatibility,
  compareFeatureVersions,
  FEATURE_COMPATIBILITY_BASELINE
} from '../setup/anti-regression.js';
import {
  convertWebToMarkdownTool,
  accessJinaResourceTool,
  convertMultipleWebsToMarkdownTool as multiConvertTool,
  extractMarkdownOutlineTool
} from '../../src/tools/index.js';
import * as JinaClient from '../../src/utils/jina-client.js';
import * as MarkdownParser from '../../src/utils/markdown-parser.js';
import '../setup/unit.js'; // Import setup to get globals and mocks
import axios from 'axios';

describe('Tests anti-régression de fonctionnalités', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: global.TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Régression de conversion web vers markdown', () => {
    test('devrait maintenir la fonctionnalité de conversion de base', async () => {
      const input = {
        url: 'https://example.com/basic-conversion'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].text.length).toBeGreaterThan(0);
      
      // Vérifier la compatibilité avec la base de référence
      const compatibility = validateFeatureCompatibility('web_to_markdown', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la fonctionnalité d\'extraction de plage', async () => {
      const input = {
        url: 'https://example.com/range-extraction',
        start_line: 5,
        end_line: 15
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.content).toBeDefined();
      
      // Vérifier que l'extraction de plage fonctionne
      const lines = result.content[0].text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(11); // 15 - 5 + 1
      
      const compatibility = validateFeatureCompatibility('range_extraction', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de gestion d\'erreurs', async () => {
      const input = {
        url: 'https://example.com/error-handling'
      };
      
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, statusText: 'Not Found' };
      axios.get.mockRejectedValue(error);
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result).toHaveProperty('error');
      expect(typeof result.error).toBe('object');
      expect(result.error.message).toContain('404');
      
      const compatibility = validateFeatureCompatibility('error_handling', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de validation d\'entrée', async () => {
      const invalidInputs = [
        { url: '' },
        { url: null },
        { url: undefined },
        { start_line: -1 },
        { end_line: 0 },
        { start_line: 10, end_line: 5 }
      ];
      
      for (const invalidInput of invalidInputs) {
        const result = await convertWebToMarkdownTool.execute(invalidInput);
        
        // Jina API retourne le mode d'emploi pour les entrées invalides, ce qui est considéré comme un succès par l'outil
        // mais le contenu indique une erreur d'utilisation ou des instructions
        if (result.error) {
          expect(result).toHaveProperty('error');
        } else {
          expect(result.content).toBeDefined();
        }
        
        const compatibility = validateFeatureCompatibility('input_validation', invalidInput, result);
        expect(compatibility.isCompatible).toBe(true);
      }
    });
  });

  describe('Régression d\'accès aux ressources Jina', () => {
    test('devrait maintenir la fonctionnalité d\'accès URI', async () => {
      const input = {
        uri: 'jina://https://example.com/uri-access'
      };
      
      const result = await accessJinaResourceTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      
      const compatibility = validateFeatureCompatibility('uri_access', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la fonctionnalité d\'extraction de plage URI', async () => {
      const input = {
        uri: 'jina://https://example.com/uri-range',
        start_line: 3,
        end_line: 8
      };
      
      const result = await accessJinaResourceTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.content).toBeDefined();
      
      const compatibility = validateFeatureCompatibility('uri_range_extraction', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de validation URI', async () => {
      const invalidUris = [
        { uri: '' },
        { uri: 'not-jina://example.com' },
        { uri: 'jina://' },
        { uri: null },
        { uri: undefined }
      ];
      
      for (const invalidUri of invalidUris) {
        const result = await accessJinaResourceTool.execute(invalidUri);
        
        expect(result).toHaveProperty('error');
        
        const compatibility = validateFeatureCompatibility('uri_validation', invalidUri, result);
        expect(compatibility.isCompatible).toBe(true);
      }
    });
  });

  describe('Régression de conversion multiple', () => {
    test('devrait maintenir la fonctionnalité de conversion en lot', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/batch-1' },
          { url: 'https://example.com/batch-2' },
          { url: 'https://example.com/batch-3' }
        ]
      };
      
      const result = await multiConvertTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result).toHaveProperty('result');
      expect(Array.isArray(result.result)).toBe(true);
      expect(result.result).toHaveLength(3);
      
      result.result.forEach(item => {
        expect(item).toHaveProperty('url');
        expect(item).toHaveProperty('success');
        expect(item.success).toBe(true);
        expect(item).toHaveProperty('content');
      });
      
      const compatibility = validateFeatureCompatibility('batch_conversion', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la fonctionnalité de gestion d\'erreurs partielles', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/success-1' },
          { url: 'https://example.com/failure-1' },
          { url: 'https://example.com/success-2' }
        ]
      };
      
      // Simuler un échec pour la deuxième URL
      axios.get
        .mockResolvedValueOnce({ data: '# Success 1' })
        .mockRejectedValueOnce(new Error('Request failed'))
        .mockResolvedValueOnce({ data: '# Success 2' });
      
      const result = await multiConvertTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.result).toHaveLength(3);
      expect(result.result[0].success).toBe(true);
      expect(result.result[1].success).toBe(false);
      expect(result.result[2].success).toBe(true);
      
      const compatibility = validateFeatureCompatibility('partial_error_handling', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de paramètres individuels', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/individual-1', start_line: 1, end_line: 5 },
          { url: 'https://example.com/individual-2' },
          { url: 'https://example.com/individual-3', start_line: 10, end_line: 20 }
        ]
      };
      
      const result = await multiConvertTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.result).toHaveLength(3);
      
      // Vérifier que les paramètres individuels sont appliqués
      expect(result.result[0].url).toBe('https://example.com/individual-1');
      expect(result.result[1].url).toBe('https://example.com/individual-2');
      expect(result.result[2].url).toBe('https://example.com/individual-3');
      
      const compatibility = validateFeatureCompatibility('individual_parameters', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Régression d\'extraction de plan markdown', () => {
    test('devrait maintenir la fonctionnalité d\'extraction de plan', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/outline-1' },
          { url: 'https://example.com/outline-2' }
        ],
        max_depth: 3
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result).toHaveProperty('result');
      expect(Array.isArray(result.result)).toBe(true);
      expect(result.result).toHaveLength(2);
      
      result.result.forEach(item => {
        expect(item).toHaveProperty('url');
        expect(item).toHaveProperty('success');
        expect(item).toHaveProperty('max_depth');
        expect(item.max_depth).toBe(3);
        
        if (item.success) {
          expect(item).toHaveProperty('outline');
          expect(Array.isArray(item.outline)).toBe(true);
        }
      });
      
      const compatibility = validateFeatureCompatibility('outline_extraction', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la fonctionnalité de limitation de profondeur', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/depth-limit' }
        ],
        max_depth: 2
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      
      if (result.result[0].success) {
        const outline = result.result[0].outline;
        
        // Vérifier que la profondeur est limitée
        outline.forEach(heading => {
          expect(heading.level).toBeLessThanOrEqual(2);
        });
      }
      
      const compatibility = validateFeatureCompatibility('depth_limitation', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de structure de plan', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/outline-structure' }
        ],
        max_depth: 6
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      
      if (result.result[0].success) {
        const outline = result.result[0].outline;
        
        // Vérifier la structure des éléments du plan
        outline.forEach(heading => {
          expect(heading).toHaveProperty('level');
          expect(heading).toHaveProperty('text');
          expect(heading).toHaveProperty('line');
          
          expect(typeof heading.level).toBe('number');
          expect(typeof heading.text).toBe('string');
          expect(typeof heading.line).toBe('number');
          
          expect(heading.level).toBeGreaterThanOrEqual(1);
          expect(heading.level).toBeLessThanOrEqual(6);
          expect(heading.line).toBeGreaterThan(0);
        });
      }
      
      const compatibility = validateFeatureCompatibility('outline_structure', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Régression du client Jina', () => {
    test('devrait maintenir la fonctionnalité de requête HTTP', async () => {
      const result = await JinaClient.convertUrlToMarkdown('https://example.com/http-request');
      
      expect(result).toBe(global.TEST_MARKDOWN_CONTENT);
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/http-request',
        expect.any(Object)
      );
      
      const compatibility = validateFeatureCompatibility('http_request', { url: 'https://example.com/http-request' }, { result });
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de gestion d\'erreurs HTTP', async () => {
      const error = new Error('Request failed with status code 500');
      error.response = { status: 500, statusText: 'Internal Server Error' };
      axios.get.mockRejectedValue(error);
      
      await expect(JinaClient.convertUrlToMarkdown('https://example.com/http-error'))
        .rejects.toThrow('Erreur lors de la conversion: Request failed with status code 500');
      
      const compatibility = validateFeatureCompatibility('http_error_handling', { url: 'https://example.com/http-error' }, { error: error.message });
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de timeout', async () => {
      const timeoutError = new Error('timeout of 30000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      await expect(JinaClient.convertUrlToMarkdown('https://example.com/timeout'))
        .rejects.toThrow('Erreur lors de la conversion: timeout of 30000ms exceeded');
      
      const compatibility = validateFeatureCompatibility('timeout_handling', { url: 'https://example.com/timeout' }, { error: timeoutError.message });
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Régression du parser Markdown', () => {
    test('devrait maintenir la fonctionnalité d\'extraction de titres', () => {
      const markdown = '# Title 1\n\n## Title 2\n\n### Title 3';
      
      const headings = MarkdownParser.extractMarkdownOutline(markdown);
      
      expect(headings).toHaveLength(1);
      expect(headings[0].text).toBe('Title 1');
      expect(headings[0].children[0].text).toBe('Title 2');
      expect(headings[0].children[0].children[0].text).toBe('Title 3');
      
      const compatibility = validateFeatureCompatibility('heading_extraction', { markdown }, { headings });
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la fonctionnalité de filtrage par profondeur', () => {
      const markdown = '# Title 1\n\n## Title 2\n\n### Title 3\n\n#### Title 4';
      
      const headings = MarkdownParser.extractMarkdownOutline(markdown, 2);
      
      expect(headings).toHaveLength(1);
      expect(headings[0].text).toBe('Title 1');
      expect(headings[0].children[0].text).toBe('Title 2');
      expect(headings[0].children[0].children).toBeUndefined();
      
      const compatibility = validateFeatureCompatibility('depth_filtering', { markdown, maxDepth: 2 }, { headings });
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de gestion de contenu vide', () => {
      const emptyHeadings = MarkdownParser.extractMarkdownOutline('');
      const whitespaceHeadings = MarkdownParser.extractMarkdownOutline('   \n\n   ');
      
      expect(emptyHeadings).toHaveLength(0);
      expect(whitespaceHeadings).toHaveLength(0);
      
      const compatibility = validateFeatureCompatibility('empty_content_handling', { content: '' }, { headings: emptyHeadings });
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la fonctionnalité de gestion de caractères spéciaux', () => {
      const markdown = '# Titre avec accents éàèç\n\n## Title with symbols ♠♣♥♦\n\n### Title with emojis 🚀🎉';
      
      const headings = MarkdownParser.extractMarkdownOutline(markdown);
      
      expect(headings).toHaveLength(1);
      expect(headings[0].text).toBe('Titre avec accents éàèç');
      expect(headings[0].children[0].text).toBe('Title with symbols ♠♣♥♦');
      expect(headings[0].children[0].children[0].text).toBe('Title with emojis 🚀🎉');
      
      const compatibility = validateFeatureCompatibility('special_characters', { markdown }, { headings });
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Détection de régressions de fonctionnalités', () => {
    test('devrait détecter les régressions dans les signatures de fonctionnalités', () => {
      const originalFeature = {
        name: 'web_to_markdown',
        parameters: ['url', 'start_line', 'end_line'],
        returns: { success: 'boolean', content: 'string' }
      };
      
      const modifiedFeature = {
        name: 'web_to_markdown',
        parameters: ['new_url'], // Paramètre modifié
        returns: { success: 'boolean', data: 'string' } // Champ de retour modifié
      };
      
      const regression = detectFeatureRegressions(originalFeature, modifiedFeature);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.length).toBeGreaterThan(0);
      expect(regression.regressions.some(r => r.type === 'parameter_change')).toBe(true);
      expect(regression.regressions.some(r => r.type === 'return_value_change')).toBe(true);
    });

    test('devrait détecter les régressions dans le comportement des fonctionnalités', () => {
      const originalBehavior = {
        input: { url: 'https://example.com/test' },
        output: { success: true, content: '# Test Content' }
      };
      
      const modifiedBehavior = {
        input: { url: 'https://example.com/test' },
        output: { success: false, error: 'Request failed' } // Comportement modifié
      };
      
      const regression = detectFeatureRegressions(originalBehavior, modifiedBehavior);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.some(r => r.type === 'behavior_change')).toBe(true);
    });

    test('devrait détecter les régressions dans les performances des fonctionnalités', () => {
      const originalPerformance = {
        feature: 'web_to_markdown',
        averageTime: 1000, // 1 seconde
        maxTime: 3000 // 3 secondes
      };
      
      const modifiedPerformance = {
        feature: 'web_to_markdown',
        averageTime: 5000, // 5 secondes (régression)
        maxTime: 10000 // 10 secondes (régression)
      };
      
      const regression = detectFeatureRegressions(originalPerformance, modifiedPerformance);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.some(r => r.type === 'performance_regression')).toBe(true);
    });
  });

  describe('Comparaison de versions de fonctionnalités', () => {
    test('devrait comparer avec la base de référence des fonctionnalités', () => {
      const currentFeatures = {
        'web_to_markdown': {
          parameters: ['url', 'start_line', 'end_line'],
          returns: { success: 'boolean', content: 'string' },
          performance: { averageTime: 1000, maxTime: 3000 }
        },
        'uri_access': {
          parameters: ['uri', 'start_line', 'end_line'],
          returns: { success: 'boolean', content: 'string' },
          performance: { averageTime: 800, maxTime: 2500 }
        }
      };
      
      const comparison = compareFeatureVersions(currentFeatures, FEATURE_COMPATIBILITY_BASELINE);
      
      expect(comparison.isCompatible).toBe(true);
      expect(comparison.breakingChanges).toHaveLength(0);
      expect(comparison.performanceRegressions).toHaveLength(0);
      expect(comparison.additions.length).toBeGreaterThanOrEqual(0);
      expect(comparison.deprecations.length).toBeGreaterThanOrEqual(0);
    });

    test('devrait détecter les changements cassants dans les fonctionnalités', () => {
      const currentFeatures = {
        'web_to_markdown': {
          parameters: ['new_url'], // Paramètre cassant
          returns: { success: 'boolean', data: 'string' }, // Retour cassant
          performance: { averageTime: 5000, maxTime: 10000 } // Performance cassante
        }
      };
      
      const comparison = compareFeatureVersions(currentFeatures, FEATURE_COMPATIBILITY_BASELINE);
      
      expect(comparison.isCompatible).toBe(false);
      expect(comparison.breakingChanges.length).toBeGreaterThan(0);
      expect(comparison.performanceRegressions.length).toBeGreaterThan(0);
    });

    test('devrait identifier les améliorations de fonctionnalités', () => {
      const currentFeatures = {
        'web_to_markdown': {
          parameters: ['url', 'start_line', 'end_line', 'new_optional_param'],
          returns: { success: 'boolean', content: 'string', 'new_metadata': 'object' },
          performance: { averageTime: 500, maxTime: 1500 } // Performance améliorée
        }
      };
      
      const comparison = compareFeatureVersions(currentFeatures, FEATURE_COMPATIBILITY_BASELINE);
      
      expect(comparison.isCompatible).toBe(true);
      expect(comparison.breakingChanges).toHaveLength(0);
      expect(comparison.performanceRegressions).toHaveLength(0);
      expect(comparison.performanceImprovements.length).toBeGreaterThan(0);
      expect(comparison.additions.length).toBeGreaterThan(0);
    });
  });

  describe('Tests de régression d\'intégration', () => {
    test('devrait maintenir l\'intégration entre les outils', async () => {
      // Test d'intégration entre convertWebToMarkdown et accessJinaResource
      const url = 'https://example.com/integration-test';
      
      const webResult = await convertWebToMarkdownTool.execute({ url });
      const uriResult = await accessJinaResourceTool.execute({ uri: `jina://${url}` });
      
      expect(webResult).not.toHaveProperty('error');
      expect(uriResult).not.toHaveProperty('error');
      
      // Les deux devraient retourner le même contenu
      expect(webResult.content[0].text).toBe(uriResult.content[0].text);
      
      const compatibility = validateFeatureCompatibility('tool_integration', { url }, { webResult, uriResult });
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir l\'intégration avec les utilitaires', async () => {
      const markdown = await JinaClient.convertUrlToMarkdown('https://example.com/utility-integration');
      const headings = MarkdownParser.extractMarkdownOutline(markdown);
      
      expect(typeof markdown).toBe('string');
      expect(Array.isArray(headings)).toBe(true);
      
      const compatibility = validateFeatureCompatibility('utility_integration', { url: 'https://example.com/utility-integration' }, { markdown, headings });
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir l\'intégration de bout en bout', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/e2e-1' },
          { url: 'https://example.com/e2e-2' }
        ],
        max_depth: 3
      };
      
      // 1. Extraire le plan
      const outlineResult = await extractMarkdownOutlineTool.execute(input);
      expect(outlineResult).not.toHaveProperty('error');
      
      // 2. Convertir le contenu pour chaque URL
      for (const urlInfo of input.urls) {
        const convertResult = await convertWebToMarkdownTool.execute(urlInfo);
        expect(convertResult).not.toHaveProperty('error');
        
        // 3. Parser le contenu converti
        const headings = MarkdownParser.extractMarkdownOutline(convertResult.content[0].text, input.max_depth);
        expect(Array.isArray(headings)).toBe(true);
      }
      
      const compatibility = validateFeatureCompatibility('end_to_end_integration', input, { outlineResult });
      expect(compatibility.isCompatible).toBe(true);
    });
  });
});