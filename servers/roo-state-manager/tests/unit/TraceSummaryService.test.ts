/**
 * TESTS UNITAIRES - TraceSummaryService
 * Tests de validation pour la correction du bug d'indentation des balises <details>
 */

import { sanitizeSectionHtml } from '../../src/services/TraceSummaryService';

describe('TraceSummaryService - sanitizeSectionHtml', () => {
  
  describe('CORRECTION PHASE 0 - Protection des balises <details>', () => {
    
    test('devrait supprimer l\'indentation des balises <details> au début de ligne', () => {
      const input = '    <details>\n        <summary>Test</summary>\n        Contenu\n    </details>';
      // Note: sanitizeSectionHtml nettoie aussi l'indentation des balises <summary>
      const expected = '<details>\n<summary>Test</summary>\n        Contenu\n</details>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait supprimer l\'indentation des balises </details> au début de ligne', () => {
      const input = '        Contenu\n    </details>\n<div>autre</div>';
      const expected = '        Contenu\n</details>\n<div>autre</div>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait supprimer l\'indentation des balises <summary> au début de ligne', () => {
      const input = '<details>\n    <summary>Test indenté</summary>\n    Contenu\n</details>';
      const expected = '<details>\n<summary>Test indenté</summary>\n    Contenu\n</details>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait supprimer l\'indentation des balises </summary> au début de ligne', () => {
      const input = '<details>\n<summary>Test</summary>\n    </summary>\n    Contenu\n</details>';
      const expected = '<details>\n<summary>Test</summary>\n</summary>\n    Contenu\n</details>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait gérer plusieurs balises <details> dans le même contenu', () => {
      const input = `<div>
    <details>
        <summary>Première section</summary>
        Contenu 1
    </details>
    
    <details>
        <summary>Deuxième section</summary>
        Contenu 2
    </details>
</div>`;
      
      const expected = `<div>
<details>
<summary>Première section</summary>
        Contenu 1
</details>
    
<details>
<summary>Deuxième section</summary>
        Contenu 2
</details>
</div>`;
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait préserver le contenu à l\'intérieur des balises <details>', () => {
      const input = '    <details>\n        <summary>Test</summary>\n        ```javascript\n        const x = 1;\n        ```\n    </details>';
      const expected = '<details>\n<summary>Test</summary>\n        ```javascript\n        const x = 1;\n        ```\n</details>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait fonctionner avec des niveaux d\'indentation variés', () => {
      const input = '        <details>\n            <summary>Test</summary>\n            Contenu\n        </details>';
      const expected = '<details>\n<summary>Test</summary>\n            Contenu\n</details>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait gérer les cas où les balises ne sont pas indentées (pas de changement)', () => {
      const input = '<details>\n<summary>Test</summary>\nContenu\n</details>';
      const expected = '<details>\n<summary>Test</summary>\nContenu\n</details>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('devrait préserver les autres fonctionnalités de sanitizeSectionHtml', () => {
      // Test de déduplication en début de chaîne (comportement actuel)
      const input = 'Ligne répétée\nLigne répétée\n    <details>\n        <summary>Test</summary>\n        Contenu\n    </details>';
      
      const result = sanitizeSectionHtml(input);
      
      // Vérifie que les balises <details> sont corrigées
      expect(result).toContain('<details>');
      expect(result).toContain('</details>');
      expect(result).not.toContain('    <details>');
      expect(result).not.toContain('    </details>');
      
      // Vérifie que la déduplication fonctionne (la première ligne dupliquée est supprimée)
      const lines = result.split('\n');
      // La première ligne doit être "Ligne répétée"
      expect(lines[0]).toBe('Ligne répétée');
      // La deuxième ligne ne doit PAS être "Ligne répétée" (car supprimée)
      // Note: sanitizeSectionHtml peut ajouter des sauts de ligne, donc on vérifie que la structure est correcte
      // Le résultat attendu est: Ligne répétée\n<details>...
      expect(lines[1]).not.toBe('Ligne répétée');
    });
  });
  
  describe('Tests de régression', () => {
    
    test('ne devrait pas affecter les autres balises HTML', () => {
      const input = '    <div>\n        <p>Contenu</p>\n        <span>Texte</span>\n    </div>';
      const expected = '    <div>\n        <p>Contenu</p>\n        <span>Texte</span>\n    </div>';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
    
    test('ne devrait pas affecter le code markdown normal', () => {
      const input = '    ```javascript\n    const x = 1;\n    ```';
      const expected = '    ```javascript\n    const x = 1;\n    ```';
      
      const result = sanitizeSectionHtml(input);
      expect(result).toBe(expected);
    });
  });
});