/**
 * Tests unitaires pour le module tools/analysis de QuickFiles Server
 * 
 * Ces tests vérifient les fonctionnalités d'analyse :
 * - ExtractMarkdownStructure : génération de TOC automatique
 * - SearchInFiles : recherche de patterns dans les fichiers
 */

const mockFs = require('mock-fs');
const path = require('path');

// Import des classes compilées JavaScript
const extractMarkdownStructureModule = require('../../build/tools/analysis/extractMarkdownStructure');
const searchInFilesModule = require('../../build/tools/analysis/searchInFiles');
const utilsModule = require('../../build/core/utils');

const ExtractMarkdownStructureTool = extractMarkdownStructureModule.ExtractMarkdownStructureTool;
const SearchInFilesTool = searchInFilesModule.SearchInFilesTool;
const QuickFilesUtils = utilsModule.QuickFilesUtils;

describe('QuickFiles Tools Analysis Module', () => {
  let extractMarkdownStructure;
  let searchInFiles;
  let utils;

  beforeEach(() => {
    utils = new QuickFilesUtils('/test/path');
    extractMarkdownStructure = new ExtractMarkdownStructureTool(utils);
    searchInFiles = new SearchInFilesTool(utils);
  });

  afterEach(() => {
    mockFs.restore();
  });

  describe('ExtractMarkdownStructure', () => {
    describe('handle', () => {
      test('devrait extraire la structure d\'un fichier markdown simple', async () => {
        mockFs({
          '/test/path': {
            'test.md': `# Titre principal

## Section 1

Contenu de la section 1.

### Sous-section 1.1

Détails de la sous-section.

## Section 2

Contenu de la section 2.`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.md']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Titre principal');
        expect(result.content[0].text).toContain('Section 1');
        expect(result.content[0].text).toContain('Sous-section 1.1');
        expect(result.content[0].text).toContain('Section 2');
      });

      test('devrait gérer plusieurs fichiers markdown', async () => {
        mockFs({
          '/test/path': {
            'file1.md': `# Document 1

## Chapitre 1

Contenu.`,
            'file2.md': `# Document 2

## Chapitre 2

Contenu.`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['file1.md', 'file2.md']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Document 1');
        expect(result.content[0].text).toContain('Document 2');
        expect(result.content[0].text).toContain('Chapitre 1');
        expect(result.content[0].text).toContain('Chapitre 2');
      });

      test('devrait respecter la profondeur maximale', async () => {
        mockFs({
          '/test/path': {
            'test.md': `# Niveau 1

## Niveau 2

### Niveau 3

#### Niveau 4

##### Niveau 5

###### Niveau 6`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.md'],
              max_depth: 3
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Niveau 1');
        expect(result.content[0].text).toContain('Niveau 2');
        expect(result.content[0].text).toContain('Niveau 3');
        expect(result.content[0].text).not.toContain('Niveau 4');
        expect(result.content[0].text).not.toContain('Niveau 5');
        expect(result.content[0].text).not.toContain('Niveau 6');
      });

      test('devrait inclure le contexte si demandé', async () => {
        mockFs({
          '/test/path': {
            'test.md': `# Titre principal

Ceci est l'introduction.

## Section 1

Contenu de la section.

### Sous-section

Détails importants.`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.md'],
              include_context: true,
              context_lines: 2
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Titre principal');
        expect(result.content[0].text).toContain('Ceci est l\'introduction');
        expect(result.content[0].text).toContain('Section 1');
        expect(result.content[0].text).toContain('Contenu de la section');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              paths: ['nonexistent.md']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent.md');
        expect(result.content[0].text).toContain('ENOENT');
      });

      test('devrait gérer les fichiers non-markdown', async () => {
        mockFs({
          '/test/path': {
            'test.txt': 'Ceci n\'est pas du markdown'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('n\'est pas un fichier markdown');
      });

      test('devrait gérer les fichiers markdown vides', async () => {
        mockFs({
          '/test/path': {
            'empty.md': ''
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['empty.md']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('empty.md');
        expect(result.content[0].text).toContain('aucune structure trouvée');
      });

      test('devrait gérer les fichiers avec des titres mal formés', async () => {
        mockFs({
          '/test/path': {
            'malformed.md': `#Titre sans espace
## Titre correct
###   Titre avec espaces
####Titre sans espace encore`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['malformed.md']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Titre correct');
        expect(result.content[0].text).toContain('Titre avec espaces');
      });

      test('devrait gérer les caractères spéciaux dans les titres', async () => {
        mockFs({
          '/test/path': {
            'special.md': `# Titre avec éàü

## Section avec & < > " '

### Sous-section avec * _ [ ] ( )`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['special.md']
            }
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Titre avec éàü');
        expect(result.content[0].text).toContain('Section avec & < > " \'');
        expect(result.content[0].text).toContain('Sous-section avec * _ [ ] ( )');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de l\'extraction de la structure Markdown');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = {};

        const result = await extractMarkdownStructure.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de l\'extraction de la structure Markdown');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await extractMarkdownStructure.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de l\'extraction de la structure Markdown');
      });
    });
  });

  describe('SearchInFiles', () => {
    describe('handle', () => {
      test('devrait rechercher un pattern simple', async () => {
        mockFs({
          '/test/path': {
            'file1.txt': 'Contenu avec mot clé',
            'file2.txt': 'Autre contenu',
            'file3.txt': 'Mot clé ici aussi'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['file1.txt', 'file2.txt', 'file3.txt'],
              pattern: 'mot clé'
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('2 fichier(s) contenant des correspondances');
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).toContain('file3.txt');
        expect(result.content[0].text).not.toContain('file2.txt');
      });

      test('devrait utiliser les regex si demandé', async () => {
        mockFs({
          '/test/path': {
            'test.txt': 'email@domain.com\nautre@email.org\npas email'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              pattern: '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b',
              use_regex: true
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('email@domain.com');
        expect(result.content[0].text).toContain('autre@email.org');
      });

      test('devrait être sensible à la casse si demandé', async () => {
        mockFs({
          '/test/path': {
            'test.txt': 'Mot\n\n\nother\n\n\nOTHER'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              pattern: 'Mot',
              case_sensitive: true
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('Mot');
        expect(result.content[0].text).not.toContain('other');
      });

      test('devrait filtrer par pattern de fichier', async () => {
        mockFs({
          '/test/path': {
            'file1.txt': 'contenu clé',
            'file2.js': 'contenu clé',
            'file3.md': 'contenu clé'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['.'],
              pattern: 'clé',
              file_pattern: '*.txt'
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('file1.txt');
        expect(result.content[0].text).not.toContain('file2.js');
        expect(result.content[0].text).not.toContain('file3.md');
      });

      test('devrait inclure le contexte des lignes', async () => {
        mockFs({
          '/test/path': {
            'test.txt': `Ligne 1
Ligne 2 avec pattern
Ligne 3
Ligne 4
Ligne 5 avec pattern
Ligne 6`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              pattern: 'pattern',
              context_lines: 2
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Ligne 1');
        expect(result.content[0].text).toContain('Ligne 2 avec pattern');
        expect(result.content[0].text).toContain('Ligne 3');
        expect(result.content[0].text).toContain('Ligne 4');
        expect(result.content[0].text).toContain('Ligne 5 avec pattern');
        expect(result.content[0].text).toContain('Ligne 6');
      });

      test('devrait limiter les résultats par fichier', async () => {
        mockFs({
          '/test/path': {
            'test.txt': `ligne 1
ligne 2
ligne 3
ligne 4
ligne 5`
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              pattern: 'ligne',
              max_results_per_file: 3
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('1 fichier(s) contenant des correspondances');
      });

      test('devrait limiter les résultats totaux', async () => {
        mockFs({
          '/test/path': {
            'file1.txt': 'ligne 1\nligne 2',
            'file2.txt': 'ligne 3\nligne 4',
            'file3.txt': 'ligne 5\nligne 6'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['file1.txt', 'file2.txt', 'file3.txt'],
              pattern: 'ligne',
              max_total_results: 3
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        // Le format de réponse a changé, on vérifie le nombre de fichiers ou le message de limite
        expect(result.content[0].text).toContain('limite de résultats atteinte');
      });

      test('devrait rechercher récursivement', async () => {
        mockFs({
          '/test/path': {
            'dir1': {
              'subdir1': {
                'file1.txt': 'contenu clé'
              },
              'file2.txt': 'pas clef'
            },
            'file3.txt': 'contenu clé'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['.'],
              pattern: 'clé',
              recursive: true
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        // Normalisation des séparateurs pour Windows
        const normalizedOutput = result.content[0].text.replace(/\\/g, '/');
        expect(normalizedOutput).toContain('dir1/subdir1/file1.txt');
        expect(result.content[0].text).toContain('file3.txt');
        expect(result.content[0].text).not.toContain('file2.txt');
      });

      test('devrait gérer les fichiers inexistants', async () => {
        const request = {
          params: {
            arguments: {
              paths: ['nonexistent.txt'],
              pattern: 'test'
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Aucun résultat trouvé');
      });

      test('devrait gérer les patterns non trouvés', async () => {
        mockFs({
          '/test/path': {
            'test.txt': 'contenu sans le pattern recherché'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              pattern: 'pattern_non_trouvé'
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Aucun résultat trouvé');
      });

      test('devrait gérer les caractères spéciaux', async () => {
        mockFs({
          '/test/path': {
            'test.txt': 'Contenu avec éàü & < > " \' et des émojis 🚀'
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['test.txt'],
              pattern: 'éàü'
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('test.txt');
        expect(result.content[0].text).toContain('éàü');
      });

      test('devrait gérer les erreurs de lecture', async () => {
        mockFs({
          '/test/path': {
            'readonly.txt': mockFs.file({
              content: 'contenu',
              mode: 0o000
            })
          }
        });

        const request = {
          params: {
            arguments: {
              paths: ['readonly.txt'],
              pattern: 'contenu'
            }
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.content).toBeDefined();
        // Le fichier est ignoré s'il n'est pas lisible
        expect(result.content[0].text).toContain('Aucun résultat trouvé');
      });

      test('devrait rejeter les paramètres invalides', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await searchInFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la recherche');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = {};

        const result = await searchInFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la recherche');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await searchInFiles.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors de la recherche');
      });
    });
  });
});