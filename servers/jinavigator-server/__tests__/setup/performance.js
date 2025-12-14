/**
 * Configuration pour les tests de performance
 * 
 * Ce fichier contient la configuration globale pour les tests de performance
 * du serveur JinaNavigator, y compris les utilitaires de mesure
 * et les seuils de performance.
 */

import { jest } from '@jest/globals';

// Configuration du timeout pour les tests de performance
jest.setTimeout(60000);

// Seuils de performance (en millisecondes)
export const PERFORMANCE_THRESHOLDS = {
  SINGLE_REQUEST: 1000,         // 1 seconde pour une requête simple
  SINGLE_CONVERSION: 1000,      // 1 seconde pour une conversion simple
  LARGE_CONVERSION: 5000,       // 5 secondes pour une conversion volumineuse
  LARGE_CONTENT_PROCESSING: 5000, // Alias pour LARGE_CONVERSION
  MULTIPLE_REQUESTS: 5000,      // 5 secondes pour des requêtes multiples
  MULTI_CONVERSION_10: 2000,    // 2 secondes pour 10 conversions en parallèle
  MULTI_CONVERSION_50: 5000,    // 5 secondes pour 50 conversions en parallèle
  BATCH_PROCESSING: 5000,       // Alias pour MULTI_CONVERSION_50
  MAX_BATCH_SIZE: 10000,        // 10 secondes pour un lot maximum
  OUTLINE_EXTRACTION: 2000,     // 2 secondes pour l'extraction de plan
  COMPLEX_CONTENT_PROCESSING: 3000, // 3 secondes pour contenu complexe
  FILTERING: 500,               // 500ms pour le filtrage par lignes
  CONCURRENT_REQUESTS: 5000,    // 5 secondes pour requêtes simultanées
  CONCURRENT_REQUESTS_20: 5000, // Alias
  MAX_MEMORY_USAGE: 100         // 100 MB d'augmentation max
};

// Utilitaires de mesure de performance
export const measureExecutionTime = async (fn) => {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  const duration = end - start; // en millisecondes
  return { result, duration };
};

export const measureMemoryUsage = async (fn) => {
  const initialMemory = process.memoryUsage();
  const result = await fn();
  
  // Forcer le garbage collection si disponible pour une mesure plus précise
  if (global.gc) {
    global.gc();
  }
  
  const finalMemory = process.memoryUsage();
  
  return {
    result,
    memoryUsage: {
      heapUsed: finalMemory.heapUsed - initialMemory.heapUsed,
      heapTotal: finalMemory.heapTotal - initialMemory.heapTotal,
      external: finalMemory.external - initialMemory.external,
      rss: finalMemory.rss - initialMemory.rss,
      percentage: (finalMemory.heapUsed - initialMemory.heapUsed) / (1024 * 1024) // En MB pour simplifier la comparaison avec le seuil
    }
  };
};

export const measurePerformance = async (fn) => {
  const initialMemory = process.memoryUsage();
  const start = performance.now();
  
  let result;
  let success = true;
  let error;
  
  try {
    result = await fn();
  } catch (e) {
    success = false;
    error = e;
  }
  
  const end = performance.now();
  const duration = end - start; // en millisecondes
  
  // Forcer le garbage collection si disponible
  if (global.gc) {
    global.gc();
  }
  
  const finalMemory = process.memoryUsage();
  const memoryDiff = finalMemory.heapUsed - initialMemory.heapUsed;
  
  return {
    result,
    success,
    error,
    duration,
    memoryUsage: {
      heapUsed: memoryDiff,
      percentage: Math.max(0, memoryDiff / (1024 * 1024)) // En MB, min 0
    }
  };
};

export const createLargeMarkdown = (sectionCount = 1000) => {
  let content = '# Grand document Markdown\n\n';
  for (let i = 1; i <= sectionCount; i++) {
    content += `## Section ${i}\n\n`;
    content += `Ceci est le contenu de la section ${i}.\n\n`;
    content += `- Élément ${i}.1\n`;
    content += `- Élément ${i}.2\n`;
    content += `- Élément ${i}.3\n\n`;
    
    // Ajouter des sous-sections
    if (i % 10 === 0) {
      content += `### Sous-section ${i}\n\n`;
      content += `Contenu détaillé de la sous-section ${i}.\n\n`;
    }
  }
  return content;
};

export const createComplexMarkdown = () => {
  let content = '# Document Complexe\n\n';
  
  for (let i = 1; i <= 50; i++) {
    content += `## Section Niveau 2 - ${i}\n\n`;
    
    for (let j = 1; j <= 5; j++) {
      content += `### Section Niveau 3 - ${i}.${j}\n\n`;
      
      for (let k = 1; k <= 3; k++) {
        content += `#### Section Niveau 4 - ${i}.${j}.${k}\n\n`;
        content += `Contenu de la section de niveau 4.\n\n`;
      }
    }
  }
  
  return content;
};

export const assertPerformanceThreshold = (duration, threshold, operation) => {
  if (duration > threshold) {
    throw new Error(
      `Performance threshold exceeded for ${operation}: ` +
      `${duration}ms > ${threshold}ms`
    );
  }
};

export const assertMemoryUsage = (memoryUsage, maxHeapIncrease = 50 * 1024 * 1024) => {
  if (memoryUsage.heapUsed > maxHeapIncrease) {
    throw new Error(
      `Memory usage threshold exceeded: ` +
      `${memoryUsage.heapUsed} bytes > ${maxHeapIncrease} bytes`
    );
  }
};

// Fonctions pour générer des charges de test
export const generateUrlList = (count, baseUrl = 'https://example.com') => {
  return Array.from({ length: count }, (_, i) => ({
    url: `${baseUrl}/page${i + 1}`
  }));
};

export const generateUrlListWithBounds = (count, baseUrl = 'https://example.com') => {
  return Array.from({ length: count }, (_, i) => ({
    url: `${baseUrl}/page${i + 1}`,
    start_line: (i + 1) * 10,
    end_line: (i + 1) * 10 + 20
  }));
};

// Exporter aussi en global pour compatibilité
global.PERFORMANCE_THRESHOLDS = PERFORMANCE_THRESHOLDS;
global.measureExecutionTime = measureExecutionTime;
global.measureMemoryUsage = measureMemoryUsage;
global.measurePerformance = measurePerformance;
global.createLargeMarkdown = createLargeMarkdown;
global.createComplexMarkdown = createComplexMarkdown;
global.assertPerformanceThreshold = assertPerformanceThreshold;
global.assertMemoryUsage = assertMemoryUsage;
global.generateUrlList = generateUrlList;
global.generateUrlListWithBounds = generateUrlListWithBounds;

// Nettoyage après chaque test
afterEach(() => {
  // Forcer le garbage collection si disponible
  if (global.gc) {
    global.gc();
  }
});