/**
 * Tests unitaires pour l'outil convert_web_to_markdown
 * 
 * Ces tests couvrent tous les cas nominaux, d'erreur et limites
 * pour l'outil de conversion de pages web en Markdown.
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { convertWebToMarkdownTool } from '../../../src/tools/convert-web-to-markdown.js';
import '../../setup/unit.js'; // Import setup to get globals and mocks

// Mock axios
jest.mock('axios');

// Données de test locales
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

describe('convert_web_to_markdown', () => {
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
    test('devrait convertir une page web en Markdown avec succès', async () => {
      const input = {
        url: 'https://example.com'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
      expect(result.error).toBeUndefined();
    });

    test('devrait convertir une page web avec des paramètres de ligne', async () => {
      const input = {
        url: 'https://example.com',
        start_line: 3,
        end_line: 6
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      const expectedContent = TEST_MARKDOWN_CONTENT.split('\n').slice(2, 6).join('\n');
      expect(result.content[0].text).toBe(expectedContent);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec des paramètres de requête', async () => {
      const input = {
        url: 'https://example.com?param1=value1&param2=value2'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com?param1=value1&param2=value2',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec des fragments', async () => {
      const input = {
        url: 'https://example.com#section1'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com#section1',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec des ports personnalisés', async () => {
      const input = {
        url: 'https://example.com:8080/path'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com:8080/path',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
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
        url: 'https://example.com/not-found'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion: Request failed with status code 404');
      expect(result.error.details).toBe('Pas de détails disponibles');
      expect(result.content).toBeUndefined();
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
        url: 'https://example.com/error'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion: Request failed with status code 500');
      expect(result.error.details).toBe('Pas de détails disponibles');
      expect(result.content).toBeUndefined();
    });

    test('devrait gérer les timeouts de réseau', async () => {
      const timeoutError = new Error('Timeout of 30000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);
      
      const input = {
        url: 'https://example.com/slow'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion: Timeout of 30000ms exceeded');
    });

    test('devrait gérer les erreurs de connexion', async () => {
      const networkError = new Error('getaddrinfo ENOTFOUND example.com');
      networkError.code = 'ENOTFOUND';
      axios.get.mockRejectedValue(networkError);
      
      const input = {
        url: 'https://nonexistent-domain.com'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion: getaddrinfo ENOTFOUND example.com');
    });

    test('devrait gérer les erreurs de configuration', async () => {
      const configError = new Error('Invalid URL');
      axios.get.mockRejectedValue(configError);
      axios.isAxiosError.mockReturnValue(false);
      
      const input = {
        url: 'invalid-url'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur inattendue: Invalid URL');
    });

    test('devrait gérer les réponses vides du serveur', async () => {
      axios.get.mockResolvedValue({ data: '' });
      
      const input = {
        url: 'https://example.com/empty'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.content[0].text).toBe('');
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les réponses null du serveur', async () => {
      axios.get.mockResolvedValue({ data: null });
      
      const input = {
        url: 'https://example.com/null'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.content[0].text).toBe('');
      expect(result.error).toBeUndefined();
    });
  });

  describe('Cas limites', () => {
    test('devrait gérer les URLs très longues', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2000);
      const input = { url: longUrl };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        `https://r.jina.ai/${longUrl}`,
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les bornes de ligne extrêmes', async () => {
      const input = {
        url: 'https://example.com',
        start_line: 1,
        end_line: 100000
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      // Le contenu devrait être tronqué à la fin du contenu réel
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les bornes de ligne inversées', async () => {
      const input = {
        url: 'https://example.com',
        start_line: 10,
        end_line: 5
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      // Le résultat devrait être vide car start > end
      expect(result.content[0].text).toBe('');
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les bornes de ligne négatives', async () => {
      const input = {
        url: 'https://example.com',
        start_line: -5,
        end_line: 10
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      // Les valeurs négatives devraient être traitées comme 0
      const expectedContent = TEST_MARKDOWN_CONTENT.split('\n').slice(0, 10).join('\n');
      expect(result.content[0].text).toBe(expectedContent);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les contenus très volumineux', async () => {
      const largeContent = global.TEST_LARGE_MARKDOWN;
      axios.get.mockResolvedValue({ data: largeContent });
      
      const input = {
        url: 'https://example.com/large'
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.content[0].text).toBe(largeContent);
      expect(result.error).toBeUndefined();
    });

    test('devrait gérer les URLs avec caractères spéciaux', async () => {
      const specialUrl = 'https://example.com/path/with-émojis-🚀-and-spaces%20and%20symbols';
      const input = { url: specialUrl };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(axios.get).toHaveBeenCalledWith(
        `https://r.jina.ai/${specialUrl}`,
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result.content[0].text).toBe(TEST_MARKDOWN_CONTENT);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Validation des entrées', () => {
    test('devrait gérer les entrées sans URL', async () => {
      const input = {};
      
      // Mock une erreur pour l'appel avec URL undefined
      const error = new Error('Cannot read property \'split\' of undefined');
      axios.get.mockRejectedValue(error);
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion');
    });

    test('devrait gérer les URLs null', async () => {
      const input = { url: null };
      
      // Mock une erreur pour l'appel avec URL null
      const error = new Error('Cannot read property \'split\' of null');
      axios.get.mockRejectedValue(error);
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion');
    });

    test('devrait gérer les URLs undefined', async () => {
      const input = { url: undefined };
      
      // Mock une erreur pour l'appel avec URL undefined
      const error = new Error('Cannot read property \'split\' of undefined');
      axios.get.mockRejectedValue(error);
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion');
    });

    test('devrait gérer les URLs vides', async () => {
      const input = { url: '' };
      
      // Mock une erreur pour l'appel avec URL vide
      const error = new Error('Request failed with status code 400');
      error.response = { status: 400, data: 'Bad Request' };
      axios.get.mockRejectedValue(error);
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Erreur lors de la conversion');
    });

    test('devrait accepter les bornes de ligne optionnelles', async () => {
      const input = {
        url: 'https://example.com',
        start_line: 5
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      const expectedContent = TEST_MARKDOWN_CONTENT.split('\n').slice(4).join('\n');
      expect(result.content[0].text).toBe(expectedContent);
      expect(result.error).toBeUndefined();
    });

    test('devrait accepter seulement end_line', async () => {
      const input = {
        url: 'https://example.com',
        end_line: 5
      };
      
      const result = await convertWebToMarkdownTool.execute(input);
      
      const expectedContent = TEST_MARKDOWN_CONTENT.split('\n').slice(0, 5).join('\n');
      expect(result.content[0].text).toBe(expectedContent);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Métadonnées de l\'outil', () => {
    test('devrait avoir les bonnes métadonnées', () => {
      expect(convertWebToMarkdownTool.name).toBe('convert_web_to_markdown');
      expect(convertWebToMarkdownTool.description).toBe('Convertit une page web en Markdown en utilisant l\'API Jina');
      expect(convertWebToMarkdownTool.inputSchema).toBeDefined();
      expect(typeof convertWebToMarkdownTool.execute).toBe('function');
    });

    test('devrait avoir le schéma de validation correct', () => {
      const schema = convertWebToMarkdownTool.inputSchema;
      
      expect(schema.type).toBe('object');
      expect(schema.properties.url).toBeDefined();
      expect(schema.properties.url.type).toBe('string');
      expect(schema.properties.start_line).toBeDefined();
      expect(schema.properties.start_line.type).toBe('number');
      expect(schema.properties.end_line).toBeDefined();
      expect(schema.properties.end_line.type).toBe('number');
      expect(schema.required).toEqual(['url']);
    });
  });
});