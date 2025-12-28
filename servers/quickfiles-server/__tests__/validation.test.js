/**
 * Tests unitaires pour le module validation de QuickFiles Server
 * 
 * Ces tests vérifient les schémas de validation Zod :
 * - ReadMultipleFilesSchema
 * - ListDirectoryContentsSchema
 * - EditMultipleFilesSchema
 * - SearchAndReplaceSchema
 * - DeleteFilesSchema
 * - CopyFilesSchema
 * - MoveFilesSchema
 * - ExtractMarkdownStructureSchema
 * - SearchInFilesSchema
 * - RestartMcpServersSchema
 */

const { z } = require('zod');

// Import des schémas source TypeScript
const schemasModule = require('../../build/validation/schemas');

const {
  ReadMultipleFilesArgsSchema: ReadMultipleFilesSchema,
  ListDirectoryContentsArgsSchema: ListDirectoryContentsSchema,
  EditMultipleFilesArgsSchema: EditMultipleFilesSchema,
  SearchAndReplaceArgsSchema: SearchAndReplaceSchema,
  DeleteFilesArgsSchema: DeleteFilesSchema,
  CopyFilesArgsSchema: CopyFilesSchema,
  MoveFilesArgsSchema: MoveFilesSchema,
  ExtractMarkdownStructureArgsSchema: ExtractMarkdownStructureSchema,
  SearchInFilesArgsSchema: SearchInFilesSchema,
  RestartMcpServersArgsSchema: RestartMcpServersSchema
} = schemasModule;

// Helper function pour utiliser safeParse de Zod
function safeParse(schema, data) {
  return schema.safeParse(data);
}

describe('QuickFiles Validation Module', () => {
  describe('ReadMultipleFilesSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        paths: ['file1.txt', 'file2.txt'],
        show_line_numbers: true,
        max_lines_per_file: 1000,
        max_chars_per_file: 50000,
        max_total_lines: 5000,
        max_total_chars: 100000
      };

      const result = safeParse(ReadMultipleFilesSchema, validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        paths: ['file.txt']
      };

      const result = safeParse(ReadMultipleFilesSchema, minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans paths', () => {
      const invalidRequest = {
        show_line_numbers: true
      };

      const result = safeParse(ReadMultipleFilesSchema, invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter des paths invalides', () => {
      const invalidRequest = {
        paths: 'not-an-array'
      };

      const result = safeParse(ReadMultipleFilesSchema, invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter des valeurs numériques négatives', () => {
      const invalidRequest = {
        paths: ['file.txt'],
        max_lines_per_file: -1
      };

      const result = safeParse(ReadMultipleFilesSchema, invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait valider les chemins complexes', () => {
      const complexRequest = {
        paths: [
          'simple.txt',
          'path/to/file.txt',
          '../relative/path.txt',
          '/absolute/path.txt'
        ]
      };

      const result = safeParse(ReadMultipleFilesSchema, complexRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider les extraits', () => {
      const excerptsRequest = {
        paths: [
          {
            path: 'file.txt',
            excerpts: [
              { start: 1, end: 10 },
              { start: 20, end: 30 }
            ]
          }
        ]
      };

      const result = safeParse(ReadMultipleFilesSchema, excerptsRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter les extraits invalides', () => {
      const invalidExcerptsRequest = {
        paths: [
          {
            path: 'file.txt',
            excerpts: [
              { start: 10, end: 5 } // end < start
            ]
          }
        ]
      };

      const result = safeParse(ReadMultipleFilesSchema, invalidExcerptsRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('ListDirectoryContentsSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        paths: ['dir1', 'dir2'],
        max_lines: 1000,
        recursive: true,
        max_depth: 5,
        file_pattern: '*.txt',
        sort_by: 'name',
        sort_order: 'asc'
      };

      const result = ListDirectoryContentsSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        paths: ['dir']
      };

      const result = ListDirectoryContentsSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans paths', () => {
      const invalidRequest = {
        recursive: true
      };

      const result = ListDirectoryContentsSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un sort_by invalide', () => {
      const invalidRequest = {
        paths: ['dir'],
        sort_by: 'invalid'
      };

      const result = ListDirectoryContentsSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un sort_order invalide', () => {
      const invalidRequest = {
        paths: ['dir'],
        sort_order: 'invalid'
      };

      const result = ListDirectoryContentsSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une profondeur négative', () => {
      const invalidRequest = {
        paths: ['dir'],
        max_depth: -1
      };

      const result = ListDirectoryContentsSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait valider les options de chemin complexes', () => {
      const complexPathsRequest = {
        paths: [
          'simple',
          {
            path: 'complex/path',
            recursive: true,
            max_depth: 3,
            file_pattern: '*.js',
            sort_by: 'modified',
            sort_order: 'desc'
          }
        ]
      };

      const result = ListDirectoryContentsSchema.safeParse(complexPathsRequest);
      expect(result.success).toBe(true);
    });
  });

  describe('EditMultipleFilesSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        files: [
          {
            path: 'file.txt',
            diffs: [
              {
                search: 'ancien',
                replace: 'nouveau',
                start_line: 10
              }
            ]
          }
        ]
      };

      const result = EditMultipleFilesSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête avec plusieurs diffs', () => {
      const multipleDiffsRequest = {
        files: [
          {
            path: 'file.txt',
            diffs: [
              { search: 'pattern1', replace: 'replace1' },
              { search: 'pattern2', replace: 'replace2', start_line: 5 }
            ]
          }
        ]
      };

      const result = EditMultipleFilesSchema.safeParse(multipleDiffsRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans files', () => {
      const invalidRequest = {};

      const result = EditMultipleFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un fichier sans path', () => {
      const invalidRequest = {
        files: [
          {
            diffs: [{ search: 'test', replace: 'replace' }]
          }
        ]
      };

      const result = EditMultipleFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un diff sans search', () => {
      const invalidRequest = {
        files: [
          {
            path: 'file.txt',
            diffs: [{ replace: 'replace' }]
          }
        ]
      };

      const result = EditMultipleFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un diff sans replace', () => {
      const invalidRequest = {
        files: [
          {
            path: 'file.txt',
            diffs: [{ search: 'search' }]
          }
        ]
      };

      const result = EditMultipleFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une ligne de départ négative', () => {
      const invalidRequest = {
        files: [
          {
            path: 'file.txt',
            diffs: [{ search: 'test', replace: 'replace', start_line: -1 }]
          }
        ]
      };

      const result = EditMultipleFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('SearchAndReplaceSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        search: 'pattern',
        replace: 'replacement',
        use_regex: true,
        case_sensitive: false,
        preview: true,
        paths: ['file1.txt', 'file2.txt']
      };

      const result = SearchAndReplaceSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête avec file_pattern', () => {
      const filePatternRequest = {
        search: 'pattern',
        replace: 'replacement',
        file_pattern: '*.js',
        recursive: true
      };

      const result = SearchAndReplaceSchema.safeParse(filePatternRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête avec files', () => {
      const filesRequest = {
        search: 'pattern',
        replace: 'replacement',
        files: [
          { path: 'file1.txt', search: 'specific', replace: 'replace' },
          { path: 'file2.txt' }
        ]
      };

      const result = SearchAndReplaceSchema.safeParse(filesRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans search', () => {
      const invalidRequest = {
        replace: 'replacement'
      };

      const result = SearchAndReplaceSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une requête sans replace', () => {
      const invalidRequest = {
        search: 'pattern'
      };

      const result = SearchAndReplaceSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un fichier sans path', () => {
      const invalidRequest = {
        search: 'pattern',
        replace: 'replacement',
        files: [{ search: 'specific', replace: 'replace' }]
      };

      const result = SearchAndReplaceSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('DeleteFilesSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        paths: ['file1.txt', 'file2.txt', 'dir/file3.txt']
      };

      const result = DeleteFilesSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        paths: ['file.txt']
      };

      const result = DeleteFilesSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans paths', () => {
      const invalidRequest = {};

      const result = DeleteFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter des paths non-tableau', () => {
      const invalidRequest = {
        paths: 'not-an-array'
      };

      const result = DeleteFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un tableau de paths vide', () => {
      const invalidRequest = {
        paths: []
      };

      const result = DeleteFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('CopyFilesSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt',
            conflict_strategy: 'overwrite',
            transform: {
              pattern: 'old',
              replacement: 'new'
            }
          }
        ]
      };

      const result = CopyFilesSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt'
          }
        ]
      };

      const result = CopyFilesSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider plusieurs opérations', () => {
      const multipleOpsRequest = {
        operations: [
          { source: 'file1.txt', destination: 'dest1.txt' },
          { source: 'file2.txt', destination: 'dest2.txt', conflict_strategy: 'ignore' }
        ]
      };

      const result = CopyFilesSchema.safeParse(multipleOpsRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans operations', () => {
      const invalidRequest = {};

      const result = CopyFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une opération sans source', () => {
      const invalidRequest = {
        operations: [
          { destination: 'dest.txt' }
        ]
      };

      const result = CopyFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une opération sans destination', () => {
      const invalidRequest = {
        operations: [
          { source: 'source.txt' }
        ]
      };

      const result = CopyFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une stratégie de conflit invalide', () => {
      const invalidRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt',
            conflict_strategy: 'invalid'
          }
        ]
      };

      const result = CopyFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une transformation sans pattern', () => {
      const invalidRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt',
            transform: {
              replacement: 'new'
            }
          }
        ]
      };

      const result = CopyFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une transformation sans replacement', () => {
      const invalidRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt',
            transform: {
              pattern: 'old'
            }
          }
        ]
      };

      const result = CopyFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('MoveFilesSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt',
            conflict_strategy: 'rename',
            transform: {
              pattern: 'old',
              replacement: 'new'
            }
          }
        ]
      };

      const result = MoveFilesSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt'
          }
        ]
      };

      const result = MoveFilesSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans operations', () => {
      const invalidRequest = {};

      const result = MoveFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une opération sans source', () => {
      const invalidRequest = {
        operations: [
          { destination: 'dest.txt' }
        ]
      };

      const result = MoveFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une opération sans destination', () => {
      const invalidRequest = {
        operations: [
          { source: 'source.txt' }
        ]
      };

      const result = MoveFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une stratégie de conflit invalide', () => {
      const invalidRequest = {
        operations: [
          {
            source: 'source.txt',
            destination: 'dest.txt',
            conflict_strategy: 'invalid'
          }
        ]
      };

      const result = MoveFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('ExtractMarkdownStructureSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        paths: ['file1.md', 'file2.md'],
        max_depth: 4,
        include_context: true,
        context_lines: 3
      };

      const result = ExtractMarkdownStructureSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        paths: ['file.md']
      };

      const result = ExtractMarkdownStructureSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans paths', () => {
      const invalidRequest = {
        max_depth: 3
      };

      const result = ExtractMarkdownStructureSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une profondeur négative', () => {
      const invalidRequest = {
        paths: ['file.md'],
        max_depth: -1
      };

      const result = ExtractMarkdownStructureSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un nombre de lignes de contexte négatif', () => {
      const invalidRequest = {
        paths: ['file.md'],
        context_lines: -1
      };

      const result = ExtractMarkdownStructureSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('SearchInFilesSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        paths: ['file1.txt', 'file2.txt'],
        pattern: 'search pattern',
        use_regex: true,
        case_sensitive: false,
        file_pattern: '*.js',
        context_lines: 2,
        max_results_per_file: 10,
        max_total_results: 50,
        recursive: true
      };

      const result = SearchInFilesSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        paths: ['file.txt'],
        pattern: 'search'
      };

      const result = SearchInFilesSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans paths', () => {
      const invalidRequest = {
        pattern: 'search'
      };

      const result = SearchInFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter une requête sans pattern', () => {
      const invalidRequest = {
        paths: ['file.txt']
      };

      const result = SearchInFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un nombre de lignes de contexte négatif', () => {
      const invalidRequest = {
        paths: ['file.txt'],
        pattern: 'search',
        context_lines: -1
      };

      const result = SearchInFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un nombre de résultats par fichier négatif', () => {
      const invalidRequest = {
        paths: ['file.txt'],
        pattern: 'search',
        max_results_per_file: -1
      };

      const result = SearchInFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un nombre total de résultats négatif', () => {
      const invalidRequest = {
        paths: ['file.txt'],
        pattern: 'search',
        max_total_results: -1
      };

      const result = SearchInFilesSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('RestartMcpServersSchema', () => {
    test('devrait valider une requête valide', () => {
      const validRequest = {
        servers: ['server1', 'server2', 'server3']
      };

      const result = RestartMcpServersSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    test('devrait valider une requête minimale', () => {
      const minimalRequest = {
        servers: ['server']
      };

      const result = RestartMcpServersSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    test('devrait rejeter une requête sans servers', () => {
      const invalidRequest = {};

      const result = RestartMcpServersSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter des servers non-tableau', () => {
      const invalidRequest = {
        servers: 'not-an-array'
      };

      const result = RestartMcpServersSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter un tableau de servers vide', () => {
      const invalidRequest = {
        servers: []
      };

      const result = RestartMcpServersSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    test('devrait rejeter des noms de serveurs vides', () => {
      const invalidRequest = {
        servers: ['server1', '', 'server3']
      };

      const result = RestartMcpServersSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });
});