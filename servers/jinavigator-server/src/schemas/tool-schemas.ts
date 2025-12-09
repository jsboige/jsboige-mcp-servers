/**
 * @fileoverview Schémas de validation pour les outils MCP JinaNavigator
 *
 * Ce fichier contient les schémas de validation JSON Schema pour
 * les paramètres d'entrée des différents outils du serveur MCP JinaNavigator.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

/**
 * Schéma d'entrée pour l'outil convert_web_to_markdown
 * Définit la structure des paramètres attendus pour la conversion d'une page web en Markdown
 *
 * @constant {Object} convertWebToMarkdownSchema
 * @property {string} url - URL de la page web à convertir en Markdown
 * @property {number} [start_line] - Ligne de début pour extraire une partie spécifique du contenu
 * @property {number} [end_line] - Ligne de fin pour extraire une partie spécifique du contenu
 */
export const convertWebToMarkdownSchema = {
  type: "object" as const,
  properties: {
    url: {
      type: "string",
      description: 'URL de la page web à convertir en Markdown'
    },
    start_line: {
      type: "number",
      description: 'Ligne de début pour extraire une partie spécifique du contenu (optionnel)'
    },
    end_line: {
      type: "number",
      description: 'Ligne de fin pour extraire une partie spécifique du contenu (optionnel)'
    }
  },
  required: ['url']
};

/**
 * Schéma d'entrée pour l'outil multi_convert
 * Définit la structure des paramètres attendus pour la conversion de plusieurs pages web en Markdown
 *
 * @constant {Object} convertMultipleWebsToMarkdownSchema
 * @property {Array<Object>} urls - Liste des URLs à convertir avec leurs paramètres
 * @property {string} urls[].url - URL de la page web à convertir
 * @property {number} [urls[].start_line] - Ligne de début pour l'extrait
 * @property {number} [urls[].end_line] - Ligne de fin pour l'extrait
 */
export const convertMultipleWebsToMarkdownSchema = {
  type: "object" as const,
  properties: {
    urls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: 'URL de la page web à convertir en Markdown'
          },
          start_line: {
            type: "number",
            description: 'Ligne de début pour extraire une partie spécifique du contenu (optionnel)'
          },
          end_line: {
            type: "number",
            description: 'Ligne de fin pour extraire une partie spécifique du contenu (optionnel)'
          }
        },
        required: ['url']
      },
      description: 'Liste des URLs à convertir en Markdown avec leurs paramètres de bornage'
    }
  },
  required: ['urls']
};

/**
 * Schéma d'entrée pour l'outil extract_markdown_outline
 * Définit la structure des paramètres attendus pour extraire le plan des titres markdown
 * à partir d'une liste d'URLs
 *
 * @constant {Object} extractMarkdownOutlineSchema
 * @property {Array<Object>} urls - Liste des URLs à analyser
 * @property {string} urls[].url - URL de la page web à analyser
 * @property {number} [max_depth=3] - Profondeur maximale des titres à extraire (1=h1, 2=h1+h2, etc.)
 */
export const extractMarkdownOutlineSchema = {
  type: "object" as const,
  properties: {
    urls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: 'URL de la page web dont on veut extraire le plan des titres'
          }
        },
        required: ['url']
      },
      description: 'Liste des URLs à analyser pour extraire le plan des titres'
    },
    max_depth: {
      type: "number",
      description: 'Profondeur maximale des titres à extraire (1=h1, 2=h1+h2, etc.)',
      default: 3
    }
  },
  required: ['urls']
};

/**
 * Schéma d'entrée pour l'outil access_jina_resource
 * Définit la structure des paramètres attendus pour accéder au contenu
 * d'une page web via un URI au format jina://{url}
 *
 * @constant {Object} accessJinaResourceSchema
 * @property {string} uri - URI au format jina://{url}
 * @property {number} [start_line] - Ligne de début pour l'extrait (optionnel)
 * @property {number} [end_line] - Ligne de fin pour l'extrait (optionnel)
 */
export const accessJinaResourceSchema = {
  type: "object" as const,
  properties: {
    uri: {
      type: "string",
      description: 'URI au format jina://{url} pour accéder au contenu Markdown d\'une page web'
    },
    start_line: {
      type: "number",
      description: 'Ligne de début pour extraire une partie spécifique du contenu (optionnel)'
    },
    end_line: {
      type: "number",
      description: 'Ligne de fin pour extraire une partie spécifique du contenu (optionnel)'
    }
  },
  required: ['uri']
};