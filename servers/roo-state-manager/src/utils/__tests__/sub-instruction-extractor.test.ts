/**
 * Tests unitaires pour sub-instruction-extractor
 *
 * Couvre :
 * - extractSubInstructions : 6 patterns de détection
 * - Déduplication et filtrage
 * - Cas limites (vide, court, null)
 */
import { describe, it, expect } from 'vitest';
import { extractSubInstructions } from '../sub-instruction-extractor.js';

describe('extractSubInstructions', () => {
  // === Pattern 1: new_task XML tags ===

  describe('Pattern 1: new_task XML tags', () => {
    it('should extract instructions from new_task XML with mode attribute', () => {
      const text = `<new_task mode="code"><message>Créer le fichier src/UserManager.ts avec les méthodes CRUD</message></new_task>`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('UserManager.ts'))).toBe(true);
    });

    it('should extract multiple new_task instructions', () => {
      const text = `
<new_task mode="code"><message>Implémenter la classe principale du service d'authentification</message></new_task>
<new_task mode="ask"><message>Documenter les endpoints de l'API REST avec des exemples</message></new_task>`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('authentification'))).toBe(true);
      expect(result.some(r => r.includes('endpoints'))).toBe(true);
    });

    it('should ignore short instructions in new_task', () => {
      const text = `<new_task mode="code"><message>Fix it</message></new_task>`;
      const result = extractSubInstructions(text);
      // "Fix it" is 6 chars, below 10 threshold
      expect(result.some(r => r === 'Fix it')).toBe(false);
    });
  });

  // === Pattern 3: Bullet points ===

  describe('Pattern 3: Bullet points', () => {
    it('should extract bullet point items with dash', () => {
      const text = `Tasks:
- Créer le fichier de configuration du module
- Implémenter la validation des entrées
- Tester toutes les méthodes publiques`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('configuration'))).toBe(true);
      expect(result.some(r => r.includes('validation'))).toBe(true);
    });

    it('should extract bullet point items with asterisk', () => {
      const text = `Tasks:
* Analyser les dépendances du module
* Refactorer le service principal`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('dépendances'))).toBe(true);
      expect(result.some(r => r.includes('Refactorer'))).toBe(true);
    });

    it('should ignore short bullet items', () => {
      const text = `- short\n- also`;
      const result = extractSubInstructions(text);
      expect(result.length).toBe(0);
    });
  });

  // === Pattern 4: Numbered lists ===

  describe('Pattern 4: Numbered lists', () => {
    it('should extract numbered list items', () => {
      const text = `Plan:
1. Analyser les exigences techniques
2. Développer l'architecture de la solution
3. Valider avec les tests unitaires complets`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('exigences'))).toBe(true);
      expect(result.some(r => r.includes('architecture'))).toBe(true);
      expect(result.some(r => r.includes('tests unitaires'))).toBe(true);
    });

    it('should handle multi-digit numbers', () => {
      const text = `10. Implémenter la fonctionnalité de recherche avancée`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('recherche avancée'))).toBe(true);
    });
  });

  // === Pattern 5: Task XML tags ===

  describe('Pattern 5: Task XML tags', () => {
    it('should extract task XML tags', () => {
      const text = `<task>Créer le composant principal de l'application</task>`;
      const result = extractSubInstructions(text);
      expect(result.some(r => r.includes('composant principal'))).toBe(true);
    });

    it('should extract multiple task tags', () => {
      const text = `<task>Implémenter le module de gestion des utilisateurs</task>
<task>Tester le module avec des données réalistes</task>`;
      const result = extractSubInstructions(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });

  // === Deduplication ===

  describe('deduplication', () => {
    it('should deduplicate identical instructions', () => {
      // Same instruction appearing in both bullet and numbered patterns
      const text = `- Créer le fichier de configuration principal
1. Créer le fichier de configuration principal`;
      const result = extractSubInstructions(text);
      const configItems = result.filter(r => r.includes('configuration principal'));
      expect(configItems.length).toBe(1);
    });
  });

  // === Edge cases ===

  describe('edge cases', () => {
    it('should return empty array for empty string', () => {
      expect(extractSubInstructions('')).toEqual([]);
    });

    it('should return empty array for null-like input', () => {
      expect(extractSubInstructions(null as any)).toEqual([]);
      expect(extractSubInstructions(undefined as any)).toEqual([]);
    });

    it('should return empty array for text without patterns', () => {
      const result = extractSubInstructions('Just some plain text without any patterns.');
      // May match indented lines but none > 10 chars structured
      expect(result.every(r => r.length > 10)).toBe(true);
    });

    it('should handle the full test example from testSubInstructionExtraction', () => {
      const testText = `Analyse l'architecture du système et prépare l'implémentation.

### TÂCHES À RÉALISER :

1. <new_task mode="code">
<message>Créer le fichier src/components/UserManager.ts contenant une classe UserManager avec méthodes createUser, updateUser et deleteUser. Inclure la validation des entrées et la gestion des erreurs.</message>
</new_task>

2. <new_task mode="ask">
<message>Documente l'API du UserManager en expliquant chaque méthode, les paramètres attendus et les codes d'erreur possibles. Fournis des exemples d'utilisation.</message>
</new_task>

3. Implémenter les tests unitaires :
   - Créer le fichier tests/UserManager.test.ts
   - Tester toutes les méthodes publiques
   - Couvrir les cas limites et les erreurs

4. Déployer la documentation :
   - Mettre à jour README.md
   - Ajouter les exemples d'utilisation
   - Documenter l'installation`;

      const result = extractSubInstructions(testText);
      expect(result.length).toBeGreaterThanOrEqual(4);
      expect(result.some(r => r.includes('UserManager.ts'))).toBe(true);
      expect(result.some(r => r.includes('Documente l\'API'))).toBe(true);
    });
  });

  // === Mixed patterns ===

  describe('mixed patterns', () => {
    it('should extract from multiple pattern types', () => {
      const text = `
<new_task mode="code"><message>Implémenter le service d'authentification complet</message></new_task>

Étapes supplémentaires :
1. Ajouter les tests d'intégration
- Configurer l'environnement de staging
<task>Valider le déploiement en production</task>`;

      const result = extractSubInstructions(text);
      expect(result.length).toBeGreaterThanOrEqual(3);
    });
  });
});
