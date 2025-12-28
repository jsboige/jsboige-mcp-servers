/**
 * @fileoverview Type pour les outils JinaNavigator
 *
 * Ce fichier contient la définition du type JinaTool qui étend
 * l'interface Tool du SDK MCP avec une méthode d'exécution.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { ToolInput } from './tool-inputs';
import { ToolOutput } from './tool-outputs';

/**
 * Interface pour les outils JinaNavigator
 * Étend l'interface Tool du SDK MCP avec une méthode d'exécution
 *
 * @interface JinaTool
 * @property {string} name - Nom de l'outil
 * @property {string} description - Description de l'outil
 * @property {object} inputSchema - Schéma de validation des entrées
 * @property {Function} execute - Fonction d'exécution de l'outil
 */
export interface JinaTool {
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: ToolInput) => Promise<ToolOutput>;
}