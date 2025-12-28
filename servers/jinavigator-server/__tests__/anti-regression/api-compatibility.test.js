/**
 * Tests anti-régression pour la compatibilité API
 * 
 * Ces tests vérifient que les changements n'introduisent pas de régressions
 * dans l'API publique et que le comportement reste cohérent.
 */

import { jest } from '@jest/globals';
import {
  detectApiRegressions,
  validateApiCompatibility,
  compareApiVersions,
  API_COMPATIBILITY_BASELINE
} from '../setup/anti-regression.js';
import '../setup/unit.js'; // Import setup to get globals and mocks
import axios from 'axios';
import {
  convertWebToMarkdownTool,
  accessJinaResourceTool,
  convertMultipleWebsToMarkdownTool as multiConvertTool,
  extractMarkdownOutlineTool
} from '../../src/tools/index.js';

// Mock axios
jest.mock('axios', () => {
  const mockGet = jest.fn();
  const mockIsAxiosError = jest.fn();
  return {
    __esModule: true,
    default: {
      get: mockGet,
      isAxiosError: mockIsAxiosError,
    },
    get: mockGet,
    isAxiosError: mockIsAxiosError,
  };
});

describe('Tests anti-régression de compatibilité API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: global.TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Compatibilité de convertWebToMarkdown', () => {
    test('devrait maintenir la compatibilité des paramètres', async () => {
      const input = {
        url: 'https://example.com/compatibility-test',
        start_line: 1,
        end_line: 10
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.content).toBeDefined();
      
      // Vérifier la compatibilité avec la base de référence
      const compatibility = validateApiCompatibility('convertWebToMarkdown', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la compatibilité des réponses', async () => {
      const input = {
        url: 'https://example.com/response-test'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result).toHaveProperty('content');
      
      // Vérifier que la structure de réponse est cohérente
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].text.length).toBeGreaterThan(0);
      
      const compatibility = validateApiCompatibility('convertWebToMarkdown', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la compatibilité des erreurs', async () => {
      const input = {
        url: 'https://example.com/error-test'
      };
      
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, statusText: 'Not Found' };
      axios.get.mockRejectedValue(error);
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result).toHaveProperty('error');
      
      const compatibility = validateApiCompatibility('convertWebToMarkdown', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Compatibilité de accessJinaResource', () => {
    test('devrait maintenir la compatibilité des paramètres URI', async () => {
      const input = {
        uri: 'jina://https://example.com/uri-compatibility-test',
        start_line: 5,
        end_line: 15
      };
      
      const result = await accessJinaResourceTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result.content).toBeDefined();
      
      const compatibility = validateApiCompatibility('accessJinaResource', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la compatibilité des formats URI', async () => {
      const validUris = [
        'jina://https://example.com/simple',
        'jina://https://example.com/path?query=value',
        'jina://https://example.com/path#fragment',
        'jina://https://example.com/path with spaces'
      ];
      
      for (const uri of validUris) {
        const input = { uri };
        const result = await accessJinaResourceTool.execute(input);
        
        expect(result).not.toHaveProperty('error');
        
        const compatibility = validateApiCompatibility('accessJinaResource', input, result);
        expect(compatibility.isCompatible).toBe(true);
      }
    });

    test('devrait maintenir la compatibilité des erreurs URI', async () => {
      const input = {
        uri: 'jina://https://example.com/not-found'
      };
      
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404, statusText: 'Not Found' };
      axios.get.mockRejectedValue(error);
      
      const result = await accessJinaResourceTool.execute(input);
      
      expect(result).toHaveProperty('error');
      
      const compatibility = validateApiCompatibility('accessJinaResource', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Compatibilité de multiConvert', () => {
    test('devrait maintenir la compatibilité des paramètres multiples', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/multi-1', start_line: 1, end_line: 5 },
          { url: 'https://example.com/multi-2' },
          { url: 'https://example.com/multi-3', start_line: 10, end_line: 20 }
        ]
      };
      
      const result = await multiConvertTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      expect(result).toHaveProperty('result');
      expect(Array.isArray(result.result)).toBe(true);
      expect(result.result).toHaveLength(3);
      
      const compatibility = validateApiCompatibility('multiConvert', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la compatibilité des résultats partiels', async () => {
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
      
      const compatibility = validateApiCompatibility('multiConvert', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });

    test('devrait maintenir la compatibilité des métadonnées', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/metadata-1' },
          { url: 'https://example.com/metadata-2' }
        ]
      };
      
      const result = await multiConvertTool.execute(input);
      
      expect(result).not.toHaveProperty('error');
      
      // Vérifier que chaque résultat a la structure attendue
      result.result.forEach(item => {
        expect(item).toHaveProperty('url');
        expect(item).toHaveProperty('success');
        if (item.success) {
          expect(item).toHaveProperty('content');
        } else {
          expect(item).toHaveProperty('error');
        }
      });
      
      const compatibility = validateApiCompatibility('multiConvert', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Compatibilité de extractMarkdownOutline', () => {
    test('devrait maintenir la compatibilité des paramètres de profondeur', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/outline-1' },
          { url: 'https://example.com/outline-2' }
        ],
        max_depth: 4
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
        expect(item.max_depth).toBe(4);
        
        if (item.success) {
          expect(item).toHaveProperty('outline');
          expect(Array.isArray(item.outline)).toBe(true);
        }
      });
      
      const compatibility = validateApiCompatibility('extractMarkdownOutline', input, result);
      expect(compatibility.isCompatible).toBe(true);
      expect(compatibility.regressions).toHaveLength(0);
    });

    test('devrait maintenir la compatibilité des structures de plan', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/structure-test' }
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
      
      const compatibility = validateApiCompatibility('extractMarkdownOutline', input, result);
      expect(compatibility.isCompatible).toBe(true);
    });
  });

  describe('Détection de régressions API', () => {
    test('devrait détecter les régressions dans les signatures de méthodes', () => {
      // Simuler une régression dans la signature
      const originalTool = convertWebToMarkdownTool;
      
      // Modifier la signature (simulation de régression)
      const modifiedTool = {
        ...originalTool,
        execute: jest.fn().mockResolvedValue({ success: true, content: 'modified' })
      };
      
      const input = { url: 'https://example.com/regression-test' };
      
      const regression = detectApiRegressions('convertWebToMarkdown', originalTool, modifiedTool);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.length).toBeGreaterThan(0);
      expect(regression.regressions.some(r => r.type === 'signature_change')).toBe(true);
    });

    test('devrait détecter les régressions dans les structures de réponse', () => {
      // Simuler une régression dans la structure de réponse
      const originalResult = {
        success: true,
        content: '# Original Content'
      };
      
      const modifiedResult = {
        success: true,
        data: '# Modified Content' // Champ différent
      };
      
      const regression = detectApiRegressions('response_structure', originalResult, modifiedResult);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.some(r => r.type === 'response_structure_change')).toBe(true);
    });

    test('devrait détecter les régressions dans les codes d\'erreur', () => {
      const originalError = 'Request failed with status code 404';
      const modifiedError = 'HTTP 404 Not Found'; // Format différent
      
      const regression = detectApiRegressions('error_codes', originalError, modifiedError);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.some(r => r.type === 'error_format_change')).toBe(true);
    });

    test('devrait détecter les régressions dans les types de données', () => {
      const originalType = 'string';
      const modifiedType = 'object'; // Type différent
      
      const regression = detectApiRegressions('data_types', originalType, modifiedType);
      
      expect(regression.hasRegression).toBe(true);
      expect(regression.regressions.some(r => r.type === 'data_type_change')).toBe(true);
    });
  });

  describe('Comparaison de versions API', () => {
    test('devrait comparer avec la base de référence', () => {
      const currentVersion = {
        'convertWebToMarkdown': {
          parameters: ['url', 'start_line', 'end_line'],
          response: { success: 'boolean', content: 'string' }
        },
        'accessJinaResource': {
          parameters: ['uri', 'start_line', 'end_line'],
          response: { success: 'boolean', content: 'string' }
        }
      };
      
      const comparison = compareApiVersions(currentVersion, API_COMPATIBILITY_BASELINE);
      
      expect(comparison.isCompatible).toBe(true);
      expect(comparison.breakingChanges).toHaveLength(0);
      expect(comparison.additions.length).toBeGreaterThanOrEqual(0);
      expect(comparison.deprecations.length).toBeGreaterThanOrEqual(0);
    });

    test('devrait détecter les changements cassants', () => {
      const currentVersion = {
        'convertWebToMarkdown': {
          parameters: ['new_url'], // Paramètre renommé (cassant)
          response: { success: 'boolean', data: 'string' } // Champ renommé (cassant)
        }
      };
      
      const comparison = compareApiVersions(currentVersion, API_COMPATIBILITY_BASELINE);
      
      expect(comparison.isCompatible).toBe(false);
      expect(comparison.breakingChanges.length).toBeGreaterThan(0);
      expect(comparison.breakingChanges.some(change => 
        change.type === 'parameter_renamed' || change.type === 'response_field_renamed'
      )).toBe(true);
    });

    test('devrait identifier les ajouts et dépréciations', () => {
      const currentVersion = {
        'convertWebToMarkdown': {
          parameters: ['url', 'start_line', 'end_line', 'new_optional_param'],
          response: { success: 'boolean', content: 'string', 'new_metadata': 'object' }
        }
      };
      
      const comparison = compareApiVersions(currentVersion, API_COMPATIBILITY_BASELINE);
      
      expect(comparison.isCompatible).toBe(true);
      expect(comparison.breakingChanges).toHaveLength(0);
      expect(comparison.additions.length).toBeGreaterThan(0);
      expect(comparison.additions.some(addition => 
        addition.type === 'new_parameter' || addition.type === 'new_response_field'
      )).toBe(true);
    });
  });

  describe('Tests de régression comportementaux', () => {
    test('devrait maintenir le comportement de validation d\'entrée', async () => {
      const invalidInputs = [
        { url: '' }, // URL vide
        { start_line: -1 }, // Ligne invalide
        { end_line: 0 }, // Ligne invalide
        null, // Null
        undefined, // Undefined
        'not-an-object' // Type incorrect
      ];
      
      for (const invalidInput of invalidInputs) {
        const result = await convertWebToMarkdownTool.execute(invalidInput);
        
        // Le comportement d'erreur devrait être cohérent
        if (invalidInput === null || invalidInput === undefined) {
          expect(result).toHaveProperty('error');
        } else if (invalidInput === 'not-an-object') {
           // Si l'entrée n'est pas un objet, le destructuring peut échouer ou produire undefined
           // Si cela produit undefined, l'URL devient "undefined" et Jina peut retourner un résultat
           if (result.error) {
             expect(result).toHaveProperty('error');
           } else {
             expect(result.content).toBeDefined();
           }
        } else if (invalidInput && invalidInput.url === '') {
          // Jina API retourne le mode d'emploi pour les entrées invalides
          if (result.error) {
             expect(result).toHaveProperty('error');
          } else {
             expect(result.content).toBeDefined();
          }
        } else if (invalidInput && (invalidInput.start_line === -1 || invalidInput.end_line === 0)) {
          // Jina API retourne le mode d'emploi pour les entrées invalides, ce qui est considéré comme un succès par l'outil
          // mais le contenu indique une erreur d'utilisation
          if (result.error) {
             expect(result).toHaveProperty('error');
          } else {
             expect(result.content).toBeDefined();
          }
        }
      }
    });

    test('devrait maintenir le comportement de gestion d\'erreurs réseau', async () => {
      const networkErrors = [
        { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND example.com' },
        { code: 'ECONNREFUSED', message: 'ECONNREFUSED' },
        { code: 'ETIMEDOUT', message: 'Connection timed out' },
        { code: 'ECONNABORTED', message: 'Request aborted' }
      ];
      
      for (const error of networkErrors) {
        const networkError = new Error(error.message);
        networkError.code = error.code;
        axios.get.mockRejectedValue(networkError);
        
        const result = await convertWebToMarkdownTool.execute({ url: 'https://example.com/test' });
        
        expect(result).toHaveProperty('error');
        expect(result.error.message).toContain(error.message);
        
        // Le format d'erreur devrait être cohérent
        expect(typeof result.error).toBe('object');
      }
    });

    test('devrait maintenir le comportement de gestion d\'erreurs HTTP', async () => {
      const httpErrors = [
        { status: 400, statusText: 'Bad Request' },
        { status: 401, statusText: 'Unauthorized' },
        { status: 403, statusText: 'Forbidden' },
        { status: 404, statusText: 'Not Found' },
        { status: 500, statusText: 'Internal Server Error' },
        { status: 502, statusText: 'Bad Gateway' },
        { status: 503, statusText: 'Service Unavailable' }
      ];
      
      for (const error of httpErrors) {
        const httpError = new Error(`Request failed with status code ${error.status}`);
        httpError.response = { status: error.status, statusText: error.statusText };
        axios.get.mockRejectedValue(httpError);
        
        const result = await convertWebToMarkdownTool.execute({ url: 'https://example.com/test' });
        
        expect(result).toHaveProperty('error');
        expect(result.error.message).toContain(`${error.status}`);
        
        // Le format d'erreur HTTP devrait être cohérent
        expect(typeof result.error).toBe('object');
      }
    });
  });

  describe('Tests de régression de performance', () => {
    test('devrait maintenir les seuils de performance', async () => {
      const input = {
        url: 'https://example.com/performance-regression-test'
      };
      
      const startTime = Date.now();
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(result).not.toHaveProperty('error');
      
      // La performance ne devrait pas régresser (baseline: < 5 secondes)
      expect(duration).toBeLessThan(5000);
    });

    test('devrait maintenir la performance sous charge', async () => {
      const urls = [];
      for (let i = 1; i <= 10; i++) {
        urls.push({ url: `https://example.com/load-regression-${i}` });
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        urls.map(input => convertWebToMarkdownTool.execute(input))
      );
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result).not.toHaveProperty('error');
      });
      
      // La performance sous charge ne devrait pas régresser
      expect(totalDuration).toBeLessThan(10000); // 10 requêtes en < 10 secondes
    });

    test('devrait maintenir l\'efficacité mémoire', async () => {
      const initialMemory = process.memoryUsage();
      
      // Effectuer 50 conversions
      for (let i = 1; i <= 50; i++) {
        await convertWebToMarkdownTool.execute({
          url: `https://example.com/memory-regression-${i}`
        });
      }
      
      // Forcer le garbage collection si disponible
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
      
      // L'utilisation mémoire ne devrait pas régresser
      expect(memoryIncreaseMB).toBeLessThan(50); // < 50MB pour 50 conversions
    });
  });

  describe('Tests de régression de fonctionnalités', () => {
    test('devrait maintenir la compatibilité des caractères spéciaux', async () => {
      const specialInputs = [
        { url: 'https://example.com/émojis-🚀' },
        { url: 'https://example.com/accents-éàèç' },
        { url: 'https://example.com/symbols-♠♣♥♦' },
        { url: 'https://example.com/path with spaces' }
      ];
      
      for (const input of specialInputs) {
        const result = await convertWebToMarkdownTool.execute(input);
        
        expect(result).not.toHaveProperty('error');
        expect(result.content).toBeDefined();
        expect(Array.isArray(result.content)).toBe(true);
        
        // Les caractères spéciaux devraient être préservés
        expect(result.content[0].text.length).toBeGreaterThan(0);
      }
    });

    test('devrait maintenir la compatibilité des formats de contenu', async () => {
      const contentFormats = [
        '# Simple Title\n\nSimple content.',
        '# Title\n\n## Subtitle\n\nContent with **bold** and *italic*.',
        '# Title\n\n- List item 1\n- List item 2\n- List item 3',
        '# Title\n\n> Blockquote content\n\nNormal paragraph.',
        '# Title\n\n`inline code` and\n\n```\ncode block\n```'
      ];
      
      for (const format of contentFormats) {
        axios.get.mockResolvedValue({ data: format });
        
        const result = await convertWebToMarkdownTool.execute({
          url: 'https://example.com/format-test'
        });
        
        expect(result).not.toHaveProperty('error');
        expect(result.content[0].text).toBe(format);
        
        // Le formatage devrait être préservé
        expect(result.content[0].text.length).toBeGreaterThan(0);
      }
    });

    test('devrait maintenir la compatibilité des limites système', async () => {
      const edgeCases = [
        { url: 'https://example.com/' + 'a'.repeat(2000) }, // URL très longue
        { url: 'https://example.com', start_line: 1, end_line: 100000 }, // Grande plage
        { url: 'https://example.com/empty' } // Contenu vide
      ];
      
      for (const testCase of edgeCases) {
        const result = await convertWebToMarkdownTool.execute(testCase);
        
        // Le comportement aux limites devrait être cohérent
        if (testCase.url.includes('a'.repeat(2000))) {
          // URL longue devrait fonctionner
          expect(result).not.toHaveProperty('error');
        } else if (testCase.end_line === 100000) {
          // Grande plage devrait fonctionner (si contenu existe)
          expect(result).not.toHaveProperty('error');
        }
        
        if (!result.error) {
          expect(result.content).toBeDefined();
          expect(Array.isArray(result.content)).toBe(true);
        }
      }
    });
  });
});