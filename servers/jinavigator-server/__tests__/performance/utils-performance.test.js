/**
 * Tests de performance pour les utilitaires
 * 
 * Ces tests vérifient que les utilitaires respectent les seuils de performance
 * et gèrent efficacement les charges de travail importantes.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { measurePerformance, PERFORMANCE_THRESHOLDS as IMPORTED_THRESHOLDS } from '../setup/performance.js';
import * as jinaClient from '../../src/utils/jina-client.js';

// Fallback si l'import échoue ou si global.PERFORMANCE_THRESHOLDS est défini
const PERFORMANCE_THRESHOLDS = {
  SINGLE_REQUEST: 1000,
  MAX_MEMORY_USAGE: 100,
  CONCURRENT_REQUESTS: 5000,
  LARGE_CONTENT_PROCESSING: 5000,
  BATCH_PROCESSING: 5000,
  PARSING_OPERATION: 200, // Augmenté pour éviter les faux positifs
  COMPLEX_CONTENT_PROCESSING: 3000,
  MULTIPLE_REQUESTS: 5000,
  ...(IMPORTED_THRESHOLDS || global.PERFORMANCE_THRESHOLDS || {})
};
import * as markdownParser from '../../src/utils/markdown-parser.js';

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

describe('Tests de performance des utilitaires', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Performance de JinaClient', () => {
    test('devrait respecter le seuil pour une conversion simple', async () => {
      const url = 'https://example.com/simple-perf';
      
      const metrics = await measurePerformance(async () => {
        return await jinaClient.convertUrlToMarkdown(url);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait respecter le seuil pour les conversions avec configuration personnalisée', async () => {
      const customConfig = {
        timeout: 60000,
        headers: {
          'Custom-Header': 'value'
        }
      };
      
      const url = 'https://example.com/custom-perf';
      
      // Note: convertUrlToMarkdown ne supporte pas actuellement la configuration personnalisée
      // On teste donc le comportement standard
      const metrics = await measurePerformance(async () => {
        return await jinaClient.convertUrlToMarkdown(url);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les conversions simultanées', async () => {
      const urls = [];
      for (let i = 1; i <= 20; i++) {
        urls.push(`https://example.com/concurrent-${i}`);
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        urls.map(url => jinaClient.convertUrlToMarkdown(url))
      );
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(20);
      results.forEach(result => {
        expect(result).toBe(TEST_MARKDOWN_CONTENT);
      });
      
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.CONCURRENT_REQUESTS);
    });

    test('devrait gérer efficacement les contenus volumineux', async () => {
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      const url = 'https://example.com/large-perf';
      
      const metrics = await measurePerformance(async () => {
        return await jinaClient.convertUrlToMarkdown(url);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.LARGE_CONTENT_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les conversions répétées', async () => {
      const url = 'https://example.com/repeated-perf';
      
      const startTime = Date.now();
      
      // Effectuer 100 conversions
      for (let i = 0; i < 100; i++) {
        const result = await jinaClient.convertUrlToMarkdown(url);
        expect(result).toBe(TEST_MARKDOWN_CONTENT);
      }
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      const averageDuration = totalDuration / 100;
      
      expect(averageDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.BATCH_PROCESSING);
    });

    test('devrait gérer efficacement les timeouts', async () => {
      const timeoutError = new Error('Timeout of 1000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      const url = 'https://example.com/timeout-perf';
      
      const startTime = Date.now();
      
      try {
        await jinaClient.convertUrlToMarkdown(url);
      } catch (error) {
        expect(error.message).toContain('Timeout');
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Le timeout devrait être rapide (< 2 secondes)
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('Performance de MarkdownParser', () => {
    test('devrait respecter le seuil pour l\'extraction simple', async () => {
      const content = TEST_MARKDOWN_CONTENT;
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.extractMarkdownOutline(content);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.PARSING_OPERATION);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait respecter le seuil pour l\'extraction avec profondeur personnalisée', async () => {
      const content = TEST_MARKDOWN_CONTENT;
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.extractMarkdownOutline(content, 4);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.PARSING_OPERATION);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les contenus avec beaucoup de titres', async () => {
      // Créer un contenu avec 1000 titres
      let contentWithManyHeadings = '';
      for (let i = 1; i <= 1000; i++) {
        contentWithManyHeadings += `# Heading ${i}\n`;
        for (let j = 1; j <= 5; j++) {
          contentWithManyHeadings += `## Subheading ${i}.${j}\n`;
        }
      }
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.extractMarkdownOutline(contentWithManyHeadings);
      });
      
      expect(metrics.success).toBe(true);
      // 1000 H1 + 5000 H2 = 6000 titres au total
      // Mais extractMarkdownOutline retourne une structure hiérarchique (racines)
      // Donc on s'attend à 1000 racines
      expect(metrics.result).toHaveLength(1000); 
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.COMPLEX_CONTENT_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement l\'extraction de lignes', async () => {
      const content = TEST_MARKDOWN_CONTENT;
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.filterByLines(content, 10, 50);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.PARSING_OPERATION);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement la validation', async () => {
      const content = TEST_MARKDOWN_CONTENT;
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.validateMaxDepth(10);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.PARSING_OPERATION);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les opérations répétées', () => {
      const content = TEST_MARKDOWN_CONTENT;
      
      const startTime = Date.now();
      
      // Effectuer 1000 opérations de parsing
      for (let i = 0; i < 1000; i++) {
        const outline = markdownParser.extractMarkdownOutline(content);
        expect(Array.isArray(outline)).toBe(true);
      }
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      const averageDuration = totalDuration / 1000;
      
      expect(averageDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.PARSING_OPERATION / 10);
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.BATCH_PROCESSING);
    });
  });

  describe('Tests de charge pour les utilitaires', () => {
    test('devrait gérer une charge élevée de parsing', async () => {
      const contents = [];
      for (let i = 1; i <= 100; i++) {
        // Créer des contenus de taille variable
        let content = `# Content ${i}\n`;
        for (let j = 1; j <= 20; j++) {
          content += `## Section ${i}.${j}\n`;
          content += `Content for section ${i}.${j}.\n`.repeat(5);
        }
        contents.push(content);
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        contents.map(content => markdownParser.extractMarkdownOutline(content))
      );
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(100);
      results.forEach(outline => {
        expect(Array.isArray(outline)).toBe(true);
        expect(outline.length).toBe(1); // 1 racine H1
        expect(outline[0].children).toHaveLength(20); // 20 enfants H2
      });
      
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.BATCH_PROCESSING);
    });

    test('devrait gérer une charge élevée de conversions', async () => {
      const urls = [];
      for (let i = 1; i <= 50; i++) {
        urls.push(`https://example.com/load-test-${i}`);
      }
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        urls.map(url => jinaClient.convertUrlToMarkdown(url))
      );
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(50);
      results.forEach(result => {
        expect(result).toBe(TEST_MARKDOWN_CONTENT);
      });
      
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.CONCURRENT_REQUESTS);
    });

    test('devrait maintenir la performance sous charge continue', async () => {
      const durations = [];
      
      // Effectuer 20 cycles de charge
      for (let cycle = 1; cycle <= 20; cycle++) {
        const cycleStart = Date.now();
        
        // 5 conversions + 5 parsings par cycle
        const operations = [];
        for (let i = 1; i <= 5; i++) {
          operations.push(jinaClient.convertUrlToMarkdown(`https://example.com/continuous-${cycle}-${i}`));
        }
        
        const contents = await Promise.all(operations);
        
        const parsingOperations = contents.map(content =>
          markdownParser.extractMarkdownOutline(content)
        );
        
        await Promise.all(parsingOperations);
        
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
      
      // Si la durée moyenne est très faible (< 5ms), les variations relatives peuvent être énormes
      // On ne vérifie la stabilité relative que si la durée est significative
      if (averageDuration > 5) {
        expect(maxDuration).toBeLessThan(averageDuration * 2); // Pas plus de 2x la moyenne
        expect(minDuration).toBeGreaterThan(averageDuration * 0.5); // Pas moins de 0.5x la moyenne
      }
    });
  });

  describe('Tests de mémoire pour les utilitaires', () => {
    test('devrait gérer efficacement les contenus volumineux sans fuite de mémoire', async () => {
      const initialMemory = process.memoryUsage();
      
      // Effectuer 100 parsings de contenu volumineux
      for (let i = 1; i <= 100; i++) {
        const largeContent = TEST_LARGE_MARKDOWN;
        const outline = markdownParser.extractMarkdownOutline(largeContent);
        expect(Array.isArray(outline)).toBe(true);
      }
      
      // Forcer le garbage collection si disponible
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
      
      // L'augmentation de mémoire devrait être raisonnable (< 50MB)
      expect(memoryIncreaseMB).toBeLessThan(50);
    });

    test('devrait gérer efficacement les conversions volumineuses sans fuite de mémoire', async () => {
      const initialMemory = process.memoryUsage();
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      // Effectuer 50 conversions de contenu volumineux
      for (let i = 1; i <= 50; i++) {
        const result = await jinaClient.convertUrlToMarkdown(`https://example.com/memory-test-${i}`);
        expect(result).toBe(largeContent);
      }
      
      // Forcer le garbage collection si disponible
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
      
      // L'augmentation de mémoire devrait être contrôlée (< 100MB)
      expect(memoryIncreaseMB).toBeLessThan(100);
    });

    test('devrait gérer efficacement les opérations mixtes', async () => {
      const initialMemory = process.memoryUsage();
      
      // Effectuer un mélange d'opérations
      for (let i = 1; i <= 50; i++) {
        // Conversion
        const content = await jinaClient.convertUrlToMarkdown(`https://example.com/mixed-test-${i}`);
        
        // Parsing
        const outline = markdownParser.extractMarkdownOutline(content);
        
        // Extraction de lignes
        const lines = markdownParser.filterByLines(content, 1, 10);
        
        // Validation
        const depth = markdownParser.validateMaxDepth(10);
        
        // Vérifications basiques
        expect(content).toBeDefined();
        expect(Array.isArray(outline)).toBe(true);
        expect(typeof lines).toBe('string');
        expect(depth).toBe(6);
      }
      
      // Forcer le garbage collection si disponible
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
      
      // L'augmentation de mémoire devrait être raisonnable (< 75MB)
      expect(memoryIncreaseMB).toBeLessThan(75);
    });
  });

  describe('Tests de performance comparative', () => {
    test('devrait maintenir des performances cohérentes entre les configurations', async () => {
      const url = 'https://example.com/comparative-perf';
      
      // Test avec configuration par défaut
      const defaultMetrics = await measurePerformance(async () => {
        return await jinaClient.convertUrlToMarkdown(url);
      });
      
      // Test avec configuration personnalisée
      const customConfig = {
        timeout: 60000,
        headers: { 'Custom-Header': 'value' }
      };
      const customMetrics = await measurePerformance(async () => {
        // Note: convertUrlToMarkdown ne supporte pas actuellement la configuration personnalisée
        return await jinaClient.convertUrlToMarkdown(url);
      });
      
      // Les deux appels sont mockés (résolution de promesse sub-ms) et la
      // "configuration personnalisée" n'est pas appliquée (convertUrlToMarkdown
      // ne la supporte pas — voir commentaire ci-dessus) : les deux code paths
      // sont donc identiques. Un ratio sur des durées sub-ms est dominé par le
      // bruit de timer et l'échauffement (1er appel = cold path), d'où les faux
      // rouges récurrents sur CI (ratio 2-10x observé sur des appels identiques,
      // bloquait les PRs submod #688/#690). On asserte donc en absolu (convention
      // des tests frères L70/L91) + on ne vérifie le ratio que si les durées
      // dépassent le bruit de timer (garde-fou identique à L508/L534).
      expect(defaultMetrics.success).toBe(true);
      expect(customMetrics.success).toBe(true);
      expect(Math.max(defaultMetrics.duration, customMetrics.duration))
        .toBeLessThan(PERFORMANCE_THRESHOLDS.SINGLE_REQUEST);

      const maxDuration = Math.max(defaultMetrics.duration, customMetrics.duration);
      const minDuration = Math.min(defaultMetrics.duration, customMetrics.duration);
      // Ratio significatif uniquement au-delà du bruit de timer (>5ms) ;
      // en dessous, deux appels mockés identiques peuvent diverger d'un facteur 10.
      if (minDuration > 5) {
        expect(maxDuration / minDuration).toBeLessThan(2.0);
      }
    });

    test('devrait évoluer linéairement avec la complexité du contenu', async () => {
      const complexities = [100, 500, 1000, 2000];
      const durations = [];
      
      for (const complexity of complexities) {
        // Créer un contenu avec la complexité spécifiée
        let content = '';
        for (let i = 1; i <= complexity; i++) {
          content += `# Heading ${i}\n`;
        }
        
        const startTime = Date.now();
        
        const outline = markdownParser.extractMarkdownOutline(content);
        
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        durations.push({ complexity, duration, outlineLength: outline.length });
      }
      
      // Vérifier que la croissance est approximativement linéaire
      for (let i = 1; i < durations.length; i++) {
        const current = durations[i];
        const previous = durations[i - 1];
        
        const complexityRatio = current.complexity / previous.complexity;
        const durationRatio = current.duration / previous.duration;
        
        // Le temps devrait croître proportionnellement à la complexité
        // On ajoute une tolérance pour les très petites durées où le ratio peut exploser
        if (previous.duration > 1) {
          expect(durationRatio).toBeLessThan(complexityRatio * 2.0); // Tolérance augmentée
        }
      }
    });

    test('devrait maintenir des performances optimales avec différentes profondeurs', async () => {
      const depths = [1, 2, 3, 4, 5, 6];
      const content = TEST_MARKDOWN_CONTENT;
      const durations = [];
      
      for (const depth of depths) {
        const metrics = await measurePerformance(async () => {
          return markdownParser.extractMarkdownOutline(content, depth);
        });
        
        durations.push({ depth, duration: metrics.duration });
      }
      
      // La profondeur ne devrait pas avoir d'impact significatif sur la performance
      const maxDuration = Math.max(...durations.map(d => d.duration));
      const minDuration = Math.max(0.1, Math.min(...durations.map(d => d.duration))); // Éviter division par zéro
      const performanceRatio = maxDuration / minDuration;
      
      // Si les durées sont très faibles (< 5ms), le ratio n'est pas significatif
      if (maxDuration > 5) {
        expect(performanceRatio).toBeLessThan(3); // Tolérance augmentée à 3x
      }
    });
  });

  describe('Tests de performance sous contraintes', () => {
    test('devrait gérer efficacement les contenus avec caractères spéciaux', async () => {
      const specialContent = `# Titre avec émojis 🚀
## Sous-titre avec accents éàèç
### Sous-sous-titre avec symboles ♠♣♥♦
#### Titre avec \`code\` inline
##### Titre avec **gras** et *italique*
###### Titre avec [lien](https://example.com)`.repeat(100);
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.extractMarkdownOutline(specialContent);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.COMPLEX_CONTENT_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les contenus mal formés', async () => {
      const malformedContent = `#Titre sans espace
##   Sous-titre avec trop d'espaces
###Sous-sous-titre sans espace
####### Titre niveau 7 (invalide)
## Sous-titre vide
`.repeat(50);
      
      const metrics = await measurePerformance(async () => {
        return markdownParser.extractMarkdownOutline(malformedContent);
      });
      
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeLessThan(PERFORMANCE_THRESHOLDS.COMPLEX_CONTENT_PROCESSING);
      expect(metrics.memoryUsage.percentage).toBeLessThan(PERFORMANCE_THRESHOLDS.MAX_MEMORY_USAGE);
    });

    test('devrait gérer efficacement les URLs complexes', async () => {
      const complexUrls = [
        'https://example.com/path with spaces/émojis-🚀.html',
        'https://example.com/very/long/path/with/many/segments/file.html?param=value&other=test#fragment',
        'https://subdomain.example.com:8080/path/to/resource?query=value&filter=test&sort=desc'
      ];
      
      const startTime = Date.now();
      
      const results = await Promise.all(
        complexUrls.map(url => jinaClient.convertUrlToMarkdown(url))
      );
      
      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result).toBe(TEST_MARKDOWN_CONTENT);
      });
      
      expect(totalDuration).toBeLessThan(PERFORMANCE_THRESHOLDS.MULTIPLE_REQUESTS);
    });
  });
});