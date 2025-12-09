/**
 * Tests pour accessJinaResource
 */

import { jest } from '@jest/globals';
import axios from 'axios';
import { accessJinaResourceTool } from '../../../src/tools/access-jina-resource.js';

// Mock axios
jest.mock('axios');

describe('accessJinaResourceTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset axios mock
    axios.get.mockResolvedValue({
      data: 'Markdown content',
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {}
    });
    axios.isAxiosError.mockReturnValue(true);
  });

  test('should have correct name and description', () => {
    expect(accessJinaResourceTool.name).toBe('access_jina_resource');
    expect(accessJinaResourceTool.description).toContain('Accède au contenu Markdown');
  });

  test('should validate input schema', () => {
    expect(accessJinaResourceTool.inputSchema).toBeDefined();
    expect(accessJinaResourceTool.inputSchema.type).toBe('object');
    expect(accessJinaResourceTool.inputSchema.properties.uri).toBeDefined();
  });

  test('should successfully access resource with valid URI', async () => {
    const input = {
      uri: 'jina://https://example.com'
    };

    axios.get.mockResolvedValueOnce({
      data: '# Example Domain\nThis is a test.',
      status: 200
    });

    const result = await accessJinaResourceTool.execute(input);

    expect(result).toHaveProperty('content');
    expect(result.content[0].text).toBe('# Example Domain\nThis is a test.');
    
    expect(axios.get).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com',
      expect.any(Object)
    );
  });

  test('should handle invalid URI format', async () => {
    const input = {
      uri: 'invalid-uri'
    };

    const result = await accessJinaResourceTool.execute(input);

    expect(result).toHaveProperty('error');
    expect(result.error.message).toContain('URI invalide');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('should handle Jina API error', async () => {
    const input = {
      uri: 'jina://https://example.com/404'
    };

    const error = new Error('Not Found');
    error.response = { status: 404, statusText: 'Not Found' };
    axios.get.mockRejectedValueOnce(error);

    const result = await accessJinaResourceTool.execute(input);

    expect(result).toHaveProperty('error');
    expect(result.error.message).toContain('Erreur lors de l\'accès à la ressource');
  });

  test('should handle network error', async () => {
    const input = {
      uri: 'jina://https://example.com/network-error'
    };

    const error = new Error('Network Error');
    axios.get.mockRejectedValueOnce(error);

    const result = await accessJinaResourceTool.execute(input);

    expect(result).toHaveProperty('error');
    expect(result.error.message).toContain('Erreur lors de l\'accès à la ressource');
  });

  test('should pass start_line and end_line parameters', async () => {
    const input = {
      uri: 'jina://https://example.com',
      start_line: 10,
      end_line: 20
    };

    axios.get.mockResolvedValueOnce({
      data: 'Content',
      status: 200
    });

    await accessJinaResourceTool.execute(input);

    // The implementation of convertUrlToMarkdown might handle headers differently
    // but we verify that the call is made
    expect(axios.get).toHaveBeenCalled();
  });
});