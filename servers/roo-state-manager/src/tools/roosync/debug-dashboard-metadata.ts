import { z } from 'zod';
import { debugDashboard } from './debug-dashboard.js';

/**
 * Schéma pour l'outil debug_dashboard
 */
export const debugDashboardSchema = z.object({
  // Pas de paramètres requis pour cet outil de diagnostic
});

/**
 * Métadonnées pour l'outil debug_dashboard
 */
export const debugDashboardToolMetadata = {
  name: 'debug_dashboard',
  description: '🔧 OUTIL DE DIAGNOSTIC CRITIQUE - Force la réinitialisation du cache et rechargement du dashboard RooSync pour identifier les problèmes de cache',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  }
};

// Export de la fonction pour utilisation dans le registre MCP
export { debugDashboard };