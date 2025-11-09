/**
 * Tests unitaires pour valider les corrections des problèmes d'édition dans QuickFiles
 * 
 * Ces tests couvrent spécifiquement :
 * - Gestion correcte des caractères spéciaux dans les expressions régulières
 * - Normalisation des sauts de ligne
 * - Logs de debug fonctionnels
 * - Cas limites avec caractères spéciaux et sauts de ligne
 */

const fs = require('fs/promises');
const path = require('path');
const mockFs = require('mock-fs');

// Simuler le serveur QuickFiles pour les tests unitaires
const { QuickFilesServer } = require('../build/index.js');

// Chemin vers le dossier de test temporaire
const TEST_DIR = path.join(path.dirname(__filename), '..', 'test-temp');

// Mocks pour les requêtes MCP
const mockRequest = (name, args) => ({
  params: {
    name,
    arguments: args
  }
});

describe('QuickFiles Server - Corrections des problèmes d\'édition', () => {
  let server;
  
  beforeEach(() => {
    // Créer un système de fichiers simulé avec mockFs
    mockFs({
      [TEST_DIR]: {
        'special-chars.txt': 'Test avec caractères spéciaux: .^$*+?()[]{}|\\',
        'line-breaks.txt': 'Ligne1\r\nLigne2\nLigne3\r\nLigne4\n\nLigne5',
        'complex-pattern.txt': 'Fonction(test) { return test; }',
        'mixed-content.txt': 'Normal\n\rMixed\n\nContent'
      }
    });
    
    // Créer une instance du serveur QuickFiles
    server = new QuickFilesServer();
  });
  
  afterEach(() => {
    mockFs.restore();
  });

  describe('Gestion des caractères spéciaux dans les regex', () => {
    test('devrait échapper correctement les caractères spéciaux', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: '.^$*+?()[]{}|\\',
            replace: 'ESCAPED'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      // Vérifier que la réponse est correcte
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      // Vérifier que le fichier a été modifié correctement
      const content = await fs.readFile(path.join(TEST_DIR, 'special-chars.txt'), 'utf-8');
      expect(content).toContain('ESCAPED');
      expect(content).not.toContain('.^$*+?()[]{}|\\');
    });

    test('devrait gérer les parenthèses dans les patterns', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'complex-pattern.txt'),
          diffs: [{
            search: 'Function(test)',
            replace: 'Method(test)'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'complex-pattern.txt'), 'utf-8');
      expect(content).toContain('Method(test)');
      expect(content).not.toContain('Function(test)');
    });

    test('devrait gérer les crochets dans les patterns', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: '[test]',
            replace: '{replaced}'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'special-chars.txt'), 'utf-8');
      expect(content).toContain('{replaced}');
      expect(content).not.toContain('[test]');
    });
  });

  describe('Normalisation des sauts de ligne', () => {
    test('devrait normaliser les sauts de ligne Windows', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'line-breaks.txt'),
          diffs: [{
            search: 'Ligne2\r\nLigne3',
            replace: 'Ligne2_Ligne3'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'line-breaks.txt'), 'utf-8');
      // Vérifier que les \r\n ont été normalisés en \n
      expect(content).toContain('Ligne2_Ligne3');
      expect(content).not.toContain('\r\n');
    });

    test('devrait normaliser les sauts de ligne multiples', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'line-breaks.txt'),
          diffs: [{
            search: '\n\nLigne5',
            replace: 'Ligne5'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'line-breaks.txt'), 'utf-8');
      // Vérifier que les multiples \n ont été réduits à un seul
      expect(content).toContain('Ligne5');
      expect(content.split('\n\n').length).toBeLessThan(2); // Moins de doubles sauts de ligne
    });

    test('devrait gérer les sauts de ligne mixtes', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'mixed-content.txt'),
          diffs: [{
            search: 'Normal\r\nMixed',
            replace: 'Normal_Mixed'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'mixed-content.txt'), 'utf-8');
      expect(content).toContain('Normal_Mixed');
      expect(content).not.toContain('\r\n');
    });
  });

  describe('Logs de debug', () => {
    test('devrait générer des logs quand DEBUG_QUICKFILES=true', async () => {
      // Activer les logs de debug
      process.env.DEBUG_QUICKFILES = 'true';
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: '.^$*+?()[]{}|\\',
            replace: 'ESCAPED'
          }]
        }]
      });
      
      await server.handleEditMultipleFiles(request);
      
      // Vérifier que les logs de debug ont été générés
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[QUICKFILES DEBUG] handleEditMultipleFiles'),
        expect.objectContaining({ filesCount: 1 })
      );
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[QUICKFILES DEBUG] editFile'),
        expect.objectContaining({ 
          filePath: expect.stringContaining('special-chars.txt'),
          diffsCount: 1 
        })
      );
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[QUICKFILES DEBUG] regexReplace'),
        expect.objectContaining({
          originalSearch: expect.stringContaining('.^$*+?()[]{}|\\'),
          escapedSearch: expect.stringContaining('\\.\\^\\$\\*\\+\\?\\(\\)\\[\\]\\{\\}\\\\|'),
          filePath: expect.stringContaining('special-chars.txt')
        })
      );
      
      consoleSpy.mockRestore();
      delete process.env.DEBUG_QUICKFILES;
    });

    test('ne devrait pas générer de logs quand DEBUG_QUICKFILES=false', async () => {
      // Désactiver les logs de debug
      process.env.DEBUG_QUICKFILES = 'false';
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: '.^$*+?()[]{}|\\',
            replace: 'ESCAPED'
          }]
        }]
      });
      
      await server.handleEditMultipleFiles(request);
      
      // Vérifier qu'aucun log de debug n'a été généré
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[QUICKFILES DEBUG]')
      );
      
      consoleSpy.mockRestore();
      delete process.env.DEBUG_QUICKFILES;
    });
  });

  describe('Cas limites et gestion d\'erreurs', () => {
    test('devrait gérer les patterns complexes avec caractères spéciaux', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: 'test.*[0-9]+\\.[a-z]{2,4}',
            replace: 'PATTERN_REPLACED'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'special-chars.txt'), 'utf-8');
      expect(content).toContain('PATTERN_REPLACED');
    });

    test('devrait retourner une erreur quand le texte n\'est pas trouvé', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: 'NONEXISTENT_TEXT',
            replace: 'REPLACEMENT'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('n\'a pas été trouvé');
      expect(response.isError).toBeUndefined();
    });

    test('devrait gérer les modifications multiples dans un même fichier', async () => {
      const request = mockRequest('edit_multiple_files', {
        files: [{
          path: path.join(TEST_DIR, 'special-chars.txt'),
          diffs: [{
            search: 'FIRST',
            replace: 'FIRST_REPLACED'
          }, {
            search: 'SECOND',
            replace: 'SECOND_REPLACED'
          }]
        }]
      });
      
      const response = await server.handleEditMultipleFiles(request);
      
      expect(response.content[0].text).toContain('2 modification(s) effectuée(s)');
      expect(response.isError).toBeUndefined();
      
      const content = await fs.readFile(path.join(TEST_DIR, 'special-chars.txt'), 'utf-8');
      expect(content).toContain('FIRST_REPLACED');
      expect(content).toContain('SECOND_REPLACED');
    });
  });
});