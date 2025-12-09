/**
 * @fileoverview Types pour les entrées d'outils MCP JinaNavigator
 *
 * Ce fichier contient les définitions de types pour les paramètres d'entrée
 * des différents outils du serveur MCP JinaNavigator.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

/**
 * Interface générique pour les entrées d'outils
 * Permet de typer les paramètres d'entrée des outils MCP
 *
 * @interface ToolInput
 */
export interface ToolInput {
  [key: string]: any;
}

/**
 * Interface pour les entrées de l'outil convert_web_to_markdown
 *
 * @interface ConvertWebToMarkdownInput
 */
export interface ConvertWebToMarkdownInput {
  url: string;
  start_line?: number;
  end_line?: number;
}

/**
 * Interface pour les entrées de l'outil access_jina_resource
 *
 * @interface AccessJinaResourceInput
 */
export interface AccessJinaResourceInput {
  uri: string;
  start_line?: number;
  end_line?: number;
}

/**
 * Interface pour les URLs dans l'outil multi_convert
 *
 * @interface MultiConvertUrl
 */
export interface MultiConvertUrl {
  url: string;
  start_line?: number;
  end_line?: number;
}

/**
 * Interface pour les entrées de l'outil multi_convert
 *
 * @interface ConvertMultipleWebsToMarkdownInput
 */
export interface ConvertMultipleWebsToMarkdownInput {
  urls: MultiConvertUrl[];
}

/**
 * Interface pour les URLs dans l'outil extract_markdown_outline
 *
 * @interface OutlineUrl
 */
export interface OutlineUrl {
  url: string;
}

/**
 * Interface pour les entrées de l'outil extract_markdown_outline
 *
 * @interface ExtractMarkdownOutlineInput
 */
export interface ExtractMarkdownOutlineInput {
  urls: OutlineUrl[];
  max_depth?: number;
}