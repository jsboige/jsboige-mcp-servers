/**
 * Tests unitaires pour le client Jina
 * 
 * Ces tests couvrent tous les cas nominaux, d'erreur et limites
 * pour le client HTTP qui communique avec l'API Jina.
 */

import { jest } from '@jest/globals';

jest.mock('axios', () => {
  const mockAxios = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    isAxiosError: jest.fn(() => false),
    create: jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn()
    }))
  };
  return {
    __esModule: true,
    default: mockAxios,
    ...mockAxios
  };
});

import axios from 'axios';
import { convertUrlToMarkdown, handleJinaErrors } from '../../../src/utils/jina-client';
import '../../setup/unit.js'; // Import setup to get globals and mocks

describe('JinaClient Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock par défaut pour axios
    axios.get.mockResolvedValue({
      data: global.TEST_MARKDOWN_CONTENT
    });
    
    // Mock pour isAxiosError
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('convertUrlToMarkdown', () => {
    test('devrait convertir une URL en Markdown avec succès', async () => {
      const url = 'https://example.com';
      const result = await convertUrlToMarkdown(url);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com',
        {
          headers: {
            'Accept': 'text/markdown'
          }
        }
      );
      
      expect(result).toBe(global.TEST_MARKDOWN_CONTENT);
    });

    test('devrait convertir une URL avec des paramètres de requête', async () => {
      const url = 'https://example.com?param=value&other=test';
      const result = await convertUrlToMarkdown(url);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com?param=value&other=test',
        expect.any(Object)
      );
      
      expect(result).toBe(global.TEST_MARKDOWN_CONTENT);
    });

    test('devrait convertir une URL avec des fragments', async () => {
      const url = 'https://example.com#section';
      const result = await convertUrlToMarkdown(url);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com#section',
        expect.any(Object)
      );
      
      expect(result).toBe(global.TEST_MARKDOWN_CONTENT);
    });

    test('devrait gérer les URLs avec des caractères spéciaux', async () => {
      const url = 'https://example.com/path with spaces/émojis-🚀.html';
      const result = await convertUrlToMarkdown(url);
      
      expect(axios.get).toHaveBeenCalledWith(
        'https://r.jina.ai/https://example.com/path with spaces/émojis-🚀.html',
        expect.any(Object)
      );
      
      expect(result).toBe(global.TEST_MARKDOWN_CONTENT);
    });

    test('devrait filtrer le contenu par lignes', async () => {
      const url = 'https://example.com';
      const content = 'Ligne 1\nLigne 2\nLigne 3\nLigne 4\nLigne 5';
      axios.get.mockResolvedValue({ data: content });

      const result = await convertUrlToMarkdown(url, 2, 4);
      
      expect(result).toBe('Ligne 2\nLigne 3\nLigne 4');
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
      
      const url = 'https://example.com/not-found';
      
      await expect(convertUrlToMarkdown(url)).rejects.toThrow('Erreur lors de la conversion: Request failed with status code 404');
    });

    test('devrait gérer les erreurs HTTP 500', async () => {
      const httpError = new Error('Request failed with status code 500');
      httpError.response = { 
        status: 500, 
        statusText: 'Internal Server Error',
        data: 'Server error'
      };
      axios.get.mockRejectedValue(httpError);
      
      const url = 'https://example.com/error';
      
      await expect(convertUrlToMarkdown(url)).rejects.toThrow('Erreur lors de la conversion: Request failed with status code 500');
    });

    test('devrait gérer les erreurs inattendues', async () => {
      const genericError = new Error('Network error');
      axios.get.mockRejectedValue(genericError);
      axios.isAxiosError.mockReturnValue(false);
      
      const url = 'https://example.com';
      
      await expect(convertUrlToMarkdown(url)).rejects.toThrow('Erreur inattendue: Network error');
    });
  });

  describe('handleJinaErrors', () => {
    test('devrait formater les erreurs HTTP', () => {
      const error = {
        response: {
          status: 404,
          statusText: 'Not Found'
        }
      };
      axios.isAxiosError.mockReturnValue(true);
      
      expect(handleJinaErrors(error)).toBe('Erreur HTTP 404: Not Found');
    });

    test('devrait formater les erreurs réseau', () => {
      const error = {
        request: {}
      };
      axios.isAxiosError.mockReturnValue(true);
      
      expect(handleJinaErrors(error)).toBe('Erreur de réseau: Aucune réponse reçue du serveur Jina');
    });

    test('devrait formater les erreurs de configuration', () => {
      const error = {
        message: 'Config error'
      };
      axios.isAxiosError.mockReturnValue(true);
      
      expect(handleJinaErrors(error)).toBe('Erreur de configuration: Config error');
    });

    test('devrait formater les erreurs inattendues', () => {
      const error = new Error('Unknown error');
      axios.isAxiosError.mockReturnValue(false);
      
      expect(handleJinaErrors(error)).toBe('Erreur inattendue: Unknown error');
    });
  });
});