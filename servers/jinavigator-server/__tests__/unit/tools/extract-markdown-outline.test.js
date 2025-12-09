/**
 * Tests unitaires pour l'outil extract_markdown_outline
 * 
 * Ces tests couvrent tous les cas nominaux, d'erreur et limites
 * pour l'outil d'extraction du plan des titres Markdown.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { extractMarkdownOutlineTool } from '../../../src/tools/extract-markdown-outline.js';

// Mock axios
jest.mock('axios');

describe('extract_markdown_outline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: '# Titre 1\n## Titre 2\nContenu'
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Cas nominaux', () => {
    test('devrait extraire le plan d\'une seule URL avec succès', async () => {
      const input = {
        urls: [
          { url: 'https://example.com' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com',
        expect.any(Object)
      );
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com',
        success: true,
        max_depth: 3,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait extraire le plan de plusieurs URLs en parallèle', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' },
          { url: 'https://example.com/page3' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(3);
      
      expect(result.result).toHaveLength(3);
      result.result.forEach((item, index) => {
        expect(item).toEqual({
          url: `https://example.com/page${index + 1}`,
          success: true,
          max_depth: 3,
          outline: expect.any(Array)
        });
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait extraire le plan avec une profondeur personnalisée', async () => {
      const input = {
        urls: [
          { url: 'https://example.com' }
        ],
        max_depth: 2
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com',
        success: true,
        max_depth: 2,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait extraire le plan avec la profondeur maximale', async () => {
      const input = {
        urls: [
          { url: 'https://example.com' }
        ],
        max_depth: 6
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com',
        success: true,
        max_depth: 6,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait extraire le plan avec la profondeur minimale', async () => {
      const input = {
        urls: [
          { url: 'https://example.com' }
        ],
        max_depth: 1
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com',
        success: true,
        max_depth: 1,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec des paramètres de requête', async () => {
      const input = {
        urls: [
          { url: 'https://example.com?param=value' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com?param=value',
        expect.any(Object)
      );
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0].success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Gestion d\'erreurs', () => {
    test('devrait gérer les erreurs HTTP 404', async () => {
      const httpError = new Error('Request failed with status code 404');
      httpError.response = { 
        status: 404, 
        statusText: 'Not Found',
        data: 'Page not found'
      };
      axios.get.mockRejectedValue(httpError);
      
      const input = {
        urls: [
          { url: 'https://example.com/not-found' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/not-found',
        success: false,
        error: expect.stringContaining('404')
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les erreurs HTTP 500', async () => {
      const httpError = new Error('Request failed with status code 500');
      httpError.response = { 
        status: 500, 
        statusText: 'Internal Server Error',
        data: 'Server error'
      };
      axios.get.mockRejectedValue(httpError);
      
      const input = {
        urls: [
          { url: 'https://example.com/error' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/error',
        success: false,
        error: expect.stringContaining('500')
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les timeouts de réseau', async () => {
      const timeoutError = new Error('Timeout of 30000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      const input = {
        urls: [
          { url: 'https://example.com/slow' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/slow',
        success: false,
        error: expect.stringContaining('Timeout')
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les erreurs de connexion', async () => {
      const networkError = new Error('getaddrinfo ENOTFOUND example.com');
      networkError.code = 'ENOTFOUND';
      axios.get.mockRejectedValue(networkError);
      
      const input = {
        urls: [
          { url: 'https://nonexistent-domain.com' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://nonexistent-domain.com',
        success: false,
        error: expect.stringContaining('ENOTFOUND')
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les erreurs pour certaines URLs tout en traitant les autres', async () => {
      axios.get
        .mockResolvedValueOnce({ data: '# Page 1\n## Section 1' })
        .mockRejectedValueOnce(new Error('Erreur pour URL 2'))
        .mockResolvedValueOnce({ data: '# Page 3\n## Section 3' });
      
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' },
          { url: 'https://example.com/page3' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(3);
      expect(result.result[0].success).toBe(true);
      expect(result.result[1].success).toBe(false);
      expect(result.result[1].error).toContain('Erreur pour URL 2');
      expect(result.result[2].success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les erreurs pour toutes les URLs', async () => {
      axios.get.mockRejectedValue(new Error('Erreur générale'));
      
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(2);
      expect(result.result[0].success).toBe(false);
      expect(result.result[1].success).toBe(false);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Cas limites', () => {
    test('devrait gérer une liste vide d\'URLs', async () => {
      const input = {
        urls: []
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.result).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer un grand nombre d\'URLs', async () => {
      const urls = [];
      for (let i = 1; i <= 50; i++) {
        urls.push({ url: `https://example.com/page${i}` });
      }
      
      const input = { urls };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(50);
      expect(result.result).toHaveLength(50);
      
      result.result.forEach((item, index) => {
        expect(item.url).toBe(`https://example.com/page${index + 1}`);
        expect(item.success).toBe(true);
        expect(item.max_depth).toBe(3);
        expect(Array.isArray(item.outline)).toBe(true);
      });
      
      expect(result.error).toBeUndefined();
    });

    test('devrait valider et corriger les profondeurs extrêmes', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1' }
        ],
        max_depth: 10 // Au-delà de la limite de 6
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/page1',
        success: true,
        max_depth: 6, // Devrait être limité à 6
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait valider et corriger les profondeurs négatives', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1' }
        ],
        max_depth: -5 // Négatif
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/page1',
        success: true,
        max_depth: 1, // Devrait être limité à 1
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs très longues', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2000);
      const input = {
        urls: [
          { url: longUrl }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        `https://r.jina.ai/${longUrl}`,
        expect.any(Object)
      );
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0].success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les contenus très volumineux', async () => {
      const largeContent = '# Grand document Markdown\n\n' + 
        Array.from({ length: 1000 }, (_, i) => `## Section ${i}\n\nCeci est le contenu de la section ${i}.\n\n`).join('');
      axios.get.mockResolvedValue({ data: largeContent });
      
      const input = {
        urls: [
          { url: 'https://example.com/large' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/large',
        success: true,
        max_depth: 3,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les contenus sans titres', async () => {
      const contentWithoutHeadings = 'Ceci est un contenu sans aucun titre markdown.\nJuste du texte ordinaire.';
      axios.get.mockResolvedValue({ data: contentWithoutHeadings });
      
      const input = {
        urls: [
          { url: 'https://example.com/no-headings' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/no-headings',
        success: true,
        max_depth: 3,
        outline: [] // Devrait être un tableau vide
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les contenus avec des structures complexes', async () => {
      const complexContent = `# Titre Principal
## Sous-titre 1
### Sous-sous-titre 1.1
#### Sous-sous-sous-titre 1.1.1
##### Sous-sous-sous-sous-titre 1.1.1.1
###### Sous-sous-sous-sous-sous-titre 1.1.1.1.1
## Sous-titre 2
### Sous-sous-titre 2.1`;
      axios.get.mockResolvedValue({ data: complexContent });
      
      const input = {
        urls: [
          { url: 'https://example.com/complex' }
        ],
        max_depth: 6
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/complex',
        success: true,
        max_depth: 6,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });
  });

  describe('Validation des entrées', () => {
    test('devrait rejeter les entrées sans URLs', async () => {
      const input = {};
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('urls is required');
      expect(result.result).toBeUndefined();
    });

    test('devrait rejeter les URLs qui ne sont pas un tableau', async () => {
      const input = {
        urls: 'not-an-array'
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('urls must be an array');
      expect(result.result).toBeUndefined();
    });

    test('devrait rejeter les URLs null', async () => {
      const input = {
        urls: null
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.result).toBeUndefined();
    });

    test('devrait rejeter les éléments sans URL', async () => {
      const input = {
        urls: [
          { start_line: 1, end_line: 10 }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('url is required');
      expect(result.result).toBeUndefined();
    });

    test('devrait rejeter les éléments avec URL vide', async () => {
      const input = {
        urls: [
          { url: '' }
        ]
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('url is required');
      expect(result.result).toBeUndefined();
    });

    test('devrait accepter max_depth optionnel', async () => {
      const input = {
        urls: [
          { url: 'https://example.com' }
        ]
        // max_depth non spécifié, devrait utiliser la valeur par défaut (3)
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com',
        success: true,
        max_depth: 3, // Valeur par défaut
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait accepter max_depth comme nombre', async () => {
      const input = {
        urls: [
          { url: 'https://example.com' }
        ],
        max_depth: 4
      };
      
      const result = await extractMarkdownOutlineTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com',
        success: true,
        max_depth: 4,
        outline: expect.any(Array)
      });
      expect(result.error).toBeUndefined();
    });
  });

  describe('Métadonnées de l\'outil', () => {
    test('devrait avoir les bonnes métadonnées', () => {
      expect(extractMarkdownOutlineTool.name).toBe('extract_markdown_outline');
      expect(extractMarkdownOutlineTool.description).toBe('Extrait le plan hiérarchique des titres markdown avec numéros de ligne à partir d\'une liste d\'URLs');
      expect(extractMarkdownOutlineTool.inputSchema).toBeDefined();
      expect(typeof extractMarkdownOutlineTool.execute).toBe('function');
    });

    test('devrait avoir le schéma de validation correct', () => {
      const schema = extractMarkdownOutlineTool.inputSchema;
      
      expect(schema.type).toBe('object');
      expect(schema.properties.urls).toBeDefined();
      expect(schema.properties.urls.type).toBe('array');
      expect(schema.properties.urls.items).toBeDefined();
      expect(schema.properties.urls.items.type).toBe('object');
      expect(schema.properties.urls.items.properties.url).toBeDefined();
      expect(schema.properties.urls.items.properties.url.type).toBe('string');
      expect(schema.properties.urls.items.required).toEqual(['url']);
      expect(schema.properties.max_depth).toBeDefined();
      expect(schema.properties.max_depth.type).toBe('number');
      expect(schema.properties.max_depth.default).toBe(3);
      expect(schema.required).toEqual(['urls']);
    });
  });
});