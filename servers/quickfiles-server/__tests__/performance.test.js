/**
 * Tests de performance pour le serveur QuickFiles
 * 
 * Ces tests vérifient les performances du serveur QuickFiles avec de grands volumes de données :
 * - Lecture de fichiers volumineux
 * - Lecture de nombreux fichiers
 * - Listage de répertoires avec beaucoup de fichiers
 * - Édition de fichiers volumineux
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');

// Simuler le serveur QuickFiles pour les tests unitaires
const { QuickFilesServer } = require('../build/index.js');

// Chemin vers le dossier de test temporaire (utilise un vrai répertoire temporaire)
const TEST_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'quickfiles-perf-'));

// Mocks pour les requêtes MCP
const mockRequest = (name, args) => ({
  params: {
    name,
    arguments: args
  }
});

// Fonction utilitaire pour créer un grand fichier
const createLargeFile = (size) => {
  let content = '';
  for (let i = 1; i <= size; i++) {
    content += `Ligne ${i} du fichier de test\n`;
  }
  return content;
};

// Fonction utilitaire pour mesurer le temps d'exécution
const measureExecutionTime = async (fn) => {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  const duration = Number(end - start) / 1_000_000; // en millisecondes
  return { result, duration };
};

describe('QuickFiles Server - Tests de Performance', () => {
  let server;
  
  // Configuration du système de fichiers réel avant tous les tests
  beforeAll(async () => {
    // Créer le répertoire de test
    await fs.mkdir(TEST_DIR, { recursive: true });
    
    // Créer un fichier très volumineux (100 000 lignes)
    await fs.writeFile(
      path.join(TEST_DIR, 'huge-file.txt'),
      createLargeFile(100000)
    );
    
    // Créer de nombreux fichiers (1000 fichiers)
    for (let i = 1; i <= 1000; i++) {
      await fs.writeFile(
        path.join(TEST_DIR, `file${i}.txt`),
        `Contenu du fichier ${i}\nDeuxième ligne\nTroisième ligne`
      );
    }
    
    // Créer une structure de répertoires profonde (sans référence circulaire)
    const deepDir = path.join(TEST_DIR, 'deep');
    await fs.mkdir(deepDir, { recursive: true });
    
    for (let i = 1; i <= 10; i++) {
      const dirPath = path.join(deepDir, `dir${i}`);
      await fs.mkdir(dirPath, { recursive: true });
      
      // Créer des sous-répertoires pour simuler une structure profonde
      let currentPath = dirPath;
      for (let depth = 1; depth <= 5; depth++) {
        const subDirPath = path.join(currentPath, `subdir${depth}`);
        await fs.mkdir(subDirPath, { recursive: true });
        
        // Ajouter des fichiers à chaque niveau
        for (let j = 1; j <= 10; j++) {
          await fs.writeFile(
            path.join(subDirPath, `file${j}.txt`),
            `Contenu du fichier ${j} dans le répertoire ${i} à la profondeur ${depth}`
          );
        }
        
        currentPath = subDirPath;
      }
    }
    
    // Créer un fichier pour les tests d'édition
    await fs.writeFile(
      path.join(TEST_DIR, 'edit-test.txt'),
      createLargeFile(10000)
    );
    
    // Créer une instance du serveur QuickFiles
    server = new QuickFilesServer();
  });
  
  // Nettoyer le système de fichiers réel après tous les tests
  afterAll(async () => {
    try {
      // Supprimer récursivement le répertoire de test
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch (error) {
      console.warn('Avertissement: Impossible de supprimer le répertoire de test:', error.message);
    }
  });

  // Tests de performance pour read_multiple_files
  describe('read_multiple_files - Performance', () => {
    test('devrait lire efficacement un fichier très volumineux', async () => {
      const request = mockRequest('read_multiple_files', {
        paths: [path.join(TEST_DIR, 'huge-file.txt')],
        max_lines_per_file: 1000 // Limiter pour ne pas surcharger la mémoire
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleReadMultipleFiles(request);
      });
      
      console.log(`Temps d'exécution pour lire un fichier de 100 000 lignes (limité à 1000): ${duration}ms`);
      expect(duration).toBeLessThan(2000); // Devrait prendre moins de 2 secondes
    });
    
    test('devrait lire efficacement de nombreux fichiers', async () => {
      // Créer un tableau de chemins pour 100 fichiers (sur les 1000 disponibles)
      const filePaths = [];
      for (let i = 1; i <= 100; i++) {
        filePaths.push(path.join(TEST_DIR, `file${i}.txt`));
      }
      
      const request = mockRequest('read_multiple_files', {
        paths: filePaths
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleReadMultipleFiles(request);
      });
      
      console.log(`Temps d'exécution pour lire 100 fichiers: ${duration}ms`);
      expect(duration).toBeLessThan(3000); // Devrait prendre moins de 3 secondes
    });
    
    test('devrait lire efficacement des extraits d\'un fichier volumineux', async () => {
      const request = mockRequest('read_multiple_files', {
        paths: [{
          path: path.join(TEST_DIR, 'huge-file.txt'),
          excerpts: [
            { start: 1000, end: 1010 },
            { start: 50000, end: 50010 },
            { start: 99000, end: 99010 }
          ]
        }]
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleReadMultipleFiles(request);
      });
      
      console.log(`Temps d'exécution pour lire des extraits d'un fichier de 100 000 lignes: ${duration}ms`);
      expect(duration).toBeLessThan(1000); // Devrait prendre moins de 1 seconde
    });
  });

  // Tests de performance pour list_directory_contents
  describe('list_directory_contents - Performance', () => {
    test('devrait lister efficacement un répertoire avec de nombreux fichiers', async () => {
      const request = mockRequest('list_directory_contents', {
        paths: [TEST_DIR],
        max_lines: 1000 // Limiter pour ne pas surcharger la sortie
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleListDirectoryContents(request);
      });
      
      console.log(`Temps d'exécution pour lister un répertoire avec 1000+ fichiers: ${duration}ms`);
      expect(duration).toBeLessThan(5000); // Devrait prendre moins de 5 secondes
    });
    
    test('devrait lister efficacement une structure de répertoires profonde', async () => {
      const request = mockRequest('list_directory_contents', {
        paths: [{
          path: path.join(TEST_DIR, 'deep'),
          recursive: true,
          max_depth: 3 // Limiter la profondeur pour éviter une sortie trop volumineuse
        }],
        max_lines: 1000 // Limiter pour ne pas surcharger la sortie
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleListDirectoryContents(request);
      });
      
      console.log(`Temps d'exécution pour lister une structure de répertoires profonde: ${duration}ms`);
      expect(duration).toBeLessThan(5000); // Devrait prendre moins de 5 secondes
    });
  });

  // Tests de performance pour edit_multiple_files
  describe('edit_multiple_files - Performance', () => {
    test('devrait éditer efficacement un fichier volumineux', async () => {
      const filePath = path.join(TEST_DIR, 'edit-test.txt');
      
      // Créer de nombreux diffs pour tester la performance
      const diffs = [];
      for (let i = 1; i <= 100; i++) {
        diffs.push({
          search: `Ligne ${i * 100} du fichier de test`,
          replace: `Ligne ${i * 100} modifiée`
        });
      }
      
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: filePath,
          diffs
        }]
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleEditMultipleFiles(request);
      });
      
      console.log(`Temps d'exécution pour appliquer 100 diffs à un fichier de 10 000 lignes: ${duration}ms`);
      expect(duration).toBeLessThan(5000); // Devrait prendre moins de 5 secondes
    });
  });

  // Tests de performance pour delete_files
  describe('delete_files - Performance', () => {
    test('devrait supprimer efficacement de nombreux fichiers', async () => {
      // Créer un tableau de chemins pour 100 fichiers (sur les 1000 disponibles)
      const filePaths = [];
      for (let i = 101; i <= 200; i++) {
        filePaths.push(path.join(TEST_DIR, `file${i}.txt`));
      }
      
      const request = mockRequest('delete_files', {
        paths: filePaths
      });
      
      const { duration } = await measureExecutionTime(async () => {
        return await server.handleDeleteFiles(request);
      });
      
      console.log(`Temps d'exécution pour supprimer 100 fichiers: ${duration}ms`);
      expect(duration).toBeLessThan(3000); // Devrait prendre moins de 3 secondes
    });
  });

  // Tests de performance pour les cas limites
  describe('Cas limites - Performance', () => {
    test('devrait gérer efficacement les limites de mémoire avec max_lines_per_file', async () => {
      const request = mockRequest('read_multiple_files', {
        paths: [path.join(TEST_DIR, 'huge-file.txt')],
        max_lines_per_file: 10000
      });
      
      const { duration, result } = await measureExecutionTime(async () => {
        return await server.handleReadMultipleFiles(request);
      });
      
      console.log(`Temps d'exécution pour lire 10 000 lignes d'un fichier de 100 000 lignes: ${duration}ms`);
      expect(duration).toBeLessThan(3000); // Devrait prendre moins de 3 secondes
      expect(result.content[0].text).toContain('lignes supplémentaires non affichées');
    });
    
    test('devrait gérer efficacement les limites de mémoire avec max_total_lines', async () => {
      // Créer un tableau de chemins pour 10 fichiers
      const filePaths = [];
      for (let i = 201; i <= 210; i++) {
        filePaths.push(path.join(TEST_DIR, `file${i}.txt`));
      }
      
      const request = mockRequest('read_multiple_files', {
        paths: filePaths,
        max_total_lines: 20
      });
      
      const { duration, result } = await measureExecutionTime(async () => {
        return await server.handleReadMultipleFiles(request);
      });
      
      // Utiliser process.stdout.write pour éviter les problèmes avec mock-fs
      process.stdout.write(`Temps d'exécution pour lire 10 fichiers avec max_total_lines=20: ${duration}ms\n`);
      expect(duration).toBeLessThan(1000); // Devrait prendre moins de 1 seconde
      // Vérifier que le contenu est tronqué (soit avec le message de troncature, soit par la longueur limitée)
      const hasTruncationMessage = result.content[0].text.includes('Certains fichiers ont été tronqués') ||
                                result.content[0].text.includes('lignes supplémentaires non affichées');
      expect(hasTruncationMessage).toBe(true);
    });
  });
});