/**
 * TESTS UNITAIRES POUR LES CORRECTIONS QUICKLINES MCP
 * 
 * Ce fichier teste les corrections apportées aux problèmes identifiés:
 * 1. Lecture de fichiers ne tient pas compte de la ligne de départ
 * 2. L'édition par pattern ne fonctionne pas correctement
 */

const { createMockServer } = require('./test-utils');

describe('🔧 QuickLines MCP - Corrections des problèmes critiques', () => {
  let mockServer;
  let mockTransport;

  beforeAll(async () => {
    const setup = require('./global-setup');
    await setup();
    
    // Créer un serveur mock pour les tests
    mockServer = createMockServer();
    mockTransport = mockServer.transport;
  });

  afterAll(async () => {
    const teardown = require('./global-setup');
    await teardown.teardown();
    
    if (mockServer) {
      mockServer.close();
    }
  });

  describe('🐛 Problème 1: Lecture de fichiers - Lignes de départ', () => {
    test('devrait respecter les lignes de départ avec extraits', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'read_multiple_files',
          arguments: {
            paths: [
              {
                path: 'test-file.txt',
                excerpts: [
                  { start: 5, end: 10 }
                ]
              }
            ],
            show_line_numbers: true,
            max_chars_per_file: 1000
          }
        }
      };

      const result = await mockServer.transport(request);
      
      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      
      // Vérifier que les numéros de ligne sont corrects
      const lines = result.content.split('\n');
      expect(lines.length).toBeGreaterThan(0);
      
      // La première ligne devrait être la ligne 5
      expect(lines[0]).toMatch(/^5\|/); // Numérotation correcte
    });

    test('devrait gérer correctement les extraits multiples', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'read_multiple_files',
          arguments: {
            paths: [
              {
                path: 'test-file.txt',
                excerpts: [
                  { start: 1, end: 3 },
                  { start: 10, end: 15 }
                ]
              }
            ],
            show_line_numbers: true,
            max_chars_per_file: 1000
          }
        }
      };

      const result = await mockServer.transport(request);
      
      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      
      // Vérifier que les deux extraits sont présents
      const lines = result.content.split('\n');
      expect(lines[0]).toMatch(/^1\|/); // Premier extrait
      expect(lines[1]).toMatch(/^10\|/); // Deuxième extrait
    });
  });

  describe('🐛 Problème 2: Édition par pattern - Patterns incorrects', () => {
    test('devrait échapper correctement les caractères spéciaux', async () => {
      // Créer un fichier de test
      const writeRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [{
              path: '/temp/test-patterns/test-special.txt',
              diffs: [{
                search: '',
                replace: 'test.*pattern\n'
              }]
            }]
          }
        }
      };
      await mockTransport(writeRequest);

      // Test avec pattern contenant des caractères spéciaux
      const editRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [
              {
                path: '/temp/test-patterns/test-special.txt',
                diffs: [
                  {
                    search: 'test.*pattern', // Point traité comme regex
                    replace: 'MODIFIED'
                  }
                ]
              }
            ]
          }
        }
      };

      const result = await mockServer.transport(editRequest);
      
      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      
      // Vérifier que le remplacement a fonctionné
      expect(result.content).toContain('MODIFIED');
    });

    test('devrait gérer correctement les patterns complexes', async () => {
      // Créer un fichier de test
      const writeRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [{
              path: '/temp/test-patterns/test-complex.txt',
              diffs: [{
                search: '',
                replace: '/[a-z]+/\n'
              }]
            }]
          }
        }
      };
      await mockTransport(writeRequest);

      // Test avec pattern complexe
      const editRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [
              {
                path: '/temp/test-patterns/test-complex.txt',
                diffs: [
                  {
                    search: '/[a-z]+/', // Slashes non échappés
                    replace: 'REPLACED'
                  }
                ]
              }
            ]
          }
        }
      };

      const result = await mockServer.transport(editRequest);
      
      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      
      // Vérifier que le remplacement a fonctionné
      expect(result.content).toContain('REPLACED');
    });

    test('devrait utiliser correctement start_line pour les modifications', async () => {
      // Créer un fichier de test
      const writeRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [{
              path: '/temp/test-start-line/test.txt',
              diffs: [{
                search: '',
                replace: 'Ligne 1\nLigne 2\nLigne 3\nLigne 4\nLigne 5'
              }]
            }]
          }
        }
      };
      await mockTransport(writeRequest);

      // Test avec start_line spécifique
      const editRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [
              {
                path: '/temp/test-start-line/test.txt',
                diffs: [
                  {
                    search: 'Ligne 3',
                    replace: 'MODIFIED LIGNE 3',
                    start_line: 3 // Modification ciblée
                  }
                ]
              }
            ]
          }
        }
      };

      const result = await mockServer.transport(editRequest);
      
      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      
      // Vérifier que seule la ligne 3 a été modifiée
      expect(result.content).toContain('MODIFIED LIGNE 3');
      expect(result.content).toContain('Ligne 1'); // Non modifié
      expect(result.content).toContain('Ligne 2'); // Non modifié
      expect(result.content).toContain('Ligne 4'); // Non modifié
      expect(result.content).toContain('Ligne 5'); // Non modifié
    });
  });

  describe('🎯 Tests d intégration - Validation des corrections', () => {
    test('devrait combiner lecture et édition correctement', async () => {
      // Créer un fichier de test
      const writeRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [{
              path: '/temp/integration/integration-test.txt',
              diffs: [{
                search: '',
                replace: 'Ligne 1: test.*pattern\nLigne 2: valeur normale\nLigne 3: /[0-9]+/\nLigne 4: fin'
              }]
            }]
          }
        }
      };
      await mockTransport(writeRequest);

      // Lire le fichier avec extraits
      const readRequest = {
        method: 'tools/call',
        params: {
          name: 'read_multiple_files',
          arguments: {
            paths: [
              {
                path: '/temp/integration/integration-test.txt',
                excerpts: [
                  { start: 2, end: 3 }
                ]
              }
            ],
            show_line_numbers: true
          }
        }
      };
      const readResult = await mockServer.transport(readRequest);
      
      expect(readResult.success).toBe(true);
      expect(readResult.content).toBeDefined();

      // Modifier avec patterns complexes
      const editRequest = {
        method: 'tools/call',
        params: {
          name: 'edit_multiple_files',
          arguments: {
            files: [
              {
                path: '/temp/integration/integration-test.txt',
                diffs: [
                  {
                    search: 'test.*pattern',
                    replace: 'CORRECTED'
                  },
                  {
                    search: '/[0-9]+/',
                    replace: 'NUMBERS'
                  }
                ]
              }
            ]
          }
        }
      };
      const editResult = await mockServer.transport(editRequest);
      
      expect(editResult.success).toBe(true);
      expect(editResult.content).toBeDefined();
      
      // Vérifications finales
      expect(editResult.content).toContain('CORRECTED');
      expect(editResult.content).toContain('NUMBERS');
      expect(editResult.content).not.toContain('test.*pattern'); // Pattern original remplacé
      expect(editResult.content).not.toContain('/[0-9]+/'); // Pattern original remplacé
    });
  });
});