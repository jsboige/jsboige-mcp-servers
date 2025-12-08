/**
 * Tests unitaires pour le module tools/edit de QuickFiles Server
 * 
 * Ces tests vérifient les fonctionnalités d'édition :
 * - EditMultipleFiles : édition multiple avec diffs
 * - SearchAndReplace : recherche et remplacement avancé
 */

const mockFs = require('mock-fs');
const path = require('path');

// Import des classes compilées JavaScript
const editMultipleFilesModule = require('../../build/tools/edit/editMultipleFiles');
const searchAndReplaceModule = require('../../build/tools/edit/searchAndReplace');
const utilsModule = require('../../build/core/utils');

const EditMultipleFilesTool = editMultipleFilesModule.EditMultipleFilesTool;
const SearchAndReplaceTool = searchAndReplaceModule.SearchAndReplaceTool;
const QuickFilesUtils = utilsModule.QuickFilesUtils;

describe('QuickFiles Tools Edit Module', () => {
  let editMultipleFiles;
  let searchAndReplace;
  let utils;

  beforeEach(() => {
    utils = new QuickFilesUtils();
    editMultipleFiles = new EditMultipleFilesTool(utils);
    searchAndReplace = new SearchAndReplaceTool(utils);
  });

  afterEach(() => {
    mockFs.restore();
  });

  describe('EditMultipleFiles', () => {
    describe('handle', () => {
      test('devrait modifier un fichier avec succès', async () => {
        mockFs({
          'test.txt': 'Ligne originale\nÀ remplacer\nAutre ligne'
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'test.txt',
                diffs: [{
                  search: 'À remplacer',
                  replace: 'Remplacée'
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('1 modification(s) effectuée(s)');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              files: [{
                path: 'nonexistent.txt',
                diffs: [{
                  search: 'texte',
                  replace: 'remplacement'
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.txt');
        expect(result.content[0].text).toContain('Échec d\'édition');
      });

      test('devrait gérer les motifs de recherche non trouvés', async () => {
        mockFs({
          'test.txt': 'Contenu original'
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'test.txt',
                diffs: [{
                  search: 'texte inexistant',
                  replace: 'remplacement'
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Aucune modification');
        expect(result.content[0].text).toContain('Le texte à rechercher');
      });

      test('devrait appliquer des diffs avec start_line', async () => {
        mockFs({
          'test.txt': 'Ligne 1\nLigne 2\nLigne 3\nLigne 4'
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'test.txt',
                diffs: [{
                  search: 'Ligne 3',
                  replace: 'Ligne modifiée',
                  start_line: 3
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('1 modification(s) effectuée(s)');
      });

      test('devrait gérer plusieurs modifications dans un fichier', async () => {
        mockFs({
          'test.txt': 'Première ligne\nDeuxième ligne\nTroisième ligne\nQuatrième ligne'
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'test.txt',
                diffs: [
                  {
                    search: 'Première',
                    replace: 'Première modifiée'
                  },
                  {
                    search: 'Troisième',
                    replace: 'Troisième modifiée'
                  }
                ]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('2 modification(s) effectuée(s)');
      });

      test('devrait gérer les caractères spéciaux dans les patterns', async () => {
        mockFs({
          'test.txt': 'Ligne avec [parenthèses] et {accolades}'
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'test.txt',
                diffs: [{
                  search: '[parenthèses]',
                  replace: '(parenthèses)'
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('1 modification(s) effectuée(s)');
      });

      test('devrait gérer les expressions régulières', async () => {
        mockFs({
          'test.txt': 'numéro1\nnuméro2\nnuméro3\nnuméro4'
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'test.txt',
                diffs: [{
                  search: 'numéro\\d+',
                  replace: 'NUMÉRO',
                  use_regex: true
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('4 modification(s) effectuée(s)');
      });

      test('devrait gérer les fichiers avec des chemins complexes', async () => {
        mockFs({
          'complex': {
            'path': {
              'to': {
                'file.txt': 'Contenu à modifier'
              }
            }
          }
        });

        const request = {
          params: {
            arguments: {
              files: [{
                path: 'complex/path/to/file.txt',
                diffs: [{
                  search: 'Contenu à modifier',
                  replace: 'Contenu modifié'
                }]
              }]
            }
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('1 modification(s) effectuée(s)');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await editMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de l\'édition des fichiers');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { files: [{ path: 'test.txt', diffs: [] }] };

        const result = await editMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de l\'édition des fichiers');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await editMultipleFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de l\'édition des fichiers');
      });
    });
  });

  describe('SearchAndReplace', () => {
    describe('handle', () => {
      test('devrait rechercher du texte dans des fichiers', async () => {
        mockFs({
          'file1.txt': 'Contenu avec terme recherché',
          'file2.txt': 'Autre contenu sans terme',
          'file3.txt': 'Terme recherché ici aussi'
        });

        const request = {
          params: {
            arguments: {
              paths: ['file1.txt', 'file2.txt', 'file3.txt'],
              search: 'terme recherché'
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file3.txt');
        expect(result.content[0].text).not.toContain('file2.txt');
      });

      test('devrait remplacer du texte dans des fichiers', async () => {
        mockFs({
          'test.txt': 'Ancien texte à remplacer'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: 'Ancien',
              replace: 'Nouveau'
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('1 remplacement');
      });

      test('devrait utiliser des expressions régulières', async () => {
        mockFs({
          'test.txt': 'item1\nitem2\nitem3\nitem4'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: 'item\\d+',
              replace: 'ITEM',
              use_regex: true
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('4 remplacements');
      });

      test('devrait prévisualiser les modifications sans les appliquer', async () => {
        mockFs({
          'test.txt': 'Texte original à modifier'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: 'original',
              replace: 'modifié',
              preview: true
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('PRÉVISUALISATION');
        expect(result.content[0].text).toContain('1 remplacement');
      });

      test('devrait gérer la sensibilité à la casse', async () => {
        mockFs({
          'test.txt': 'Texte avec Casse différente'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: 'casse',
              replace: 'CASSE',
              case_sensitive: true
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('0 remplacement');
      });

      test('devrait filtrer par motif de fichier', async () => {
        mockFs({
          'file1.txt': 'Contenu texte',
          'file2.js': 'Contenu code',
          'file3.txt': 'Autre contenu texte'
        });

        const request = {
          params: {
            arguments: {
              paths: ['.'],
              search: 'contenu',
              file_pattern: '*.txt'
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file3.txt');
        expect(result.content[0].text).not.toContain('file2.js');
      });

      test('devrait limiter le nombre de résultats', async () => {
        mockFs({
          'test.txt': 'ligne1\nligne2\nligne3\nligne4\nligne5'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: 'ligne',
              max_results: 3
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('3 correspondances');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              paths: ['nonexistent.txt'],
              search: 'texte'
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.txt');
        expect(result.content[0].text).toContain('ERREUR');
      });

      test('devrait gérer les caractères spéciaux dans les patterns', async () => {
        mockFs({
          'test.txt': 'Texte avec [caractères] spéciaux'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: '[caractères]',
              replace: '(caractères)'
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('1 remplacement');
      });

      test('devrait gérer les remplacements multiples', async () => {
        mockFs({
          'test.txt': 'motif1\nmotif2\nmotif1\nmotif3\nmotif1'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              search: 'motif1',
              replace: 'REMPLACÉ'
            }
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('3 remplacements');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await searchAndReplace.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la recherche et remplacement');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { paths: ['test.txt'], search: 'texte' };

        const result = await searchAndReplace.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la recherche et remplacement');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await searchAndReplace.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la recherche et remplacement');
      });
    });
  });
});