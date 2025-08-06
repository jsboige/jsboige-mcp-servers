import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { setupTools } from './tools.js';
import { setupResources } from './resources.js';
import { setupErrorHandlers } from './utils/errorHandlers.js';

// Le GITHUB_TOKEN est maintenant injecté par la configuration du MCP.
console.log('[GP-MCP][INDEX] Début du script index.ts');
console.log('[INFO] Le serveur utilisera le GITHUB_TOKEN fourni par l\'environnement du processus.');

/**
 * Classe principale du serveur GitHub Projects MCP
 */
// Définition de la structure pour un compte GitHub
interface GitHubAccount {
    owner: string;
    token: string;
}

class GitHubProjectsServer {
  /** Instance du serveur MCP */
  private server: Server;
  private accounts: GitHubAccount[] = [];

  /**
   * Crée une instance du serveur GitHub Projects MCP
   */
  constructor() {
    console.log('[GP-MCP][INDEX] Entrée dans le constructeur de GitHubProjectsServer.');

    // Charger les comptes GitHub
    this.loadAccounts();

    this.server = new Server(
      {
        name: 'github-projects-mcp-v2',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    // Configurer les outils et les ressources, en passant les comptes
    setupTools(this.server, this.accounts);
    setupResources(this.server, this.accounts);
    
    // Configurer les gestionnaires d'erreurs
    setupErrorHandlers(this.server);
    
    // Gestion des erreurs
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private loadAccounts() {
    // Nouvelle méthode : lire une variable d'environnement contenant le JSON des comptes
    const accountsJson = process.env.GITHUB_ACCOUNTS_JSON;
    if (accountsJson) {
      try {
        this.accounts = JSON.parse(accountsJson);
        console.log(`[GP-MCP][INDEX] ${this.accounts.length} compte(s) GitHub chargé(s) depuis GITHUB_ACCOUNTS_JSON.`);
      } catch (e) {
        console.error('[GP-MCP][INDEX] Erreur de parsing de GITHUB_ACCOUNTS_JSON', e);
      }
    } else if (process.env.GITHUB_TOKEN) {
      // Rétrocompatibilité
      console.log('[GP-MCP][INDEX] Utilisation du GITHUB_TOKEN legacy.');
      this.accounts.push({ owner: 'default', token: process.env.GITHUB_TOKEN });
    } else {
      console.warn('[GP-MCP][INDEX] Aucun compte GitHub configuré. Le MCP fonctionnera en mode non authentifié.');
    }
  }

  /**
   * Démarre le serveur
   */
  async run() {
    try {
      console.log('[GP-MCP][INDEX] Exécution de la méthode run().');
      console.log('Démarrage du serveur MCP Gestionnaire de Projet...');
      const transport = new StdioServerTransport();
      console.log('[GP-MCP][INDEX] Avant server.connect().');
      await this.server.connect(transport);
      console.log('[GP-MCP][INDEX] Après server.connect() - Le serveur devrait être connecté.');
      console.log('Serveur MCP Gestionnaire de Projet démarré sur stdio');
    } catch (error) {
      console.error('Erreur lors du démarrage du serveur MCP:', error);
      process.exit(1);
    }
  }
}

// Créer et démarrer le serveur
const server = new GitHubProjectsServer();
server.run();