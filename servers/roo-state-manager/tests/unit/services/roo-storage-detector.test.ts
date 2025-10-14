/**
 * Tests unitaires pour le détecteur de stockage Roo
 * Focus SDDD Phase 2: Validation de l'alignement des préfixes via computeInstructionPrefix(K=192)
 */

import { describe, test, expect } from 'vitest';
import { computeInstructionPrefix } from '../../../src/utils/task-instruction-index.js';

describe('Storage Detector — Exact Prefix normalization (K=192)', () => {
    
    test('computeInstructionPrefix normalise correctement les préfixes à K=192', () => {
        // Test case 1: Texte normal
        const rawMessage1 = "**MISSION CRITIQUE**: Analyser et Déboguer le Système Hiérarchique    avec   des espaces multiples";
        const expected1 = "**mission critique**: analyser et déboguer le système hiérarchique avec des espaces multiples";
        const result1 = computeInstructionPrefix(rawMessage1, 192);
        
        expect(result1).toBe(expected1);
        expect(result1.length).toBeLessThanOrEqual(192);
        expect(result1).not.toContain('...');
        
        // Test case 2: Texte très long (>192 caractères)
        const longMessage = "A".repeat(300) + " suite du message très long avec beaucoup de contenu supplémentaire";
        const result2 = computeInstructionPrefix(longMessage, 192);
        
        expect(result2.length).toBe(192);
        expect(result2).not.toContain('...');
        expect(result2).toBe("a".repeat(192)); // Tout en lowercase
        
        // Test case 3: Texte avec espaces multiples et casse mixte
        const mixedCase = "   HELLO    World   From    TESTING   ";
        const result3 = computeInstructionPrefix(mixedCase, 192);
        
        expect(result3).toBe("hello world from testing");
        expect(result3).not.toMatch(/\s{2,}/); // Pas d'espaces multiples
    });
    
    test('childTaskInstructionPrefixes produit des préfixes alignés', () => {
        // Test de cohérence: même message produit même préfixe
        const childMessage = "Implémenter une nouvelle fonctionnalité de débogage pour l'analyse des tâches";
        
        const prefix1 = computeInstructionPrefix(childMessage, 192);
        const prefix2 = computeInstructionPrefix(childMessage, 192);
        
        expect(prefix1).toBe(prefix2);
        expect(prefix1).toBe("implémenter une nouvelle fonctionnalité de débogage pour l'analyse des tâches");
        expect(prefix1.length).toBeLessThanOrEqual(192);
    });
    
    test('truncatedInstruction produit des préfixes alignés', () => {
        // Test d'alignement entre childTaskInstructionPrefixes et truncatedInstruction
        const firstSayMessage = "Créer un script de validation des préfixes d'instructions pour assurer la cohérence";
        
        const truncatedResult = computeInstructionPrefix(firstSayMessage, 192);
        
        expect(truncatedResult).toBe("créer un script de validation des préfixes d'instructions pour assurer la cohérence");
        expect(truncatedResult.length).toBeLessThanOrEqual(192);
        expect(truncatedResult).not.toContain('...');
        
        // Test d'équivalence avec childTaskInstructionPrefixes
        const childPrefix = computeInstructionPrefix(firstSayMessage, 192);
        expect(childPrefix).toBe(truncatedResult);
    });
    
    test('alignement strict entre préfixes enfants et instruction tronquée', () => {
        // Test le cas critique : même contenu logique doit produire même préfixe normalisé
        const rawContent = "  **Mission de DEBUG Critique**:   Analyser    les problèmes   ";
        
        const childPrefix = computeInstructionPrefix(rawContent, 192);
        const truncatedInstruction = computeInstructionPrefix(rawContent, 192);
        
        // Vérification d'alignement strict
        expect(childPrefix).toBe(truncatedInstruction);
        expect(childPrefix).toBe("**mission de debug critique**: analyser les problèmes");
        
        // Vérifications des propriétés SDDD Phase 2
        expect(childPrefix.length).toBeLessThanOrEqual(192);
        expect(childPrefix).not.toContain('...');
        expect(childPrefix).toBe(childPrefix.toLowerCase()); // Tout en lowercase
        expect(childPrefix).not.toMatch(/\s{2,}/); // Pas d'espaces multiples
    });
    
    test('edge cases de normalisation', () => {
        // Test case 1: Chaîne vide
        expect(computeInstructionPrefix('', 192)).toBe('');
        
        // Test case 2: Chaîne avec seulement des espaces
        expect(computeInstructionPrefix('   ', 192)).toBe('');
        
        // Test case 3: Chaîne exactement 192 caractères
        const exact192 = "A".repeat(192);
        const result = computeInstructionPrefix(exact192, 192);
        expect(result).toBe("a".repeat(192));
        expect(result.length).toBe(192);
        
        // Test case 4: Caractères spéciaux conservés
        const withSpecialChars = "Task [1.2.3]: Implement **feature** (urgent)";
        const resultSpecial = computeInstructionPrefix(withSpecialChars, 192);
        expect(resultSpecial).toBe("task [1.2.3]: implement **feature** (urgent)");
    });
    
    test('validation des filtres de longueur minimale', () => {
        // Test que les préfixes très courts sont filtrés (> 10 caractères requis)
        const shortMessage = "Test";
        const prefix = computeInstructionPrefix(shortMessage, 192);
        
        expect(prefix).toBe("test");
        expect(prefix.length).toBeLessThanOrEqual(10); // Devrait être filtré par la logique métier
        
        // Test avec un message de longueur limite (exactement 10 caractères)
        const limitMessage = "0123456789"; // 10 caractères
        const limitPrefix = computeInstructionPrefix(limitMessage, 192);
        expect(limitPrefix).toBe("0123456789");
        expect(limitPrefix.length).toBe(10);
        
        // Test avec un message valide (> 10 caractères)
        const validMessage = "Valid message for testing purposes";
        const validPrefix = computeInstructionPrefix(validMessage, 192);
        expect(validPrefix.length).toBeGreaterThan(10);
        expect(validPrefix).toBe("valid message for testing purposes");
    });
});