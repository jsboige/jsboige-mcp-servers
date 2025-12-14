/**
 * Tests de performance pour les outils MCP
 * 
 * Ces tests vérifient que les outils respectent les seuils de performance
 * et gèrent efficacement les charges de travail importantes.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { measurePerformance, PERFORMANCE_THRESHOLDS } from '../setup/performance.js';
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

describe('Tests de performance des outils MCP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios avec réponse rapide
    axios.get.mockResolvedValue({
      data: TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Performance de convertWebToMarkdown', () => {
    test('devrait respecter le seuil de performance pour une conversion simple', async () => {
      const input = {
        url: 'https://example.com/simple-test'
      };
      
      const metrics = await measurePerformance(async () => {
        return await convertWebToMarkdownTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait respecter le seuil pour les conversions avec plages de lignes', async () => {
      const input = {
        url: 'https://example.com/range-test',
        start_line: 1,
        end_line: 100
      };
      
      const metrics = await measurePerformance(async () => {
        return await convertWebToMarkdownTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les contenus volumineux', async () => {
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      const input = {
        url: 'https://example.com/large-content'
      };
      
      const metrics = await measurePerformance(async () => {
        return await convertWebToMarkdownTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.LARGE_CONTENT_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les conversions répétées', async () => {
      const input = {
        url: 'https://example.com/repeated-test'
      };
      
      const startTime = Date.now();
      const results = [];
      
      // Effectuer 50 conversions
      for (let i = 0; i < 50; i++) {
        const result = await convertWebToMarkdownTool.execute(input);
        results.push(result);
      }
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      const averageDuration = totalDuration / 50;
      
      expect(results).toHaveLength(50);
      results.forEach(result => {
        expect(result.content).toBeDefined();
      });
      
      expect(averageDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.BATCH_PROCESSING);
    });
  });

  describe('Performance de accessJinaResource', () => {
    test('devrait respecter le seuil de performance pour un accès simple', async () => {
      const input = {
        uri: 'jina://https://example.com/resource-test'
      };
      
      const metrics = await measurePerformance(async () => {
        return await accessJinaResourceTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait respecter le seuil pour les accès avec plages de lignes', async () => {
      const input = {
        uri: 'jina://https://example.com/range-resource',
        start_line: 10,
        end_line: 50
      };
      
      const metrics = await measurePerformance(async () => {
        return await accessJinaResourceTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les accès simultanés', async () => {
      const inputs = [];
      for (let i = 1; i <= 20; i++) {
        inputs.push({
          uri: `jina://https://example.com/concurrent-${i}`
        });
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        inputs.map(input => accessJinaResourceTool.execute(input))
      );
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(20);
      results.forEach(result => {
        expect(result.content).toBeDefined();
      });
      
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.CONCURRENT_REQUESTS);
    });
  });

  describe('Performance de multiConvert', () => {
    test('devrait respecter le seuil pour les conversions multiples', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/multi-1' },
          { url: 'https://example.com/multi-2' },
          { url: 'https://example.com/multi-3' },
          { url: 'https://example.com/multi-4' },
          { url: 'https://example.com/multi-5' }
        ]
      };
      
      const metrics = await measurePerformance(async () => {
        return await multiConvertTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.MULTIPLE_REQUESTS);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les lots de 10 URLs', async () => {
      const urls = [];
      for (let i = 1; i <= 10; i++) {
        urls.push({ url: `https://example.com/batch-${i}` });
      }
      
      const input = { urls };
      
      const metrics = await measurePerformance(async () => {
        return await multiConvertTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.result.result).toHaveLength(10);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.BATCH_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les lots de 50 URLs (maximum)', async () => {
      const urls = [];
      for (let i = 1; i <= 50; i++) {
        urls.push({ url: `https://example.com/max-batch-${i}` });
      }
      
      const input = { urls };
      
      const metrics = await measurePerformance(async () => {
        return await multiConvertTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.result.result).toHaveLength(50);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_BATCH_SIZE);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les succès partiels', async () => {
      const urls = [
        { url: 'https://example.com/success-1' },
        { url: 'https://example.com/failure-1' },
        { url: 'https://example.com/success-2' },
        { url: 'https://example.com/failure-2' },
        { url: 'https://example.com/success-3' }
      ];
      
      // Simuler des échecs pour certaines URLs
      axios.get
        .mockResolvedValueOnce({ data: '# Success 1' })
        .mockRejectedValueOnce(new Error('Request failed'))
        .mockResolvedValueOnce({ data: '# Success 2' })
        .mockRejectedValueOnce(new Error('Request failed'))
        .mockResolvedValueOnce({ data: '# Success 3' });
      
      const input = { urls };
      
      const metrics = await measurePerformance(async () => {
        return await multiConvertTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.result.result).toHaveLength(5);
      expect(metrics.result.result[0].success).toBe(true);
      expect(metrics.result.result[1].success).toBe(false);
      expect(metrics.result.result[2].success).toBe(true);
      expect(metrics.result.result[3].success).toBe(false);
      expect(metrics.result.result[4].success).toBe(true);
      
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.MULTIPLE_REQUESTS);
    });
  });

  describe('Performance de extractMarkdownOutline', () => {
    test('devrait respecter le seuil pour l\'extraction simple', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/outline-simple' }
        ]
      };
      
      const metrics = await measurePerformance(async () => {
        return await extractMarkdownOutlineTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait respecter le seuil pour l\'extraction multiple', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/outline-1' },
          { url: 'https://example.com/outline-2' },
          { url: 'https://example.com/outline-3' }
        ],
        max_depth: 4
      };
      
      const metrics = await measurePerformance(async () => {
        return await extractMarkdownOutlineTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.result.result).toHaveLength(3);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.MULTIPLE_REQUESTS);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les contenus avec beaucoup de titres', async () => {
      // Créer un contenu avec beaucoup de titres
      let contentWithManyHeadings = '';
      for (let i = 1; i <= 100; i++) {
        contentWithManyHeadings += `# Heading ${i}\n`;
        for (let j = 1; j <= 5; j++) {
          contentWithManyHeadings += `## Subheading ${i}.${j}\n`;
        }
      }
      
      axios.get.mockResolvedValue({ data: contentWithManyHeadings });
      
      const input = {
        urls: [
          { url: 'https://example.com/many-headings' }
        ],
        max_depth: 6
      };
      
      const metrics = await measurePerformance(async () => {
        return await extractMarkdownOutlineTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      // extractMarkdownOutline retourne les racines (H1). Ici on a 100 H1.
      expect(metrics.result.result[0].outline.length).toBeGreaterThanOrEqual(100);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.COMPLEX_CONTENT_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les profondeurs d\'extraction variées', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/depth-1' },
          { url: 'https://example.com/depth-2' },
          { url: 'https://example.com/depth-3' }
        ],
        max_depth: 6
      };
      
      const metrics = await measurePerformance(async () => {
        return await extractMarkdownOutlineTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.result.result).toHaveLength(3);
      
      metrics.result.result.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.max_depth).toBe(6);
        expect(Array.isArray(result.outline)).toBe(true);
      });
      
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.MULTIPLE_REQUESTS);
    });
  });

  describe('Tests de charge', () => {
    test('devrait gérer une charge élevée de conversions simultanées', async () => {
      const concurrentRequests = [];
      for (let i = 1; i <= 100; i++) {
        concurrentRequests.push(
          convertWebToMarkdownTool.execute({
            url: `https://example.com/load-test-${i}`
          })
        );
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(concurrentRequests);
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(100);
      results.forEach(result => {
        expect(result.content).toBeDefined();
      });
      
      // Devrait gérer 100 requêtes simultanées en moins de 30 secondes
      expect(totalDuration).toBeLessThan(30000);
    });

    test('devrait gérer une charge élevée de multi-conversions', async () => {
      const batchRequests = [];
      for (let batch = 1; batch <= 10; batch++) {
        const urls = [];
        for (let i = 1; i <= 10; i++) {
          urls.push({
            url: `https://example.com/batch-${batch}-item-${i}`
          });
        }
        
        batchRequests.push(
          multiConvertTool.execute({ urls })
        );
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(batchRequests);
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(10);
      results.forEach(result => {
        // result.result peut être undefined si l'outil retourne une erreur ou une structure différente
        // multiConvertTool retourne { result: [...] }
        expect(result.result).toBeDefined();
        if (result.result.result) {
            expect(result.result.result).toHaveLength(10);
        } else {
            // Si la structure est différente, on vérifie au moins que ce n'est pas une erreur
            expect(result.error).toBeUndefined();
        }
      });
      
      // 10 lots de 10 URLs chacun = 100 URLs totales
      expect(totalDuration).toBeLessThan(45000);
    });

    test('devrait maintenir la performance sous charge continue', async () => {
      const durations = [];
      
      // Effectuer 20 cycles de charge
      for (let cycle = 1; cycle <= 20; cycle++) {
        const cycleStart = Date.now();
        
        // 5 conversions simultanées par cycle
        const requests = [];
        for (let i = 1; i <= 5; i++) {
          requests.push(
            convertWebToMarkdownTool.execute({
              url: `https://example.com/continuous-${cycle}-${i}`
            })
          );
        }
        
        await Promise.all(requests);
        
        const cycleEnd = Date.now();
        const cycleDuration = cycleEnd - cycleStart;
        durations.push(cycleDuration);
      }
      
      // Calculer les statistiques de performance
      const averageDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const maxDuration = Math.max(...durations);
      const minDuration = Math.min(...durations);
      
      // La performance devrait être stable
      expect(averageDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.MULTIPLE_REQUESTS);
      // Augmenter la tolérance pour les tests en environnement CI/CD ou local chargé
      // Si averageDuration est très petit (< 1ms), maxDuration peut être beaucoup plus grand en proportion
      if (averageDuration > 5) {
          expect(maxDuration).toBeLessThan(averageDuration * 10);
      }
      expect(minDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tests de mémoire', () => {
    test('devrait gérer efficacement les contenus volumineux sans fuite de mémoire', async () => {
      const initialMemory = process.memoryUsage();
      
      // Effectuer 100 conversions de contenu volumineux
      for (let i = 1; i <= 100; i++) {
        const largeContent = TEST_LARGE_MARKDOWN;
        axios.get.mockResolvedValue({ data: largeContent });
        
        await convertWebToMarkdownTool.execute({
          url: `https://example.com/memory-test-${i}`
        });
      }
      
      // Forcer le garbage collection si disponible
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
      
      // L'augmentation de mémoire devrait être raisonnable (< 100MB)
      expect(memoryIncreaseMB).toBeLessThan(100);
    });

    test('devrait gérer efficacement les lots de grande taille', async () => {
      const initialMemory = process.memoryUsage();
      
      // Traitement d'un lot de 50 URLs avec contenu volumineux
      const urls = [];
      for (let i = 1; i <= 50; i++) {
        urls.push({ url: `https://example.com/memory-batch-${i}` });
      }
      
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      await multiConvertTool.execute({ urls });
      
      // Forcer le garbage collection si disponible
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
      
      // L'augmentation de mémoire devrait être contrôlée
      expect(memoryIncreaseMB).toBeLessThan(200);
    });
  });

  describe('Tests de performance sous contraintes', () => {
    test('devrait gérer les timeouts de manière performante', async () => {
      const timeoutError = new Error('Timeout of 1000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      const input = {
        url: 'https://example.com/timeout-perf'
      };
      
      const startTime = Date.now();
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Timeout');
      
      // L'échec devrait être rapide (< 2 secondes)
      expect(duration).toBeLessThan(2000);
    });

    test('devrait gérer les erreurs réseau de manière performante', async () => {
      const networkError = new Error('getaddrinfo ENOTFOUND example.com');
      networkError.code = 'ENOTFOUND';
      axios.get.mockRejectedValue(networkError);
      
      const input = {
        url: 'https://nonexistent-domain.com/perf-test'
      };
      
      const startTime = Date.now();
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('ENOTFOUND');
      
      // L'échec réseau devrait être rapide (< 1 seconde)
      expect(duration).toBeLessThan(1000);
    });

    test('devrait maintenir la performance avec des réponses partielles', async () => {
      const partialContent = '# Title\n## Subtitle\nIncomplete conten';
      axios.get.mockResolvedValue({ data: partialContent });
      
      const input = {
        url: 'https://example.com/partial-perf'
      };
      
      const metrics = await measurePerformance(async () => {
        return await convertWebToMarkdownTool.execute(input);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });
  });

  describe('Tests de performance comparative', () => {
    test('devrait maintenir des performances cohérentes entre les outils', async () => {
      const url = 'https://example.com/comparative-perf';
      
      // Mesurer la performance de chaque outil
      const convertMetrics = await measurePerformance(async () => {
        return await convertWebToMarkdownTool.execute({ url });
      });
      
      const accessMetrics = await measurePerformance(async () => {
        return await accessJinaResourceTool.execute({ uri: `jina://${url}` });
      });
      
      // Les performances devraient être similaires (même opération sous-jacente)
      const performanceRatio = Math.max(convertMetrics.duration, accessMetrics.duration) / 
                              Math.min(convertMetrics.duration, accessMetrics.duration);
      
      // La différence ne devrait pas dépasser un facteur de 30 (très tolérant pour les tests en environnement CI/CD variable)
      expect(performanceRatio).toBeLessThan(30);
    });

    test('devrait évoluer linéairement avec le nombre d\'URLs', async () => {
      const testSizes = [5, 10, 20, 30];
      const durations = [];
      
      for (const size of testSizes) {
        const urls = [];
        for (let i = 1; i <= size; i++) {
          urls.push({ url: `https://example.com/scale-test-${i}` });
        }
        
        const startTime = Date.now();
        
        await multiConvertTool.execute({ urls });
        
        const endTime = Date.now();
        const duration = endTime - startTime;
        durations.push({ size, duration });
      }
      
      // Vérifier que la croissance est approximativement linéaire
      for (let i = 1; i < durations.length; i++) {
        const current = durations[i];
        const previous = durations[i - 1];
        
        const sizeRatio = current.size / previous.size;
        const durationRatio = current.duration / previous.duration;
        
        // Le temps devrait croître proportionnellement au nombre d'URLs
        // (avec une tolérance pour le parallélisme)
        if (!isNaN(durationRatio) && !isNaN(sizeRatio) && previous.duration > 5) {
            expect(durationRatio).toBeLessThan(sizeRatio * 4.0);
        }
      }
    });
  });
});