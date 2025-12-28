/**
 * Configuration pour les tests d'intégration
 * 
 * Ce fichier contient la configuration globale pour les tests d'intégration
 * du serveur JinaNavigator, y compris les utilitaires pour les tests
 * de communication client-serveur.
 */

import { jest } from '@jest/globals';
import { spawn } from 'child_process';
import path from 'path';

// Obtenir le chemin du répertoire actuel
const projectRoot = path.resolve(__dirname, '../..');

// Configuration du timeout pour les tests d'intégration
jest.setTimeout(30000);

// Utilitaires pour les tests d'intégration
export const createTestServer = () => {
  const serverPath = path.join(projectRoot, 'dist/index.js');
  
  return spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' }
  });
};

export const parseServerResponse = (data) => {
  try {
    const lines = data.toString().trim().split('\n');
    return lines
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.warn(`Impossible de parser la ligne comme JSON: ${line}`);
          return null;
        }
      })
      .filter(json => json !== null);
  } catch (e) {
    console.error('Erreur lors du parsing de la réponse:', e);
    return [];
  }
};

export const sendMcpRequest = (server, request) => {
  return new Promise((resolve, reject) => {
    const requestId = request.id;
    let responses = [];
    
    const dataHandler = (data) => {
      const parsedResponses = parseServerResponse(data);
      responses = responses.concat(parsedResponses);
      
      const response = responses.find(r => r.id === requestId);
      if (response) {
        server.stdout.off('data', dataHandler);
        resolve(response);
      }
    };
    
    server.stdout.on('data', dataHandler);
    server.stdin.write(JSON.stringify(request) + '\n');
    
    // Timeout après 10 secondes
    setTimeout(() => {
      server.stdout.off('data', dataHandler);
      reject(new Error('Timeout lors de l\'attente de la réponse du serveur'));
    }, 10000);
  });
};

export const createListToolsRequest = (id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'mcp.list_tools',
  params: {}
});

export const createCallToolRequest = (toolName, args, id = 2) => ({
  jsonrpc: '2.0',
  id,
  method: 'mcp.call_tool',
  params: {
    name: toolName,
    arguments: args
  }
});

// Attacher aux globals pour compatibilité
global.createTestServer = createTestServer;
global.parseServerResponse = parseServerResponse;
global.sendMcpRequest = sendMcpRequest;
global.createListToolsRequest = createListToolsRequest;
global.createCallToolRequest = createCallToolRequest;

// Nettoyage après chaque test
afterEach(async () => {
  // Attendre un peu pour permettre au serveur de se nettoyer
  await new Promise(resolve => setTimeout(resolve, 100));
});