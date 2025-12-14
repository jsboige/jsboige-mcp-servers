/**
 * @fileoverview Types pour les sorties d'outils MCP JinaNavigator
 *
 * Ce fichier contient les définitions de types pour les résultats
 * des différents outils du serveur MCP JinaNavigator.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

/**
 * Interface pour les sorties d'outils
 * Définit la structure de retour des outils MCP
 *
 * @interface ToolOutput
 * @property {any} [result] - Résultat de l'opération en cas de succès
 * @property {Object} [error] - Informations d'erreur en cas d'échec
 * @property {string} error.message - Message d'erreur
 * @property {any} [error.details] - Détails supplémentaires sur l'erreur
 */
export interface ToolOutput {
  content?: Array<{
    type: string;
    text: string;
  }>;
  result?: any;
  error?: {
    message: string;
    details?: any;
  };
}

/**
 * Interface pour les résultats de conversion multiple
 *
 * @interface MultiConvertResult
 */
export interface MultiConvertResult {
  url: string;
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Interface pour les résultats d'extraction de plan
 *
 * @interface OutlineResult
 */
export interface OutlineResult {
  url: string;
  success: boolean;
  max_depth?: number;
  outline?: HeadingNode[];
  error?: string;
}

/**
 * Interface pour représenter un titre dans le plan
 *
 * @interface HeadingNode
 * @property {number} level - Niveau du titre (1 pour H1, 2 pour H2, etc.)
 * @property {string} text - Texte du titre
 * @property {number} line - Numéro de ligne où se trouve le titre
 * @property {HeadingNode[]} [children] - Sous-titres (enfants) de ce titre
 */
export interface HeadingNode {
  level: number;
  text: string;
  line: number;
  children?: HeadingNode[];
}

/**
 * Interface pour les résultats d'accès aux ressources
 *
 * @interface AccessResourceResult
 */
export interface AccessResourceResult {
  content: string;
  contentType: string;
}