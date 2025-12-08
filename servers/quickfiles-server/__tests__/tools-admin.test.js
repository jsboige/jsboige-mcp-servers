/**
 * Tests unitaires pour le module tools/admin de QuickFiles Server
 * 
 * Ces tests vérifient les fonctionnalités d'administration :
 * - RestartMcpServers : redémarrage des serveurs MCP
 */

const mockFs = require('mock-fs');
const path = require('path');

// Import des classes compilées JavaScript
const restartMcpServersModule = require('../../build/tools/admin/restartMcpServers');
const utilsModule = require('../../build/core/utils');

const RestartMcpServersTool = restartMcpServersModule.RestartMcpServersTool;
const QuickFilesUtils = utilsModule.QuickFilesUtils;

describe('QuickFiles Tools Admin Module', () => {
  let restartMcpServers;
  let utils;

  beforeEach(() => {
    utils = new QuickFilesUtils();
    restartMcpServers = new RestartMcpServersTool(utils);
  });

  afterEach(() => {
    mockFs.restore();
  });

  describe('RestartMcpServers', () => {
    describe('handle', () => {
      test('devrait redémarrer un seul serveur', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                args: ['--port', '3001'],
                watchPaths: ['watch1.js']
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
        expect(result.content[0].text).toContain('redémarré');
      });

      test('devrait redémarrer plusieurs serveurs', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                args: ['--port', '3001'],
                watchPaths: ['watch1.js']
              },
              'server2': {
                command: 'node server2.js',
                args: ['--port', '3002'],
                watchPaths: ['watch2.js']
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1', 'server2']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
        expect(result.content[0].text).toContain('server2');
      });

      test('devrait gérer les serveurs inexistants', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'existing-server': {
                command: 'node existing.js',
                args: [],
                watchPaths: ['watch.js']
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['nonexistent-server']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('nonexistent-server');
        expect(result.content[0].text).toContain('non trouvé');
      });

      test('devrait gérer les erreurs de lecture du fichier de settings', async () => {
        mockFs({
          'mcp_settings.json': 'invalid json content'
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Aucun serveur MCP trouvé');
      });

      test('devrait gérer les fichiers de settings invalides', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {}
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Aucun serveur MCP trouvé');
      });

      test('devrait gérer les serveurs sans watchPaths', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                args: ['--port', '3001']
                // Pas de watchPaths
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
        expect(result.content[0].text).toContain('aucun watchPath');
      });

      test('devrait gérer les serveurs avec configuration incomplète', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                // Configuration minimale
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
      });

      test('devrait gérer le fichier mcp_settings.json inexistant', async () => {
        // Pas de fichier mockFs = fichier inexistant

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('Fichier mcp_settings.json non trouvé');
      });

      test('devrait valider les paramètres manquants', async () => {
        const request = {
          params: {
            arguments: {}
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('servers est requis');
      });

      test('devrait gérer les erreurs de watchPaths invalides', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                args: [],
                watchPaths: ['nonexistent-watch.js']
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('❌ server1');
      });

      test('devrait créer le répertoire parent si nécessaire', async () => {
        mockFs({
          'config': {
            'mcp_settings.json': JSON.stringify({
              mcpServers: {
                'server1': {
                  command: 'node server1.js',
                  args: [],
                  watchPaths: ['config/watch.js']
                }
              }
            })
          }
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
      });

      test('devrait gérer les requêtes sans params', async () => {
        const request = { servers: ['server1'] };

        const result = await restartMcpServers.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du redémarrage des serveurs MCP');
      });

      test('devrait gérer les requêtes sans arguments', async () => {
        const request = { params: {} };

        const result = await restartMcpServers.handle(request);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Erreur lors du redémarrage des serveurs MCP');
      });

      test('devrait gérer les serveurs avec args existants', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                args: ['--existing', 'args'],
                watchPaths: ['watch.js']
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
        expect(result.content[0].text).toContain('--existing');
        expect(result.content[0].text).toContain('--args');
      });

      test('devrait gérer les serveurs sans args', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                watchPaths: ['watch.js']
                // Pas d'args
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('server1');
      });

      test('devrait générer un rapport détaillé', async () => {
        mockFs({
          'mcp_settings.json': JSON.stringify({
            mcpServers: {
              'server1': {
                command: 'node server1.js',
                args: ['--port', '3001'],
                watchPaths: ['watch1.js']
              },
              'server2': {
                command: 'node server2.js',
                args: ['--port', '3002'],
                watchPaths: ['watch2.js']
              }
            }
          })
        });

        const request = {
          params: {
            arguments: {
              servers: ['server1', 'server2']
            }
          }
        };

        const result = await restartMcpServers.handle(request);

        expect(result.content).toBeDefined();
        expect(result.content[0].text).toContain('# Redémarrage des serveurs MCP');
        expect(result.content[0].text).toContain('## Serveurs redémarrés avec succès:');
        expect(result.content[0].text).toContain('- ✅ server1');
        expect(result.content[0].text).toContain('- ✅ server2');
        expect(result.content[0].text).toContain('**Note:** Les serveurs MCP devraient se redémarrer automatiquement');
      });
    });
  });
});