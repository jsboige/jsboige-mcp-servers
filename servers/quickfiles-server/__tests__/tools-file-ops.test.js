/**
 * Tests unitaires pour le module tools/file-ops de QuickFiles Server
 * 
 * Ces tests vérifient les fonctionnalités d'opérations sur fichiers :
 * - DeleteFiles : suppression de fichiers avec rapport détaillé
 * - CopyFiles : copie de fichiers avec transformation et gestion des conflits
 * - MoveFiles : déplacement de fichiers avec transformation et gestion des conflits
 */

const mockFs = require('mock-fs');
const path = require('path');

// Import des classes compilées JavaScript
const deleteFilesModule = require('../../build/tools/file-ops/deleteFiles');
const copyFilesModule = require('../../build/tools/file-ops/copyFiles');
const moveFilesModule = require('../../build/tools/file-ops/moveFiles');
const utilsModule = require('../../build/core/utils');

const DeleteFilesTool = deleteFilesModule.DeleteFilesTool;
const CopyFilesTool = copyFilesModule.CopyFilesTool;
const MoveFilesTool = moveFilesModule.MoveFilesTool;
const QuickFilesUtils = utilsModule.QuickFilesUtils;

describe('QuickFiles Tools File-Ops Module', () => {
  let deleteFiles;
  let copyFiles;
  let moveFiles;
  let utils;

  beforeEach(() => {
    utils = new QuickFilesUtils();
    deleteFiles = new DeleteFilesTool(utils);
    copyFiles = new CopyFilesTool(utils);
    moveFiles = new MoveFilesTool(copyFiles);
  });

  afterEach(() => {
    mockFs.restore();
  });

  describe('DeleteFiles', () => {
    describe('handle', () => {
      test('devrait supprimer un fichier existant', async () => {
        mockFs({
          'test.txt': 'Contenu à supprimer'
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt']
            }
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('supprimé avec succès');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              paths: ['nonexistent.txt']
            }
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.txt');
        expect(result.content[0].text).toContain('n\'existe pas');
      });

      test('devrait supprimer plusieurs fichiers', async () => {
        mockFs({
          'file1.txt': 'Contenu 1',
          'file2.txt': 'Contenu 2',
          'file3.txt': 'Contenu 3'
        });

        const request = {
          params: {
            arguments: {
              paths: ['file1.txt', 'file2.txt', 'file3.txt']
            }
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('3 fichier(s) traité(s)');
        expect(result.content[0].text).toContain('3 suppression(s) réussie(s)');
      });

      test('devrait gérer les chemins complexes', async () => {
        mockFs({
          'complex': {
            'path': {
              'to': {
                'file.txt': 'Contenu à supprimer'
              }
            }
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['complex/path/to/file.txt']
            }
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('complex/path/to/file.txt');
        expect(result.content[0].text).toContain('supprimé avec succès');
      });

      test('devrait gérer les erreurs de permission', async () => {
        mockFs({
          'readonly.txt': mockFs.file({
            content: 'Contenu en lecture seule',
            mode: 0o444
          })
        });

        const request = {
          params: {
            arguments: {
              paths: ['readonly.txt']
            }
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('readonly.txt');
        expect(result.content[0].text).toContain('Erreur de permission');
      });

      test('devrait gérer les répertoires', async () => {
        mockFs({
          'directory': {
            'file.txt': 'Contenu'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['directory']
            }
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('directory');
        expect(result.content[0].text).toContain('est un répertoire');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await deleteFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la suppression des fichiers');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { paths: ['test.txt'] };

        const result = await deleteFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la suppression des fichiers');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await deleteFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la suppression des fichiers');
      });
    });
  });

  describe('CopyFiles', () => {
    describe('handle', () => {
      test('devrait copier un fichier avec succès', async () => {
        mockFs({
          'source.txt': 'Contenu à copier'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt'
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('source.txt');
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('copié avec succès');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'nonexistent.txt',
                destination: 'destination.txt'
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.txt');
        expect(result.content[0].text).toContain('n\'existe pas');
      });

      test('devrait gérer les conflits avec stratégie overwrite', async () => {
        mockFs({
          'source.txt': 'Nouveau contenu',
          'destination.txt': 'Ancien contenu'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt',
                conflict_strategy: 'overwrite'
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('écrasé et copié');
      });

      test('devrait gérer les conflits avec stratégie ignore', async () => {
        mockFs({
          'source.txt': 'Nouveau contenu',
          'destination.txt': 'Ancien contenu'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt',
                conflict_strategy: 'ignore'
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('existe déjà, ignoré');
      });

      test('devrait gérer les conflits avec stratégie rename', async () => {
        mockFs({
          'source.txt': 'Contenu à copier',
          'destination.txt': 'Contenu existant'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt',
                conflict_strategy: 'rename'
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('renommé et copié');
      });

      test('devrait appliquer des transformations de nom', async () => {
        mockFs({
          'file.txt': 'Contenu à copier'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'file.txt',
                destination: 'new_file.txt',
                transform: {
                  pattern: 'file',
                  replacement: 'document'
                }
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('document.txt');
        expect(result.content[0].text).toContain('copié avec succès');
      });

      test('devrait gérer plusieurs opérations', async () => {
        mockFs({
          'file1.txt': 'Contenu 1',
          'file2.txt': 'Contenu 2'
        });

        const request = {
          params: {
            arguments: {
              operations: [
                {
                  source: 'file1.txt',
                  destination: 'dest1.txt'
                },
                {
                  source: 'file2.txt',
                  destination: 'dest2.txt'
                }
              ]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('2 opération(s) traitée(s)');
        expect(result.content[0].text).toContain('2 copie(s) réussie(s)');
      });

      test('devrait gérer les chemins complexes', async () => {
        mockFs({
          'source': {
            'path': {
              'file.txt': 'Contenu à copier'
            }
          }
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source/path/file.txt',
                destination: 'destination/path/file.txt'
              }]
            }
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('source/path/file.txt');
        expect(result.content[0].text).toContain('copié avec succès');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await copyFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la copie des fichiers');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { operations: [{ source: 'test.txt', destination: 'dest.txt' }] };

        const result = await copyFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la copie des fichiers');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await copyFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la copie des fichiers');
      });
    });
  });

  describe('MoveFiles', () => {
    describe('handle', () => {
      test('devrait déplacer un fichier avec succès', async () => {
        mockFs({
          'source.txt': 'Contenu à déplacer'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt'
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('source.txt');
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('déplacé avec succès');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'nonexistent.txt',
                destination: 'destination.txt'
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.txt');
        expect(result.content[0].text).toContain('n\'existe pas');
      });

      test('devrait gérer les conflits avec stratégie overwrite', async () => {
        mockFs({
          'source.txt': 'Nouveau contenu',
          'destination.txt': 'Ancien contenu'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt',
                conflict_strategy: 'overwrite'
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('écrasé et déplacé');
      });

      test('devrait gérer les conflits avec stratégie ignore', async () => {
        mockFs({
          'source.txt': 'Nouveau contenu',
          'destination.txt': 'Ancien contenu'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt',
                conflict_strategy: 'ignore'
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('existe déjà, ignoré');
      });

      test('devrait gérer les conflits avec stratégie rename', async () => {
        mockFs({
          'source.txt': 'Contenu à déplacer',
          'destination.txt': 'Contenu existant'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source.txt',
                destination: 'destination.txt',
                conflict_strategy: 'rename'
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('destination.txt');
        expect(result.content[0].text).toContain('renommé et déplacé');
      });

      test('devrait appliquer des transformations de nom', async () => {
        mockFs({
          'file.txt': 'Contenu à déplacer'
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'file.txt',
                destination: 'new_file.txt',
                transform: {
                  pattern: 'file',
                  replacement: 'document'
                }
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('document.txt');
        expect(result.content[0].text).toContain('déplacé avec succès');
      });

      test('devrait gérer plusieurs opérations', async () => {
        mockFs({
          'file1.txt': 'Contenu 1',
          'file2.txt': 'Contenu 2'
        });

        const request = {
          params: {
            arguments: {
              operations: [
                {
                  source: 'file1.txt',
                  destination: 'dest1.txt'
                },
                {
                  source: 'file2.txt',
                  destination: 'dest2.txt'
                }
              ]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('2 opération(s) traitée(s)');
        expect(result.content[0].text).toContain('2 déplacement(s) réussi(s)');
      });

      test('devrait gérer les chemins complexes', async () => {
        mockFs({
          'source': {
            'path': {
              'file.txt': 'Contenu à déplacer'
            }
          }
        });

        const request = {
          params: {
            arguments: {
              operations: [{
                source: 'source/path/file.txt',
                destination: 'destination/path/file.txt'
              }]
            }
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('source/path/file.txt');
        expect(result.content[0].text).toContain('déplacé avec succès');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await moveFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du déplacement des fichiers');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { operations: [{ source: 'test.txt', destination: 'dest.txt' }] };

        const result = await moveFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du déplacement des fichiers');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await moveFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du déplacement des fichiers');
      });
    });
  });
});