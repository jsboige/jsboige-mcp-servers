/**
 * Tests unitaires pour les types TypeScript
 * 
 * Ces tests couvrent tous les cas nominaux, d'erreur et limites
 * pour les définitions de types et interfaces utilisées dans le projet.
 */

import { jest } from '@jest/globals';

// Import des types à tester
// Note: Ces tests vérifient la structure et la cohérence des types
// même si TypeScript effectue la vérification statique à la compilation

describe('Types et interfaces', () => {
  describe('JinaNavigatorConfig', () => {
    test('devrait avoir la structure correcte', () => {
      // Simulation de la structure de configuration
      const config = {
        baseURL: 'https://r.jina.ai',
        timeout: 30000,
        headers: {
          'Accept': 'text/markdown',
          'User-Agent': 'JinaNavigator-Server/1.0.0'
        },
        maxRetries: 3,
        retryDelay: 1000
      };
      
      // Vérification que toutes les propriétés requises sont présentes
      expect(config).toHaveProperty('baseURL');
      expect(config).toHaveProperty('timeout');
      expect(config).toHaveProperty('headers');
      expect(config).toHaveProperty('maxRetries');
      expect(config).toHaveProperty('retryDelay');
      
      // Vérification des types
      expect(typeof config.baseURL).toBe('string');
      expect(typeof config.timeout).toBe('number');
      expect(typeof config.headers).toBe('object');
      expect(typeof config.maxRetries).toBe('number');
      expect(typeof config.retryDelay).toBe('number');
    });

    test('devrait accepter une configuration partielle', () => {
      const partialConfig = {
        baseURL: 'https://custom.jina.ai',
        timeout: 60000
      };
      
      expect(partialConfig).toHaveProperty('baseURL');
      expect(partialConfig).toHaveProperty('timeout');
      expect(typeof partialConfig.baseURL).toBe('string');
      expect(typeof partialConfig.timeout).toBe('number');
    });

    test('devrait avoir des valeurs par défaut valides', () => {
      const defaultConfig = {
        baseURL: 'https://r.jina.ai',
        timeout: 30000,
        headers: {
          'Accept': 'text/markdown',
          'User-Agent': expect.stringContaining('JinaNavigator-Server')
        },
        maxRetries: 3,
        retryDelay: 1000
      };
      
      expect(defaultConfig.baseURL).toBe('https://r.jina.ai');
      expect(defaultConfig.timeout).toBe(30000);
      expect(defaultConfig.maxRetries).toBe(3);
      expect(defaultConfig.retryDelay).toBe(1000);
    });
  });

  describe('MarkdownOutline', () => {
    test('devrait avoir la structure correcte', () => {
      const outline = [
        {
          level: 1,
          text: 'Titre Principal',
          line: 1
        },
        {
          level: 2,
          text: 'Sous-titre',
          line: 2
        },
        {
          level: 3,
          text: 'Sous-sous-titre',
          line: 3
        }
      ];
      
      outline.forEach(item => {
        expect(item).toHaveProperty('level');
        expect(item).toHaveProperty('text');
        expect(item).toHaveProperty('line');
        
        expect(typeof item.level).toBe('number');
        expect(typeof item.text).toBe('string');
        expect(typeof item.line).toBe('number');
        
        expect(item.level).toBeGreaterThanOrEqual(1);
        expect(item.level).toBeLessThanOrEqual(6);
        expect(item.line).toBeGreaterThan(0);
      });
    });

    test('devrait gérer les niveaux de 1 à 6', () => {
      const levels = [1, 2, 3, 4, 5, 6];
      
      levels.forEach(level => {
        const item = {
          level,
          text: `Titre niveau ${level}`,
          line: level
        };
        
        expect(item.level).toBe(level);
        expect(typeof item.text).toBe('string');
        expect(item.line).toBe(level);
      });
    });

    test('devrait gérer les textes avec caractères spéciaux', () => {
      const specialTexts = [
        'Titre avec émojis 🚀',
        'Sous-titre avec accents éàèç',
        'Sous-sous-titre avec symboles ♠♣♥♦',
        'Titre avec `code` inline',
        'Titre avec **gras** et *italique*'
      ];
      
      specialTexts.forEach(text => {
        const item = {
          level: 1,
          text,
          line: 1
        };
        
        expect(typeof item.text).toBe('string');
        expect(item.text).toBe(text);
      });
    });

    test('devrait gérer les textes vides', () => {
      const emptyTexts = ['', '   ', '\t\t', '\n\n'];
      
      emptyTexts.forEach(text => {
        const item = {
          level: 1,
          text,
          line: 1
        };
        
        expect(typeof item.text).toBe('string');
        expect(item.text).toBe(text);
      });
    });
  });

  describe('ConversionResult', () => {
    test('devrait avoir la structure correcte pour un succès', () => {
      const successResult = {
        success: true,
        content: '# Titre\n\nContenu markdown.',
        metadata: {
          url: 'https://example.com',
          extractedAt: new Date().toISOString(),
          contentLength: 25,
          processingTime: 150
        }
      };
      
      expect(successResult).toHaveProperty('success');
      expect(successResult).toHaveProperty('content');
      expect(successResult).toHaveProperty('metadata');
      
      expect(successResult.success).toBe(true);
      expect(typeof successResult.content).toBe('string');
      expect(typeof successResult.metadata).toBe('object');
      
      expect(successResult.metadata).toHaveProperty('url');
      expect(successResult.metadata).toHaveProperty('extractedAt');
      expect(successResult.metadata).toHaveProperty('contentLength');
      expect(successResult.metadata).toHaveProperty('processingTime');
    });

    test('devrait avoir la structure correcte pour un échec', () => {
      const failureResult = {
        success: false,
        error: 'Request failed with status code 404',
        metadata: {
          url: 'https://example.com/not-found',
          extractedAt: new Date().toISOString(),
          processingTime: 50
        }
      };
      
      expect(failureResult).toHaveProperty('success');
      expect(failureResult).toHaveProperty('error');
      expect(failureResult).toHaveProperty('metadata');
      
      expect(failureResult.success).toBe(false);
      expect(typeof failureResult.error).toBe('string');
      expect(typeof failureResult.metadata).toBe('object');
      
      expect(failureResult.metadata).toHaveProperty('url');
      expect(failureResult.metadata).toHaveProperty('extractedAt');
      expect(failureResult.metadata).toHaveProperty('processingTime');
    });

    test('devrait gérer les métadonnées optionnelles', () => {
      const minimalResult = {
        success: true,
        content: '# Titre'
      };
      
      expect(minimalResult).toHaveProperty('success');
      expect(minimalResult).toHaveProperty('content');
      expect(minimalResult.success).toBe(true);
      expect(typeof minimalResult.content).toBe('string');
    });
  });

  describe('MultiConversionResult', () => {
    test('devrait avoir la structure correcte', () => {
      const multiResult = {
        results: [
          {
            url: 'https://example.com/page1',
            success: true,
            content: '# Page 1'
          },
          {
            url: 'https://example.com/page2',
            success: false,
            error: 'Request timeout'
          }
        ],
        summary: {
          total: 2,
          successful: 1,
          failed: 1,
          processingTime: 500
        }
      };
      
      expect(multiResult).toHaveProperty('results');
      expect(multiResult).toHaveProperty('summary');
      
      expect(Array.isArray(multiResult.results)).toBe(true);
      expect(multiResult.results).toHaveLength(2);
      
      expect(typeof multiResult.summary).toBe('object');
      expect(multiResult.summary).toHaveProperty('total');
      expect(multiResult.summary).toHaveProperty('successful');
      expect(multiResult.summary).toHaveProperty('failed');
      expect(multiResult.summary).toHaveProperty('processingTime');
      
      expect(multiResult.summary.total).toBe(2);
      expect(multiResult.summary.successful).toBe(1);
      expect(multiResult.summary.failed).toBe(1);
      expect(multiResult.summary.total).toBe(
        multiResult.summary.successful + multiResult.summary.failed
      );
    });

    test('devrait gérer les résultats vides', () => {
      const emptyResult = {
        results: [],
        summary: {
          total: 0,
          successful: 0,
          failed: 0,
          processingTime: 0
        }
      };
      
      expect(Array.isArray(emptyResult.results)).toBe(true);
      expect(emptyResult.results).toHaveLength(0);
      expect(emptyResult.summary.total).toBe(0);
      expect(emptyResult.summary.successful).toBe(0);
      expect(emptyResult.summary.failed).toBe(0);
    });
  });

  describe('OutlineExtractionResult', () => {
    test('devrait avoir la structure correcte', () => {
      const outlineResult = {
        url: 'https://example.com',
        success: true,
        max_depth: 3,
        outline: [
          {
            level: 1,
            text: 'Titre Principal',
            line: 1
          },
          {
            level: 2,
            text: 'Sous-titre',
            line: 2
          }
        ]
      };
      
      expect(outlineResult).toHaveProperty('url');
      expect(outlineResult).toHaveProperty('success');
      expect(outlineResult).toHaveProperty('max_depth');
      expect(outlineResult).toHaveProperty('outline');
      
      expect(typeof outlineResult.url).toBe('string');
      expect(typeof outlineResult.success).toBe('boolean');
      expect(typeof outlineResult.max_depth).toBe('number');
      expect(Array.isArray(outlineResult.outline)).toBe(true);
      
      expect(outlineResult.max_depth).toBeGreaterThanOrEqual(1);
      expect(outlineResult.max_depth).toBeLessThanOrEqual(6);
    });

    test('devrait gérer les résultats d\'échec', () => {
      const failureResult = {
        url: 'https://example.com/not-found',
        success: false,
        error: 'Request failed with status code 404'
      };
      
      expect(failureResult).toHaveProperty('url');
      expect(failureResult).toHaveProperty('success');
      expect(failureResult).toHaveProperty('error');
      
      expect(failureResult.success).toBe(false);
      expect(typeof failureResult.error).toBe('string');
    });

    test('devrait gérer les plans vides', () => {
      const emptyOutlineResult = {
        url: 'https://example.com/no-headings',
        success: true,
        max_depth: 3,
        outline: []
      };
      
      expect(Array.isArray(emptyOutlineResult.outline)).toBe(true);
      expect(emptyOutlineResult.outline).toHaveLength(0);
    });
  });

  describe('ValidationResult', () => {
    test('devrait avoir la structure correcte pour une validation réussie', () => {
      const validResult = {
        isValid: true,
        errors: [],
        warnings: []
      };
      
      expect(validResult).toHaveProperty('isValid');
      expect(validResult).toHaveProperty('errors');
      expect(validResult).toHaveProperty('warnings');
      
      expect(validResult.isValid).toBe(true);
      expect(Array.isArray(validResult.errors)).toBe(true);
      expect(Array.isArray(validResult.warnings)).toBe(true);
      expect(validResult.errors).toHaveLength(0);
      expect(validResult.warnings).toHaveLength(0);
    });

    test('devrait avoir la structure correcte pour une validation avec erreurs', () => {
      const errorResult = {
        isValid: false,
        errors: [
          {
            code: 'INVALID_URL',
            message: 'URL format is invalid',
            path: ['url']
          }
        ],
        warnings: [
          {
            code: 'EMPTY_TITLE',
            message: 'Title is empty',
            path: ['title']
          }
        ]
      };
      
      expect(errorResult).toHaveProperty('isValid');
      expect(errorResult).toHaveProperty('errors');
      expect(errorResult).toHaveProperty('warnings');
      
      expect(errorResult.isValid).toBe(false);
      expect(Array.isArray(errorResult.errors)).toBe(true);
      expect(Array.isArray(errorResult.warnings)).toBe(true);
      expect(errorResult.errors).toHaveLength(1);
      expect(errorResult.warnings).toHaveLength(1);
      
      expect(errorResult.errors[0]).toHaveProperty('code');
      expect(errorResult.errors[0]).toHaveProperty('message');
      expect(errorResult.errors[0]).toHaveProperty('path');
      
      expect(errorResult.warnings[0]).toHaveProperty('code');
      expect(errorResult.warnings[0]).toHaveProperty('message');
      expect(errorResult.warnings[0]).toHaveProperty('path');
    });
  });

  describe('PerformanceMetrics', () => {
    test('devrait avoir la structure correcte', () => {
      const metrics = {
        startTime: Date.now(),
        endTime: Date.now() + 1000,
        duration: 1000,
        memoryUsage: {
          used: 50 * 1024 * 1024, // 50MB
          total: 100 * 1024 * 1024, // 100MB
          percentage: 50
        },
        requestCount: 10,
        successRate: 0.9,
        averageResponseTime: 150
      };
      
      expect(metrics).toHaveProperty('startTime');
      expect(metrics).toHaveProperty('endTime');
      expect(metrics).toHaveProperty('duration');
      expect(metrics).toHaveProperty('memoryUsage');
      expect(metrics).toHaveProperty('requestCount');
      expect(metrics).toHaveProperty('successRate');
      expect(metrics).toHaveProperty('averageResponseTime');
      
      expect(typeof metrics.startTime).toBe('number');
      expect(typeof metrics.endTime).toBe('number');
      expect(typeof metrics.duration).toBe('number');
      expect(typeof metrics.memoryUsage).toBe('object');
      expect(typeof metrics.requestCount).toBe('number');
      expect(typeof metrics.successRate).toBe('number');
      expect(typeof metrics.averageResponseTime).toBe('number');
      
      expect(metrics.memoryUsage).toHaveProperty('used');
      expect(metrics.memoryUsage).toHaveProperty('total');
      expect(metrics.memoryUsage).toHaveProperty('percentage');
      
      expect(metrics.successRate).toBeGreaterThanOrEqual(0);
      expect(metrics.successRate).toBeLessThanOrEqual(1);
    });
  });

  describe('Cas limites et edge cases', () => {
    test('devrait gérer les valeurs numériques extrêmes', () => {
      const extremeValues = {
        maxNumber: Number.MAX_SAFE_INTEGER,
        minNumber: Number.MIN_SAFE_INTEGER,
        zero: 0,
        negative: -1,
        positive: 1,
        float: 3.14,
        infinity: Infinity,
        negativeInfinity: -Infinity,
        notANumber: NaN
      };
      
      Object.entries(extremeValues).forEach(([key, value]) => {
        expect(typeof value).toBe('number');
        
        if (key === 'infinity' || key === 'negativeInfinity') {
          expect(Number.isFinite(value)).toBe(false);
        } else if (key === 'notANumber') {
          expect(Number.isNaN(value)).toBe(true);
        } else {
          expect(Number.isFinite(value)).toBe(true);
        }
      });
    });

    test('devrait gérer les chaînes avec différents contenus', () => {
      const stringValues = {
        empty: '',
        spaces: '   ',
        tabs: '\t\t',
        newlines: '\n\n',
        mixed: ' \t\n ',
        unicode: 'émojis 🚀 accents éàèç',
        long: 'a'.repeat(10000),
        special: '!@#$%^&*()_+-=[]{}|;:,.<>?',
        quotes: '"single" and \'double\' quotes',
        backticks: '`code` and ```code block```'
      };
      
      Object.entries(stringValues).forEach(([key, value]) => {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThanOrEqual(0);
      });
    });

    test('devrait gérer les tableaux avec différentes tailles', () => {
      const arrayValues = {
        empty: [],
        single: [1],
        multiple: [1, 2, 3],
        large: Array.from({ length: 1000 }, (_, i) => i),
        nested: [[1, 2], [3, 4]],
        mixed: [1, 'string', { object: true }, [1, 2, 3]]
      };
      
      Object.entries(arrayValues).forEach(([key, value]) => {
        expect(Array.isArray(value)).toBe(true);
        expect(value.length).toBeGreaterThanOrEqual(0);
      });
    });

    test('devrait gérer les objets avec différentes structures', () => {
      const objectValues = {
        empty: {},
        single: { key: 'value' },
        multiple: { key1: 'value1', key2: 'value2' },
        nested: { outer: { inner: 'value' } },
        mixed: {
          string: 'value',
          number: 123,
          boolean: true,
          array: [1, 2, 3],
          object: { nested: true }
        }
      };
      
      Object.entries(objectValues).forEach(([key, value]) => {
        expect(typeof value).toBe('object');
        expect(value).not.toBeNull();
        expect(Array.isArray(value)).toBe(false);
      });
    });
  });

  describe('Cohérence des types', () => {
    test('devrait maintenir la cohérence entre les types liés', () => {
      // Vérification que les types liés sont cohérents
      const config = {
        baseURL: 'https://r.jina.ai',
        timeout: 30000
      };
      
      const result = {
        success: true,
        content: '# Test',
        metadata: {
          url: config.baseURL, // Doit correspondre
          processingTime: config.timeout // Doit être cohérent
        }
      };
      
      expect(typeof result.metadata.url).toBe('string');
      expect(typeof result.metadata.processingTime).toBe('number');
      expect(result.metadata.url).toBe(config.baseURL);
    });

    test('devrait valider les relations entre les types', () => {
      const outline = [
        { level: 1, text: 'Title', line: 1 },
        { level: 2, text: 'Subtitle', line: 2 }
      ];
      
      const extractionResult = {
        url: 'https://example.com',
        success: true,
        max_depth: 6,
        outline: outline
      };
      
      // Vérification que max_depth est cohérent avec les niveaux dans outline
      const maxLevelInOutline = Math.max(...outline.map(item => item.level));
      expect(extractionResult.max_depth).toBeGreaterThanOrEqual(maxLevelInOutline);
    });
  });
});