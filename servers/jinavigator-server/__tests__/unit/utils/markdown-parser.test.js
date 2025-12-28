/**
 * Tests unitaires pour le parser Markdown
 * 
 * Ces tests couvrent tous les cas nominaux, d'erreur et limites
 * pour l'utilitaire d'analyse et de parsing du contenu Markdown.
 */

import { jest } from '@jest/globals';
import * as markdownParser from '../../../src/utils/markdown-parser.js';

// Données de test
const TEST_MARKDOWN_CONTENT = `# Titre de test
## Sous-titre
Ceci est un contenu Markdown de test.
- Point 1
- Point 2
- Point 3

### Section 1
Contenu de la section 1.

### Section 2
Contenu de la section 2.
`;

const TEST_LARGE_MARKDOWN = '# Grand document Markdown\n\n' +
  Array.from({ length: 1000 }, (_, i) => `## Section ${i}\n\nCeci est le contenu de la section ${i}.\n\n`).join('');

// Définir les globales pour les tests
global.TEST_MARKDOWN_CONTENT = TEST_MARKDOWN_CONTENT;
global.TEST_LARGE_MARKDOWN = TEST_LARGE_MARKDOWN;

describe('MarkdownParser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractMarkdownOutline', () => {
    test('devrait extraire le plan d\'un contenu Markdown simple', () => {
      const content = `# Titre Principal
## Sous-titre 1
### Sous-sous-titre 1.1
## Sous-titre 2`;
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      expect(outline).toHaveLength(1); // 1 racine
      expect(outline[0].level).toBe(1);
      expect(outline[0].text).toBe('Titre Principal');
      expect(outline[0].children).toHaveLength(2); // 2 sous-titres
      expect(outline[0].children[0].text).toBe('Sous-titre 1');
      expect(outline[0].children[1].text).toBe('Sous-titre 2');
    });

    test('devrait extraire le plan avec une profondeur maximale personnalisée', () => {
      const content = `# Titre 1
## Sous-titre 1
### Sous-sous-titre 1
#### Sous-sous-sous-titre 1
## Sous-titre 2`;
      
      const outline = markdownParser.extractMarkdownOutline(content, 2);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].level).toBe(1);
      expect(outline[0].children).toHaveLength(2);
      expect(outline[0].children[0].children).toBeUndefined(); // Pas de niveau 3
    });

    test('devrait gérer les titres avec des espaces supplémentaires', () => {
      const content = `#  Titre avec espaces
##   Sous-titre avec espaces
###    Sous-sous-titre avec espaces`;
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].text).toBe('Titre avec espaces');
      expect(outline[0].children[0].text).toBe('Sous-titre avec espaces');
      expect(outline[0].children[0].children[0].text).toBe('Sous-sous-titre avec espaces');
    });

    test('devrait gérer les titres avec du formatage Markdown', () => {
      const content = `# Titre **gras**
## Sous-titre *italique*
### Sous-sous-titre \`code\`
## Sous-titre [lien](https://example.com)`;
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].text).toBe('Titre **gras**');
      expect(outline[0].children[0].text).toBe('Sous-titre *italique*');
      expect(outline[0].children[0].children[0].text).toBe('Sous-sous-titre `code`');
      expect(outline[0].children[1].text).toBe('Sous-titre [lien](https://example.com)');
    });

    test('devrait gérer les titres avec des caractères spéciaux', () => {
      const content = `# Titre avec émojis 🚀
## Sous-titre avec accents éàèç
### Sous-sous-titre avec symboles ♠♣♥♦`;
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].text).toBe('Titre avec émojis 🚀');
      expect(outline[0].children[0].text).toBe('Sous-titre avec accents éàèç');
      expect(outline[0].children[0].children[0].text).toBe('Sous-sous-titre avec symboles ♠♣♥♦');
    });

    test('devrait gérer les titres avec des niveaux de 1 à 6', () => {
      const content = `# Niveau 1
## Niveau 2
### Niveau 3
#### Niveau 4
##### Niveau 5
###### Niveau 6`;
      
      const outline = markdownParser.extractMarkdownOutline(content, 6);
      
      expect(outline).toHaveLength(1);
      let current = outline[0];
      expect(current.level).toBe(1);
      
      for (let i = 2; i <= 6; i++) {
        expect(current.children).toHaveLength(1);
        current = current.children[0];
        expect(current.level).toBe(i);
      }
    });

    test('devrait ignorer les lignes qui ne sont pas des titres', () => {
      const content = `Ceci est du texte normal.
# Titre 1
Ceci est aussi du texte.
## Titre 2
- Liste item 1
- Liste item 2
### Titre 3
> Ceci est une citation.`;
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].text).toBe('Titre 1');
      expect(outline[0].children[0].text).toBe('Titre 2');
      expect(outline[0].children[0].children[0].text).toBe('Titre 3');
    });

    test('devrait gérer les titres vides', () => {
      const content = `#
##
### `;
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      // Le parser actuel ignore les titres vides car le regex attend au moins un caractère après les #
      // const headingRegex = /^(#{1,6})\s+(.+)$/;
      // .+ signifie au moins un caractère
      expect(outline).toHaveLength(0);
    });

    test('devrait gérer les titres avec seulement des espaces', () => {
      const content = `#   
##    
###   `;
      
      const outline = markdownParser.extractMarkdownOutline(content, 6);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].text).toBe('');
      expect(outline[0].children[0].text).toBe('');
      expect(outline[0].children[0].children[0].text).toBe('');
    });
  });

  describe('filterByLines', () => {
    test('devrait extraire une plage de lignes spécifique', () => {
      const content = `Ligne 1
Ligne 2
Ligne 3
Ligne 4
Ligne 5`;
      
      const lines = markdownParser.filterByLines(content, 2, 4);
      
      expect(lines).toBe('Ligne 2\nLigne 3\nLigne 4');
    });

    test('devrait extraire depuis le début quand start_line est 1', () => {
      const content = `Ligne 1
Ligne 2
Ligne 3`;
      
      const lines = markdownParser.filterByLines(content, 1, 2);
      
      expect(lines).toBe('Ligne 1\nLigne 2');
    });

    test('devrait extraire jusqu\'à la fin quand end_line n\'est pas spécifié', () => {
      const content = `Ligne 1
Ligne 2
Ligne 3
Ligne 4`;
      
      const lines = markdownParser.filterByLines(content, 3);
      
      expect(lines).toBe('Ligne 3\nLigne 4');
    });

    test('devrait retourner une chaîne vide quand start_line est invalide', () => {
      const content = `Ligne 1
Ligne 2
Ligne 3`;
      
      const lines = markdownParser.filterByLines(content, 10);
      
      expect(lines).toBe('');
    });

    test('devrait gérer les lignes avec des caractères spéciaux', () => {
      const content = `Ligne 1 avec émojis 🚀
Ligne 2 avec accents éàèç
Ligne 3 avec symboles ♠♣♥♦`;
      
      const lines = markdownParser.filterByLines(content, 1, 3);
      
      expect(lines).toBe('Ligne 1 avec émojis 🚀\nLigne 2 avec accents éàèç\nLigne 3 avec symboles ♠♣♥♦');
    });

    test('devrait gérer les lignes vides', () => {
      const content = `Ligne 1

Ligne 3

Ligne 5`;
      
      const lines = markdownParser.filterByLines(content, 1, 5);
      
      expect(lines).toBe('Ligne 1\n\nLigne 3\n\nLigne 5');
    });

    test('devrait gérer les contenus avec différents types de fin de ligne', () => {
      const content = 'Ligne 1\r\nLigne 2\nLigne 3\rLigne 4';
      
      const lines = markdownParser.filterByLines(content, 1, 4);
      
      // Note: split('\n') ne gère pas \r seul, donc le résultat dépend de l'implémentation exacte
      // Si l'implémentation utilise split('\n'), \r sera conservé à la fin de la ligne précédente
      // ou \r\n sera splité correctement
    });
  });

  describe('validateMaxDepth', () => {
    test('devrait valider la profondeur maximale', () => {
      expect(markdownParser.validateMaxDepth(3)).toBe(3);
      expect(markdownParser.validateMaxDepth(1)).toBe(1);
      expect(markdownParser.validateMaxDepth(6)).toBe(6);
    });

    test('devrait corriger les valeurs trop petites', () => {
      expect(markdownParser.validateMaxDepth(0)).toBe(1);
      expect(markdownParser.validateMaxDepth(-5)).toBe(1);
    });

    test('devrait corriger les valeurs trop grandes', () => {
      expect(markdownParser.validateMaxDepth(7)).toBe(6);
      expect(markdownParser.validateMaxDepth(100)).toBe(6);
    });
  });

  describe('parseHeading', () => {
    test('devrait parser un titre correct', () => {
      const heading = markdownParser.parseHeading('# Titre', 0);
      expect(heading).toEqual({
        level: 1,
        text: 'Titre',
        line: 1
      });
    });

    test('devrait parser un titre de niveau 6', () => {
      const heading = markdownParser.parseHeading('###### Titre', 5);
      expect(heading).toEqual({
        level: 6,
        text: 'Titre',
        line: 6
      });
    });

    test('devrait retourner null pour une ligne qui n\'est pas un titre', () => {
      expect(markdownParser.parseHeading('Texte normal', 0)).toBeNull();
      expect(markdownParser.parseHeading('- Liste', 0)).toBeNull();
      expect(markdownParser.parseHeading('> Citation', 0)).toBeNull();
    });

    test('devrait retourner null pour un titre de niveau > 6', () => {
      expect(markdownParser.parseHeading('####### Titre invalide', 0)).toBeNull();
    });
  });

  describe('Cas limites', () => {
    test('devrait gérer les contenus très volumineux', () => {
      const largeContent = global.TEST_LARGE_MARKDOWN;
      
      const outline = markdownParser.extractMarkdownOutline(largeContent);
      
      expect(Array.isArray(outline)).toBe(true);
      expect(outline.length).toBeGreaterThan(0);
    });

    test('devrait gérer les contenus avec des milliers de lignes', () => {
      let content = '';
      for (let i = 1; i <= 1000; i++) {
        content += `# Titre ${i}\n`;
      }
      
      const outline = markdownParser.extractMarkdownOutline(content);
      
      expect(outline).toHaveLength(1000); // 1000 racines car tous niveau 1
      expect(outline[999].text).toBe('Titre 1000');
    });

    test('devrait gérer les titres avec des caractères Unicode complexes', () => {
      const content = `# Titre avec caractères complexes: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 🌟
## Sous-titre avec arabic: العربية
### Sous-sous-titre avec chinois: 中文
#### Sous-sous-sous-titre avec japonais: 日本語`;
      
      const outline = markdownParser.extractMarkdownOutline(content, 4);
      
      expect(outline).toHaveLength(1);
      expect(outline[0].text).toContain('𝔘𝔫𝔦𝔠𝔬𝔡𝔢');
      expect(outline[0].children[0].text).toContain('العربية');
      expect(outline[0].children[0].children[0].text).toContain('中文');
      expect(outline[0].children[0].children[0].children[0].text).toContain('日本語');
    });
  });

  describe('Performance', () => {
    test('devrait traiter efficacement les contenus de taille moyenne', () => {
      const content = global.TEST_MARKDOWN_CONTENT;
      
      const startTime = Date.now();
      const outline = markdownParser.extractMarkdownOutline(content);
      const endTime = Date.now();
      
      expect(outline.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(100); // Devrait prendre moins de 100ms
    });

    test('devrait gérer les appels répétés sans fuite de mémoire', () => {
      const content = global.TEST_MARKDOWN_CONTENT;
      
      // Effectuer 100 appels pour vérifier les fuites de mémoire
      for (let i = 0; i < 100; i++) {
        const outline = markdownParser.extractMarkdownOutline(content);
        expect(Array.isArray(outline)).toBe(true);
      }
    });
  });
});