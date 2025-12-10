/**
 * @fileoverview Client HTTP pour l'API Jina
 *
 * Ce module contient les fonctions pour communiquer avec l'API Jina
 * afin de convertir des pages web en Markdown.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import axios from 'axios';

/**
 * Fonction utilitaire pour convertir une URL en Markdown via l'API Jina
 * Cette fonction est utilisée par les différents outils du serveur pour
 * effectuer la conversion et le filtrage du contenu
 *
 * @async
 * @function convertUrlToMarkdown
 * @param {string} url - URL de la page web à convertir
 * @param {number} [startLine] - Ligne de début pour filtrer le contenu (optionnel)
 * @param {number} [endLine] - Ligne de fin pour filtrer le contenu (optionnel)
 * @returns {Promise<string>} Contenu Markdown de la page web, éventuellement filtré
 * @throws {Error} En cas d'erreur lors de la conversion
 */
export async function convertUrlToMarkdown(url: string, startLine?: number, endLine?: number, config?: any): Promise<string> {
  try {
    // Construction de l'URL Jina
    const jinaUrl = `https://r.jina.ai/${url}`;
    
    // Préparation de la configuration Axios
    const axiosConfig = {
      headers: {
        'Accept': 'text/markdown',
        ...(config?.headers || {})
      },
      timeout: config?.timeout
    };

    // Appel à l'API Jina
    const response = await axios.get(jinaUrl, axiosConfig);
    
    // Récupération du contenu Markdown
    let markdownContent = typeof response.data === 'string' ? response.data : String(response.data || '');
    
    // Filtrage du contenu si des bornes sont spécifiées
    if (startLine !== undefined || endLine !== undefined) {
      const lines = markdownContent.split('\n');
      const startIndex = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
      const endIndex = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
      
      markdownContent = lines.slice(startIndex, endIndex).join('\n');
    }
    
    return markdownContent;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Erreur lors de la conversion: ${error.message}`);
    }
    throw new Error(`Erreur inattendue: ${(error as Error).message}`);
  }
}

/**
 * Fonction pour gérer les erreurs spécifiques à l'API Jina
 *
 * @function handleJinaErrors
 * @param {any} error - Erreur à traiter
 * @returns {string} Message d'erreur formaté
 */
export function handleJinaErrors(error: any): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error;
    if (axiosError.response) {
      // Le serveur a répondu avec un statut d'erreur
      return `Erreur HTTP ${axiosError.response.status}: ${axiosError.response.statusText}`;
    } else if (axiosError.request) {
      // La requête a été faite mais aucune réponse reçue
      return 'Erreur de réseau: Aucune réponse reçue du serveur Jina';
    } else {
      // Erreur lors de la configuration de la requête
      return `Erreur de configuration: ${axiosError.message}`;
    }
  }
  return `Erreur inattendue: ${(error as Error).message}`;
}