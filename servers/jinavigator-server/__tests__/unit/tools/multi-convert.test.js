/**
 * Tests unitaires pour l'outil multi_convert
 * 
 * Ces tests couvrent tous les cas nominaux, d'erreur et limites
 * pour l'outil de conversion multiple de pages web en Markdown.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { convertMultipleWebsToMarkdownTool } from '../../../src/tools/multi-convert';

// Mock axios
jest.mock('axios');

// Données de test
const TEST_MARKDOWN_CONTENT = `# Titre de test
## Sous-titre
Ceci est un contenu Markdown de test.
- Point 1
- Point 2
- Point 3

### Section 1
Contenu de la section 1.

### Section 2
Contenu de la section 2.

## Autre section
Contenu d'une autre section.

# Titre final
Contenu final.`;

const TEST_LARGE_MARKDOWN = (() => {
  let content = '# Grand document Markdown\n\n';
  for (let i = 1; i <= 100; i++) {
    content += `## Section ${i}\n\nCeci est le contenu de la section ${i}.\n\n`;
  }
  return content;
})();

describe('multi_convert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('Cas nominaux', () => {
    test('devrait convertir plusieurs URLs en parallèle avec succès', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' },
          { url: 'https://example.com/page3' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(3);
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/page1',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/page2',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/page3',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.result).toHaveLength(3);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/page1',
        success: true,
        content: TEST_MARKDOWN_CONTENT
      });
      expect(result.result[1]).toEqual({
        url: 'https://example.com/page2',
        success: true,
        content: TEST_MARKDOWN_CONTENT
      });
      expect(result.result[2]).toEqual({
        url: 'https://example.com/page3',
        success: true,
        content: TEST_MARKDOWN_CONTENT
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait convertir plusieurs URLs avec des bornes différentes', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1', start_line: 1, end_line: 3 },
          { url: 'https://example.com/page2', start_line: 3, end_line: 6 },
          { url: 'https://example.com/page3', start_line: 6, end_line: 9 }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(3);
      
      const expectedContent1 = TEST_MARKDOWN_CONTENT.split('\n').slice(0, 3).join('\n');
      const expectedContent2 = TEST_MARKDOWN_CONTENT.split('\n').slice(2, 6).join('\n');
      const expectedContent3 = TEST_MARKDOWN_CONTENT.split('\n').slice(5, 9).join('\n');
      
      expect(result.result).toHaveLength(3);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/page1',
        success: true,
        content: expectedContent1
      });
      expect(result.result[1]).toEqual({
        url: 'https://example.com/page2',
        success: true,
        content: expectedContent2
      });
      expect(result.result[2]).toEqual({
        url: 'https://example.com/page3',
        success: true,
        content: expectedContent3
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait convertir une seule URL', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/single' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/single',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/single',
        success: true,
        content: TEST_MARKDOWN_CONTENT
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait convertir un grand nombre d\'URLs en parallèle', async () => {
      const urls = [];
      for (let i = 1; i <= 20; i++) {
        urls.push({ url: `https://example.com/page${i}` });
      }
      
      const input = { urls };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(20);
      expect(result.result).toHaveLength(20);
      
      result.result.forEach((item, index) => {
        expect(item).toEqual({
          url: `https://example.com/page${index + 1}`,
          success: true,
          content: TEST_MARKDOWN_CONTENT
        });
      });
      
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec des paramètres de requête', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1?param=value' },
          { url: 'https://example.com/page2?other=test' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/page1?param=value',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/page2?other=test',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.result).toHaveLength(2);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Gestion d\'erreurs', () => {
    test('devrait gérer les erreurs pour certaines URLs tout en traitant les autres', async () => {
      axios.get
        .mockResolvedValueOnce({ data: 'Contenu 1' })
        .mockRejectedValueOnce(new Error('Erreur pour URL 2'))
        .mockResolvedValueOnce({ data: 'Contenu 3' });
      
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' },
          { url: 'https://example.com/page3' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(result.result).toHaveLength(3);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/page1',
        success: true,
        content: 'Contenu 1'
      });
      expect(result.result[1]).toEqual({
        url: 'https://example.com/page2',
        success: false,
        error: 'Erreur de configuration: Erreur lors de la conversion: Erreur pour URL 2'
      });
      expect(result.result[2]).toEqual({
        url: 'https://example.com/page3',
        success: true,
        content: 'Contenu 3'
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les erreurs HTTP 404 pour certaines URLs', async () => {
      const httpError = new Error('Request failed with status code 404');
      httpError.response = { 
        status: 404, 
        statusText: 'Not Found',
        data: 'Page not found'
      };
      
      axios.get
        .mockResolvedValueOnce({ data: 'Contenu 1' })
        .mockRejectedValueOnce(httpError)
        .mockResolvedValueOnce({ data: 'Contenu 3' });
      
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/not-found' },
          { url: 'https://example.com/page3' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(result.result).toHaveLength(3);
      expect(result.result[0].success).toBe(true);
      expect(result.result[1].success).toBe(false);
      expect(result.result[1].error).toContain('Erreur lors de la conversion: Request failed with status code 404');
      expect(result.result[2].success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les timeouts pour certaines URLs', async () => {
      const timeoutError = new Error('Timeout of 30000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      
      axios.get
        .mockResolvedValueOnce({ data: 'Contenu 1' })
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce({ data: 'Contenu 3' });
      
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/slow' },
          { url: 'https://example.com/page3' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(result.result).toHaveLength(3);
      expect(result.result[0].success).toBe(true);
      expect(result.result[1].success).toBe(false);
      expect(result.result[1].error).toContain('Erreur lors de la conversion: Timeout of 30000ms exceeded');
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
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(result.result).toHaveLength(2);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/page1',
        success: false,
        error: 'Erreur de configuration: Erreur lors de la conversion: Erreur générale'
      });
      expect(result.result[1]).toEqual({
        url: 'https://example.com/page2',
        success: false,
        error: 'Erreur de configuration: Erreur lors de la conversion: Erreur générale'
      });
      expect(result.error).toBeUndefined();
    });
  });

  describe('Cas limites', () => {
    test('devrait gérer une liste vide d\'URLs', async () => {
      const input = {
        urls: []
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.result).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer un grand nombre d\'URLs', async () => {
      const urls = [];
      for (let i = 1; i <= 100; i++) {
        urls.push({ url: `https://example.com/page${i}` });
      }
      
      const input = { urls };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(100);
      expect(result.result).toHaveLength(100);
      
      result.result.forEach((item, index) => {
        expect(item.url).toBe(`https://example.com/page${index + 1}`);
        expect(item.success).toBe(true);
        expect(item.content).toBe(TEST_MARKDOWN_CONTENT);
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
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        `https://r.jina.ai/${longUrl}`,
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: longUrl,
        success: true,
        content: TEST_MARKDOWN_CONTENT
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les contenus très volumineux', async () => {
      const largeContent = TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      const input = {
        urls: [
          { url: 'https://example.com/large' }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: 'https://example.com/large',
        success: true,
        content: largeContent
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec des caractères spéciaux', async () => {
      const specialUrl = 'https://example.com/path/with-émojis-🚀-and-spaces%20and%20symbols';
      const input = {
        urls: [
          { url: specialUrl }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        `https://r.jina.ai/${specialUrl}`,
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual({
        url: specialUrl,
        success: true,
        content: TEST_MARKDOWN_CONTENT
      });
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les bornes de ligne extrêmes', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1', start_line: 1, end_line: 100000 },
          { url: 'https://example.com/page2', start_line: -5, end_line: 10 }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(result.result).toHaveLength(2);
      expect(result.result[0].success).toBe(true);
      expect(result.result[1].success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Validation des entrées', () => {
    test('devrait rejeter les entrées sans URLs', async () => {
      const input = {};
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('urls is required');
      expect(result.result).toBeUndefined();
    });

    test('devrait rejeter les URLs qui ne sont pas un tableau', async () => {
      const input = {
        urls: 'not-an-array'
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('urls must be an array');
      expect(result.result).toBeUndefined();
    });

    test('devrait rejeter les URLs null', async () => {
      const input = {
        urls: null
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
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
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
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
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('url is required');
      expect(result.result).toBeUndefined();
    });

    test('devrait accepter les bornes optionnelles', async () => {
      const input = {
        urls: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2', start_line: 5 },
          { url: 'https://example.com/page3', end_line: 10 },
          { url: 'https://example.com/page4', start_line: 3, end_line: 7 }
        ]
      };
      
      const result = await convertMultipleWebsToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledTimes(4);
      expect(result.result).toHaveLength(4);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Métadonnées de l\'outil', () => {
    test('devrait avoir les bonnes métadonnées', () => {
      expect(convertMultipleWebsToMarkdownTool.name).toBe('multi_convert');
      expect(convertMultipleWebsToMarkdownTool.description).toBe('Convertit plusieurs pages web en Markdown en une seule requête');
      expect(convertMultipleWebsToMarkdownTool.inputSchema).toBeDefined();
      expect(typeof convertMultipleWebsToMarkdownTool.execute).toBe('function');
    });

    test('devrait avoir le schéma de validation correct', () => {
      const schema = convertMultipleWebsToMarkdownTool.inputSchema;
      
      expect(schema.type).toBe('object');
      expect(schema.properties.urls).toBeDefined();
      expect(schema.properties.urls.type).toBe('array');
      expect(schema.properties.urls.items).toBeDefined();
      expect(schema.properties.urls.items.type).toBe('object');
      expect(schema.properties.urls.items.properties.url).toBeDefined();
      expect(schema.properties.urls.items.properties.url.type).toBe('string');
      expect(schema.properties.urls.items.properties.start_line).toBeDefined();
      expect(schema.properties.urls.items.properties.start_line.type).toBe('number');
      expect(schema.properties.urls.items.properties.end_line).toBeDefined();
      expect(schema.properties.urls.items.properties.end_line.type).toBe('number');
      expect(schema.properties.urls.items.required).toEqual(['url']);
      expect(schema.required).toEqual(['urls']);
    });
  });
});