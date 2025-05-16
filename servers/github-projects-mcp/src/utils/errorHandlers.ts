import { MCPServer } from '@modelcontextprotocol/server';

/**
 * Configure les gestionnaires d'erreurs pour le serveur MCP
 * @param server Instance du serveur MCP
 */
export function setupErrorHandlers(server: MCPServer): void {
  // Gestionnaire d'erreurs pour les outils
  server.on('tool:error', (error, context) => {
    console.error(`Erreur lors de l'exécution de l'outil ${context.toolName}:`, error);
    
    // Journaliser des informations supplémentaires pour le débogage
    if (context.input) {
      console.error('Entrée de l\'outil:', JSON.stringify(context.input, null, 2));
    }
    
    // Vous pouvez ajouter ici une logique supplémentaire pour la gestion des erreurs,
    // comme l'envoi de notifications, l'enregistrement dans un système de suivi des erreurs, etc.
  });

  // Gestionnaire d'erreurs pour les ressources
  server.on('resource:error', (error, context) => {
    console.error(`Erreur lors de l'accès à la ressource ${context.resourceName}:`, error);
    
    // Journaliser des informations supplémentaires pour le débogage
    if (context.uri) {
      console.error('URI de la ressource:', context.uri);
    }
  });

  // Gestionnaire d'erreurs pour le serveur
  server.on('error', (error) => {
    console.error('Erreur du serveur MCP:', error);
  });

  // Gestionnaire pour les requêtes non valides
  server.on('invalid:request', (error, context) => {
    console.error('Requête non valide:', error);
    console.error('Contexte de la requête:', context);
  });

  // Gestionnaire pour les déconnexions de clients
  server.on('client:disconnect', (clientId) => {
    console.log(`Client déconnecté: ${clientId}`);
  });

  // Gestionnaire pour les nouvelles connexions de clients
  server.on('client:connect', (clientId) => {
    console.log(`Nouveau client connecté: ${clientId}`);
  });
}

/**
 * Classe d'erreur personnalisée pour les erreurs liées à GitHub Projects
 */
export class GitHubProjectsError extends Error {
  constructor(message: string, public code: string, public details?: any) {
    super(message);
    this.name = 'GitHubProjectsError';
  }
}

/**
 * Fonction utilitaire pour formater les erreurs de l'API GitHub
 * @param error Erreur d'origine
 * @returns Erreur formatée
 */
export function formatGitHubError(error: any): GitHubProjectsError {
  let message = 'Erreur inconnue lors de l\'interaction avec GitHub';
  let code = 'UNKNOWN_ERROR';
  let details = undefined;

  if (error.message) {
    message = error.message;
  }

  if (error.status) {
    code = `HTTP_${error.status}`;
  }

  if (error.errors) {
    details = error.errors;
  }

  return new GitHubProjectsError(message, code, details);
}