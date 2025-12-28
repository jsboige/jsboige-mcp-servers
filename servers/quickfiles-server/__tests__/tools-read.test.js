/**
 * Tests unitaires pour le module tools/read de QuickFiles Server
 * 
 * Ces tests vérifient les fonctionnalités de lecture :
 * - ReadMultipleFiles : lecture multiple avec extraits et limites
 * - ListDirectoryContents : listing récursif avec tri et filtrage
 */

const mockFs = require('mock-fs');
const path = require('path');

// Import des classes compilées JavaScript
const readMultipleFilesModule = require('../../build/tools/read/readMultipleFiles');
const listDirectoryContentsModule = require('../../build/tools/read/listDirectoryContents');
const utilsModule = require('../../build/core/utils');

const ReadMultipleFilesTool = readMultipleFilesModule.ReadMultipleFilesTool;
const ListDirectoryContentsTool = listDirectoryContentsModule.ListDirectoryContentsTool;
const QuickFilesUtils = utilsModule.QuickFilesUtils;

describe('QuickFiles Tools Read Module', () => {
  let readMultipleFiles;
  let listDirectoryContents;
  let utils;

  beforeEach(() => {
    utils = new QuickFilesUtils('.');
    readMultipleFiles = new ReadMultipleFilesTool(utils);
    listDirectoryContents = new ListDirectoryContentsTool(utils);
  });

  afterEach(() => {
    mockFs.restore();
  });

  describe('ReadMultipleFiles', () => {
    describe('handle', () => {
      test('devrait lire plusieurs fichiers avec succès', async () => {
        mockFs({
          'file1.txt': 'Contenu du fichier 1',
          'file2.txt': 'Contenu du fichier 2',
          'file3.txt': 'Contenu du fichier 3'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'file1.txt',
                'file2.txt',
                'file3.txt'
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file2.txt');
        expect(result.content[0].text).toContain('file3.txt');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              paths: [
                'nonexistent.txt'
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.txt');
        expect(result.content[0].text).toContain('n\'existe pas');
      });

      test('devrait limiter le nombre de lignes par fichier', async () => {
        mockFs({
          'longfile.txt': 'Ligne 1\nLigne 2\nLigne 3\nLigne 4\nLigne 5'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'longfile.txt'
              ],
              max_lines_per_file: 3
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Ligne 1');
        expect(result.content[0].text).toContain('Ligne 2');
        expect(result.content[0].text).toContain('Ligne 3');
        expect(result.content[0].text).not.toContain('Ligne 4');
      });

      test('devrait afficher les numéros de ligne si demandé', async () => {
        mockFs({
          'test.txt': 'Ligne 1\nLigne 2\nLigne 3'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'test.txt'
              ],
              show_line_numbers: true
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('1 | Ligne 1');
        expect(result.content[0].text).toContain('2 | Ligne 2');
        expect(result.content[0].text).toContain('3 | Ligne 3');
      });

      test('devrait lire des extraits de fichiers', async () => {
        mockFs({
          'test.txt': 'Ligne 1\nLigne 2\nLigne 3\nLigne 4\nLigne 5'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'test.txt',
                  excerpts: [
                    { start: 2, end: 4 }
                  ]
                }
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Ligne 2');
        expect(result.content[0].text).toContain('Ligne 3');
        expect(result.content[0].text).toContain('Ligne 4');
        expect(result.content[0].text).not.toContain('Ligne 1');
        expect(result.content[0].text).not.toContain('Ligne 5');
      });

      test('devrait gérer les fichiers avec des caractères spéciaux dans le nom', async () => {
        mockFs({
          'fichier-avec-accents_é.txt': 'Contenu avec accents',
          'файл.txt': 'Contenu cyrillique',
          'ファイル.txt': 'Contenu japonais'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'fichier-avec-accents_é.txt',
                'файл.txt',
                'ファイル.txt'
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('fichier-avec-accents_é.txt');
        expect(result.content[0].text).toContain('файл.txt');
        expect(result.content[0].text).toContain('ファイル.txt');
      });

      test('devrait gérer les fichiers avec des chemins très longs', async () => {
        const longPath = 'a'.repeat(100) + '.txt';
        mockFs({
          [longPath]: 'Contenu de fichier avec chemin très long'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { path: longPath }
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain(longPath);
      });

      test('devrait gérer les fichiers vides', async () => {
        mockFs({
          'empty.txt': ''
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'empty.txt'
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('empty.txt');
        expect(result.content[0].text).toContain('(vide)');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('paths est requis');
      });

      test('devrait gérer les extraits avec start_line invalide', async () => {
        mockFs({
          'test.txt': 'Ligne 1\nLigne 2\nLigne 3'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'test.txt',
                  excerpts: [
                    { start: -1, end: 2 }
                  ]
                }
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('start_line doit être positif');
      });

      test('devrait gérer les extraits avec end_line invalide', async () => {
        mockFs({
          'test.txt': 'Ligne 1\nLigne 2\nLigne 3'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'test.txt',
                  excerpts: [
                    { start: 1, end: 0 }
                  ]
                }
              ]
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('end_line doit être supérieur à start_line');
      });

      test('devrait limiter le nombre total de caractères', async () => {
        mockFs({
          'large.txt': 'x'.repeat(10000)
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'large.txt'
              ],
              max_chars_per_file: 100
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('limité à 100 caractères');
      });

      test('devrait limiter le nombre total de lignes', async () => {
        mockFs({
          'file1.txt': 'Ligne 1\nLigne 2\nLigne 3',
          'file2.txt': 'Ligne 1\nLigne 2\nLigne 3'
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'file1.txt',
                'file2.txt'
              ],
              max_total_lines: 4
            }
          }
        };

        const result = await readMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('limité à 4 lignes au total');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { paths: ['test.txt'] };

        const result = await readMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la lecture des fichiers');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await readMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la lecture des fichiers');
      });
    });
  });

  describe('ListDirectoryContents', () => {
    describe('handle', () => {
      test('devrait lister le contenu d\'un répertoire avec succès', async () => {
        mockFs({
          'testdir': {
            'file1.txt': 'Contenu 1',
            'file2.txt': 'Contenu 2',
            'subdir': {
              'file3.txt': 'Contenu 3'
            }
          }
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'testdir'
              ]
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('testdir');
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file2.txt');
      });

      test('devrait lister récursivement si demandé', async () => {
        mockFs({
          'testdir': {
            'file1.txt': 'Contenu 1',
            'subdir': {
              'file2.txt': 'Contenu 2',
              'subsubdir': {
                'file3.txt': 'Contenu 3'
              }
            }
          }
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'testdir',
                  recursive: true
                }
              ]
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file2.txt');
        expect(result.content[0].text).toContain('file3.txt');
      });

      test('devrait respecter la profondeur maximale spécifiée', async () => {
        mockFs({
          'testdir': {
            'file1.txt': 'Contenu 1',
            'subdir': {
              'file2.txt': 'Contenu 2',
              'subsubdir': {
                'file3.txt': 'Contenu 3'
              }
            }
          }
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'testdir',
                  recursive: true,
                  max_depth: 2
                }
              ]
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file2.txt');
        expect(result.content[0].text).not.toContain('file3.txt');
      });

      test('devrait respecter la profondeur maximale globale', async () => {
        mockFs({
          'testdir': {
            'file1.txt': 'Contenu 1',
            'subdir': {
              'file2.txt': 'Contenu 2',
              'subsubdir': {
                'file3.txt': 'Contenu 3'
              }
            }
          }
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'testdir',
                  recursive: true
                }
              ],
              max_depth: 2
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file2.txt');
        expect(result.content[0].text).not.toContain('file3.txt');
      });

      test('devrait gérer les répertoires inexistants', async () => {
        const request = {
          params: {
            arguments: {
              paths: [
                'nonexistent'
              ]
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent');
        expect(result.content[0].text).toContain('n\'existe pas');
      });

      test('devrait limiter le nombre de lignes dans la sortie', async () => {
        mockFs({
          'testdir': {}
        });

        // Créer beaucoup de fichiers
        const files = {};
        for (let i = 1; i <= 100; i++) {
          files[`file${i}.txt`] = `Contenu ${i}`;
        }
        mockFs({
          'testdir': files
        });

        const request = {
          params: {
            arguments: {
              paths: [
                'testdir'
              ],
              max_lines: 10
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('limité à 10 lignes');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('paths est requis');
      });

      test('devrait filtrer par motif de fichier', async () => {
        mockFs({
          'testdir': {
            'file1.txt': 'Contenu 1',
            'file2.js': 'Contenu 2',
            'file3.txt': 'Contenu 3',
            'file4.md': 'Contenu 4'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'testdir',
                  file_pattern: '*.txt'
                }
              ]
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file3.txt');
        expect(result.content[0].text).not.toContain('file2.js');
        expect(result.content[0].text).not.toContain('file4.md');
      });

      test('devrait trier les résultats', async () => {
        mockFs({
          'testdir': {
            'zfile.txt': 'Contenu Z',
            'afile.txt': 'Contenu A',
            'mfile.txt': 'Contenu M'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: [
                { 
                  path: 'testdir',
                  sort_by: 'name',
                  sort_order: 'asc'
                }
              ]
            }
          }
        };

        const result = await listDirectoryContents.handle(request);

        expect(result.content).toBeDefined();
        const lines = result.content[0].text.split('\n');
        const aIndex = lines.findIndex(line => line.includes('afile.txt'));
        const mIndex = lines.findIndex(line => line.includes('mfile.txt'));
        const zIndex = lines.findIndex(line => line.includes('zfile.txt'));
        
        expect(aIndex).toBeLessThan(mIndex);
        expect(mIndex).toBeLessThan(zIndex);
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { paths: ['testdir'] };

        const result = await listDirectoryContents.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du listing du répertoire');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await listDirectoryContents.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du listing du répertoire');
      });
    });
  });
});