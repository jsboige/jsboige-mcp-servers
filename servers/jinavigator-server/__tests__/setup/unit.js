/**
 * Configuration pour les tests unitaires
 * 
 * Ce fichier contient la configuration globale pour les tests unitaires
 * du serveur JinaNavigator, y compris les mocks et utilitaires communs.
 */

import { jest } from '@jest/globals';

// Mock global pour axios
export const mockAxios = {
  get: jest.fn(),
  isAxiosError: jest.fn(() => false),
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn()
  }))
};

jest.mock('axios', () => {
  const mock = {
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
    default: mock,
    ...mock
  };
});

// Récupérer le mock pour l'exporter globalement
import axios from 'axios';
global.mockAxios = axios;
global.axios = axios;

// Exporter le mock pour utilisation dans les tests
global.mockAxios = mockAxios;
global.axios = mockAxios;

// Mock global pour le SDK MCP
jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn(),
    close: jest.fn(),
    onerror: null
  }))
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: { name: 'CallToolRequestSchema' },
  ListToolsRequestSchema: { name: 'ListToolsRequestSchema' },
  McpError: jest.fn().mockImplementation((code, message) => ({
    name: 'McpError',
    code,
    message
  })),
  ErrorCode: {
    MethodNotFound: 'MethodNotFound',
    InternalError: 'InternalError',
    InvalidParams: 'InvalidParams'
  }
}));

// Utilitaires de test globaux
global.createMockRequest = (toolName, args) => ({
  params: {
    name: toolName,
    arguments: args || {}
  }
});

global.createMockAxiosResponse = (data, status = 200) => ({
  data,
  status,
  statusText: 'OK',
  headers: {},
  config: {}
});

global.createMockAxiosError = (message, code = 'UNKNOWN', response = null) => {
  const error = new Error(message);
  error.code = code;
  error.response = response;
  error.isAxiosError = true;
  return error;
};

// Données de test communes
global.TEST_MARKDOWN_CONTENT = `# Titre de test
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

global.TEST_LARGE_MARKDOWN = (() => {
  let content = '# Grand document Markdown\n\n';
  for (let i = 1; i <= 100; i++) {
    content += `## Section ${i}\n\nCeci est le contenu de la section ${i}.\n\n`;
  }
  return content;
})();

// Configuration du timeout pour les tests asynchrones
jest.setTimeout(10000);

// Nettoyage après chaque test
afterEach(() => {
  jest.clearAllMocks();
});