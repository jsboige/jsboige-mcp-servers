/**
 * @fileoverview Utilitaires de parsing Markdown
 *
 * Ce module contient les fonctions pour analyser et manipuler
 * le contenu Markdown, notamment l'extraction des plans de titres.
 *
 * @author JinaNavigator Team
 * @version 1.0.0
 */

import { HeadingNode } from '../types/index.js';

/**
 * Fonction utilitaire pour extraire le plan des titres d'un contenu Markdown
 * Cette fonction analyse le contenu ligne par ligne pour identifier les titres
 * et leur niveau, en enregistrant également leur numéro de ligne
 *
 * @function extractMarkdownOutline
 * @param {string} markdownContent - Contenu Markdown à analyser
 * @param {number} [maxDepth=3] - Profondeur maximale des titres à extraire (1=h1, 2=h1+h2, etc.)
 * @returns {Array<HeadingNode>} Structure hiérarchique des titres avec leur niveau, texte et numéro de ligne
 */
export function extractMarkdownOutline(markdownContent: string, maxDepth: number = 3): Array<HeadingNode> {
  const lines = markdownContent.split('\n');
  const flatHeadings: Array<HeadingNode> = [];
  
  // Expression régulière pour détecter les titres markdown (# Titre)
  const headingRegex = /^(#{1,6})\s+(.+)$/;
  
  // Première passe : extraire tous les titres jusqu'au niveau maxDepth
  lines.forEach((line, index) => {
    const match = line.match(headingRegex);
    if (match) {
      const level = match[1].length; // Nombre de # = niveau du titre
      const text = match[2].trim();  // Texte du titre sans les # et espaces
      
      // Ne garder que les titres jusqu'au niveau maxDepth
      if (level <= maxDepth) {
        flatHeadings.push({
          level,
          text,
          line: index + 1 // Les numéros de ligne commencent à 1
        });
      }
    }
  });
  
  // Deuxième passe : construire la structure hiérarchique
  const rootHeadings: Array<HeadingNode> = [];
  const headingStack: Array<HeadingNode> = [];
  
  flatHeadings.forEach(heading => {
    // Vider la pile jusqu'à trouver un parent approprié
    while (
      headingStack.length > 0 &&
      headingStack[headingStack.length - 1].level >= heading.level
    ) {
      headingStack.pop();
    }
    
    // Si la pile est vide, c'est un titre racine
    if (headingStack.length === 0) {
      rootHeadings.push(heading);
    } else {
      // Sinon, c'est un enfant du dernier titre dans la pile
      const parent = headingStack[headingStack.length - 1];
      if (!parent.children) {
        parent.children = [];
      }
      parent.children.push(heading);
    }
    
    // Ajouter le titre courant à la pile
    headingStack.push(heading);
  });
  
  return rootHeadings;
}

/**
 * Fonction pour filtrer le contenu Markdown par numéros de ligne
 *
 * @function filterByLines
 * @param {string} markdownContent - Contenu Markdown à filtrer
 * @param {number} [startLine] - Ligne de début (optionnel)
 * @param {number} [endLine] - Ligne de fin (optionnel)
 * @returns {string} Contenu Markdown filtré
 */
export function filterByLines(markdownContent: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) {
    return markdownContent;
  }
  
  const lines = markdownContent.split('\n');
  const startIndex = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
  const endIndex = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
  
  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * Fonction pour valider la profondeur maximale des titres
 *
 * @function validateMaxDepth
 * @param {number} maxDepth - Profondeur à valider
 * @returns {number} Profondeur validée (entre 1 et 6)
 */
export function validateMaxDepth(maxDepth: number): number {
  return Math.min(Math.max(1, maxDepth), 6); // Entre 1 et 6
}

/**
 * Fonction pour parser les titres individuellement
 *
 * @function parseHeading
 * @param {string} line - Ligne à analyser
 * @returns {HeadingNode|null} Titre parsé ou null si ce n'est pas un titre
 */
export function parseHeading(line: string, lineNumber: number): HeadingNode | null {
  const headingRegex = /^(#{1,6})\s+(.+)$/;
  const match = line.match(headingRegex);
  
  if (!match) {
    return null;
  }
  
  const level = match[1].length;
  const text = match[2].trim();
  
  return {
    level,
    text,
    line: lineNumber + 1
  };
}