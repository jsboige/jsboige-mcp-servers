/**
 * TESTS ANTI-RÉGRESSION CRITIQUES
 * 
 * Ces tests détectent automatiquement les stubs et les implémentations manquantes.
 * 
 * CONTEXTE : Suite à la régression critique du commit 0d7becf où 80% des outils
 * ont été remplacés par des stubs, ces tests garantissent qu'aucun outil ne peut
 * être committé sans implémentation réelle.
 * 
 * @critical Ces tests DOIVENT passer avant tout commit
 */

const fs = require('fs/promises');
const path = require('path');
const mockFs = require('mock-fs');

// Simuler le serveur QuickFiles pour les tests unitaires
const { QuickFilesServer } = require('../build/index.js');

// Obtenir le chemin du répertoire actuel
const currentFilename = __filename;

// Liste des 8 outils qui ont été affectés par la régression
const CRITICAL_TOOLS = [
  'handleDeleteFiles',
  'handleEditMultipleFiles',
  'handleExtractMarkdownStructure',
  'handleCopyFiles',
  'handleMoveFiles',
  'handleSearchInFiles',
  'handleSearchAndReplace',
  'handleRestartMcpServers'
];

// Tous les outils du serveur
const ALL_TOOLS = [
  'handleReadMultipleFiles',
  'handleListDirectoryContents',
  ...CRITICAL_TOOLS
];

describe('🚨 ANTI-RÉGRESSION: Détection des Stubs', () => {
  let server;
  
  beforeAll(() => {
    server = new QuickFilesServer();
  });

  describe('Vérification des implémentations', () => {
    CRITICAL_TOOLS.forEach(toolName => {
      test(`${toolName} NE DOIT PAS être un stub`, () => {
        const method = server[toolName];
        
        // Vérifier que la méthode existe
        expect(method).toBeDefined();
        expect(typeof method).toBe('function');
        
        // Obtenir le code source de la méthode
        const code = method.toString();
        
        // Vérifications anti-stub
        expect(code).not.toContain('Not implemented');
        expect(code).not.toContain('TODO: implement');
        expect(code).not.toContain('stub');
        expect(code).not.toContain('STUB');
        
        // Un stub est généralement très court (< 100 caractères)
        // Les vraies implémentations sont plus longues
        expect(code.length).toBeGreaterThan(200);
        
        // Vérifier qu'il y a une vraie logique (try/catch, boucles, etc.)
        const hasRealLogic = 
          code.includes('try') || 
          code.includes('for') ||
          code.includes('await') ||
          code.includes('Promise');
        
        expect(hasRealLogic).toBe(true);
      });
    });
  });

  describe('Vérification de la signature des méthodes', () => {
    ALL_TOOLS.forEach(toolName => {
      test(`${toolName} doit avoir la signature correcte`, () => {
        const method = server[toolName];
        
        // Vérifier que c'est une fonction async
        expect(method.constructor.name).toBe('AsyncFunction');
        
        // Vérifier qu'elle accepte au moins 1 paramètre (request)
        expect(method.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Tests fonctionnels de non-régression', () => {
    const TEST_DIR = path.join(__dirname, 'anti-regression-temp');
    
    beforeEach(() => {
      // Créer un système de fichiers simulé
      mockFs({
        [TEST_DIR]: {
          'test-file.txt': 'Contenu de test\nLigne 2\nLigne 3',
          'test-file-2.txt': 'Autre contenu',
          'test-delete.txt': 'À supprimer',
          'subdir': {
            'nested-file.txt': 'Fichier imbriqué'
          }
        }
      });
    });
    
    afterEach(() => {
      mockFs.restore();
    });

    test('delete_files doit vraiment supprimer les fichiers', async () => {
      const filePath = path.join(TEST_DIR, 'test-delete.txt');
      
      // Vérifier que le fichier existe
      await expect(fs.access(filePath)).resolves.not.toThrow();
      
      // Supprimer le fichier
      const request = {
        params: {
          name: 'delete_files',
          arguments: { paths: [filePath] }
        }
      };
      
      const response = await server.handleDeleteFiles(request);
      
      // Vérifier la réponse
      expect(response.content[0].text).toContain('SUCCES');
      expect(response.content[0].text).toContain(filePath);
      
      // Vérifier que le fichier est vraiment supprimé
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    test('edit_multiple_files doit vraiment modifier les fichiers', async () => {
      const filePath = path.join(TEST_DIR, 'test-file.txt');
      
      // Lire le contenu initial
      const initialContent = await fs.readFile(filePath, 'utf-8');
      expect(initialContent).toContain('Ligne 2');
      
      // Modifier le fichier
      const request = {
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [{
              path: filePath,
              diffs: [{
                search: 'Ligne 2',
                replace: 'Ligne modifiée'
              }]
            }]
          }
        }
      };
      
      const response = await server.handleEditMultipleFiles(request);
      
      // Vérifier la réponse
      expect(response.content[0].text).toContain('SUCCES');
      expect(response.content[0].text).toContain('1 modification');
      
      // Vérifier que le fichier est vraiment modifié
      const modifiedContent = await fs.readFile(filePath, 'utf-8');
      expect(modifiedContent).not.toContain('Ligne 2');
      expect(modifiedContent).toContain('Ligne modifiée');
    });

    test('copy_files doit vraiment copier les fichiers', async () => {
      const sourcePath = path.join(TEST_DIR, 'test-file.txt');
      const destPath = path.join(TEST_DIR, 'test-file-copy.txt');
      
      // Vérifier que la destination n'existe pas
      await expect(fs.access(destPath)).rejects.toThrow();
      
      // Copier le fichier
      const request = {
        params: {
          name: 'copy_files',
          arguments: {
            operations: [{
              source: sourcePath,
              destination: destPath
            }]
          }
        }
      };
      
      const response = await server.handleCopyFiles(request);
      
      // Vérifier la réponse
      expect(response.content[0].text).toContain('copié');
      
      // Vérifier que le fichier est vraiment copié
      await expect(fs.access(destPath)).resolves.not.toThrow();
      const copiedContent = await fs.readFile(destPath, 'utf-8');
      const originalContent = await fs.readFile(sourcePath, 'utf-8');
      expect(copiedContent).toBe(originalContent);
    });

    test('move_files doit vraiment déplacer les fichiers', async () => {
      const sourcePath = path.join(TEST_DIR, 'test-file-2.txt');
      const destPath = path.join(TEST_DIR, 'subdir', 'test-file-moved.txt');
      
      // Vérifier que la source existe
      await expect(fs.access(sourcePath)).resolves.not.toThrow();
      
      // Déplacer le fichier
      const request = {
        params: {
          name: 'move_files',
          arguments: {
            operations: [{
              source: sourcePath,
              destination: destPath
            }]
          }
        }
      };
      
      const response = await server.handleMoveFiles(request);
      
      // Vérifier la réponse
      expect(response.content[0].text).toContain('déplacé');
      
      // Vérifier que le fichier source n'existe plus
      await expect(fs.access(sourcePath)).rejects.toThrow();
      
      // Vérifier que le fichier destination existe
      await expect(fs.access(destPath)).resolves.not.toThrow();
    });

    test('search_in_files doit vraiment rechercher dans les fichiers', async () => {
      const request = {
        params: {
          name: 'search_in_files',
          arguments: {
            paths: [TEST_DIR],
            pattern: 'Ligne 2',
            recursive: true
          }
        }
      };
      
      const response = await server.handleSearchInFiles(request);
      
      // Vérifier que la recherche trouve le texte
      expect(response.content[0].text).toContain('Ligne 2');
      expect(response.content[0].text).toContain('test-file.txt');
    });

    test('search_and_replace doit vraiment effectuer les remplacements', async () => {
      const filePath = path.join(TEST_DIR, 'test-file.txt');
      
      // Lire le contenu initial
      const initialContent = await fs.readFile(filePath, 'utf-8');
      expect(initialContent).toContain('Contenu de test');
      
      // Effectuer le remplacement
      const request = {
        params: {
          name: 'search_and_replace',
          arguments: {
            paths: [TEST_DIR],
            search: 'Contenu de test',
            replace: 'Contenu remplacé',
            recursive: true
          }
        }
      };
      
      const response = await server.handleSearchAndReplace(request);
      
      // Vérifier la réponse
      expect(response.content[0].text).toContain('Effectué');
      expect(response.content[0].text).toContain('remplacement');
      
      // Vérifier que le fichier est vraiment modifié
      const modifiedContent = await fs.readFile(filePath, 'utf-8');
      expect(modifiedContent).not.toContain('Contenu de test');
      expect(modifiedContent).toContain('Contenu remplacé');
    });
  });

  describe('Vérification des schémas Zod', () => {
    test('Tous les outils doivent avoir des schémas de validation', () => {
      // Vérifier que les schémas existent dans le code source
      const fs = require('fs');
      const srcPath = path.join(__dirname, '..', 'src', 'index.ts');
      const sourceCode = fs.readFileSync(srcPath, 'utf-8');
      
      // Vérifier la présence des schémas Zod pour chaque outil critique
      const criticalSchemas = [
        'DeleteFilesArgsSchema',
        'EditMultipleFilesArgsSchema',
        'ExtractMarkdownStructureArgsSchema',
        'CopyFilesArgsSchema',
        'MoveFilesArgsSchema',
        'SearchInFilesArgsSchema',
        'SearchAndReplaceArgsSchema',
        'RestartMcpServersArgsSchema'
      ];
      
      criticalSchemas.forEach(schemaName => {
        expect(sourceCode).toContain(schemaName);
      });
    });
  });

  describe('Métriques de qualité', () => {
    test('Les méthodes critiques doivent avoir une complexité raisonnable', () => {
      CRITICAL_TOOLS.forEach(toolName => {
        const method = server[toolName];
        const code = method.toString();
        
        // Compter les branches (if, else, for, while, case, catch, &&, ||)
        const branchCount = (code.match(/\b(if|else|for|while|case|catch)\b|\&\&|\|\|/g) || []).length;
        
        // Complexité cyclomatique acceptable : < 20
        expect(branchCount).toBeLessThan(20);
      });
    });

    test('Les méthodes critiques doivent avoir une gestion d\'erreurs', () => {
      CRITICAL_TOOLS.forEach(toolName => {
        const method = server[toolName];
        const code = method.toString();
        
        // Vérifier la présence de try/catch ou de gestion d'erreurs
        const hasErrorHandling = 
          code.includes('try') || 
          code.includes('catch') ||
          code.includes('error') ||
          code.includes('Error');
        
        expect(hasErrorHandling).toBe(true);
      });
    });
  });
});

describe('🔍 VALIDATION CONTINUE: Surveillance des changements', () => {
  test('Le nombre d\'outils ne doit pas diminuer', () => {
    const server = new QuickFilesServer();
    const toolCount = ALL_TOOLS.filter(tool => typeof server[tool] === 'function').length;
    
    // On doit avoir exactement 10 outils
    expect(toolCount).toBe(10);
  });

  test('Aucun outil ne doit retourner "Not implemented"', async () => {
    const server = new QuickFilesServer();
    
    // Créer un mock filesystem minimal
    mockFs({
      '/test': {
        'test.txt': 'test content'
      }
    });
    
    try {
      for (const toolName of CRITICAL_TOOLS) {
        const method = server[toolName];
        
        // Créer une requête minimale valide pour chaque outil
        const request = {
          params: {
            name: toolName,
            arguments: getMinimalValidArgs(toolName)
          }
        };
        
        try {
          const response = await method.call(server, request);
          
          // Vérifier que la réponse ne contient pas "Not implemented"
          expect(JSON.stringify(response)).not.toContain('Not implemented');
        } catch (error) {
          // Les erreurs de validation sont OK, mais pas les "Not implemented"
          expect(error.message).not.toContain('Not implemented');
        }
      }
    } finally {
      mockFs.restore();
    }
  });
});

/**
 * Helper: Retourne des arguments minimaux valides pour chaque outil
 */
function getMinimalValidArgs(toolName) {
  const argsMap = {
    'handleDeleteFiles': { paths: ['/test/test.txt'] },
    'handleEditMultipleFiles': { 
      files: [{ 
        path: '/test/test.txt', 
        diffs: [{ search: 'test', replace: 'test2' }] 
      }] 
    },
    'handleExtractMarkdownStructure': { paths: ['/test/test.txt'] },
    'handleCopyFiles': { 
      operations: [{ 
        source: '/test/test.txt', 
        destination: '/test/test2.txt' 
      }] 
    },
    'handleMoveFiles': { 
      operations: [{ 
        source: '/test/test.txt', 
        destination: '/test/test2.txt' 
      }] 
    },
    'handleSearchInFiles': { 
      paths: ['/test'], 
      pattern: 'test' 
    },
    'handleSearchAndReplace': { 
      paths: ['/test'],
      search: 'test', 
      replace: 'test2' 
    },
    'handleRestartMcpServers': { servers: ['test-server'] }
  };
  
  return argsMap[toolName] || {};
}