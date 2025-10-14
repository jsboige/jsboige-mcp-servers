/**
 * TEST DE NON-RÉGRESSION - FIX CRITIQUE
 * 
 * Bug identifié : Le système utilisait seulement les 192 premiers caractères 
 * des instructions parent au lieu d'extraire les sous-instructions réelles.
 * 
 * Fix appliqué : Extraction via regex des sous-instructions depuis le texte parent complet
 * avec la méthode addParentTaskWithSubInstructions()
 * 
 * Résultat : Relations détectées passent de 0 à 2+ (objectif atteint)
 */

import { expect } from '@jest/globals';
import { TaskInstructionIndex } from '../../src/utils/task-instruction-index.js';
import { extractSubInstructions } from '../../src/utils/sub-instruction-extractor.js';

describe('🚨 RÉGRESSION CRITIQUE - Extraction hiérarchie parent-enfant', () => {
    let instructionIndex: TaskInstructionIndex;

    beforeEach(() => {
        instructionIndex = new TaskInstructionIndex();
    });

    test('BUG HISTORIQUE : ancien système ne trouvait aucune relation', async () => {
        const parentTaskId = 'parent-task-001';
        
        // ANCIEN SYSTÈME DÉFAILLANT - utilise seulement 192 premiers caractères
        const longInstructionText = `
Voici une tâche complexe qui nécessite plusieurs étapes.
Nous devons d'abord analyser le contexte général du projet.
Ensuite il faut procéder aux vérifications préliminaires.
Une fois ces éléments validés, nous pourrons passer aux étapes suivantes.

<new_task mode="code">
<message>Implémenter la fonctionnalité de validation des données</message>
</new_task>

Il est important de bien documenter chaque étape du processus.

<new_task mode="debug">
<message>Corriger les erreurs de compilation identifiées</message>
</new_task>

Ces instructions détaillées permettront une meilleure compréhension.`.trim();

        // ANCIEN SYSTÈME : ne prendre que 192 chars (BUG)
        const oldPrefix = longInstructionText.substring(0, 192);
        await instructionIndex.addInstruction(parentTaskId, oldPrefix, oldPrefix);
        
        // Test enfants
        const child1Found = instructionIndex.searchExactPrefix('Implémenter la fonctionnalité de validation des données');
        const child2Found = instructionIndex.searchExactPrefix('Corriger les erreurs de compilation identifiées');
        
        // ÉCHEC ATTENDU avec ancien système
        expect(child1Found).toHaveLength(0);
        expect(child2Found).toHaveLength(0);
        
        console.log('❌ ANCIEN SYSTÈME : 0/2 relations trouvées (BUG CONFIRMÉ)');
    });

    test('✅ NOUVEAU SYSTÈME : fix extraction sous-instructions', async () => {
        const parentTaskId = 'parent-task-002';
        
        const fullInstructionText = `
Voici une tâche complexe qui nécessite plusieurs étapes.
Nous devons d'abord analyser le contexte général du projet.
Ensuite il faut procéder aux vérifications préliminaires.
Une fois ces éléments validés, nous pourrons passer aux étapes suivantes.

<new_task mode="code">
<message>Implémenter la fonctionnalité de validation des données</message>
</new_task>

Il est important de bien documenter chaque étape du processus.

<new_task mode="debug">
<message>Corriger les erreurs de compilation identifiées</message>
</new_task>

Ces instructions détaillées permettront une meilleure compréhension.`.trim();

        // NOUVEAU SYSTÈME : extraction complète avec regex
        const extractedCount = await instructionIndex.addParentTaskWithSubInstructions(
            parentTaskId, 
            fullInstructionText
        );
        
        // Validation extraction
        expect(extractedCount).toBeGreaterThan(0);
        console.log(`🔍 Extracted ${extractedCount} sous-instructions`);
        
        // Test recherche enfants
        const child1 = instructionIndex.searchExactPrefix('Implémenter la fonctionnalité de validation des données');
        const child2 = instructionIndex.searchExactPrefix('Corriger les erreurs de compilation identifiées');
        
        // SUCCÈS ATTENDU avec nouveau système
        expect(child1).toHaveLength(1);
        expect(child1[0]?.taskId).toBe(parentTaskId);
        expect(child2).toHaveLength(1);
        expect(child2[0]?.taskId).toBe(parentTaskId);
        
        console.log('✅ NOUVEAU SYSTÈME : 2/2 relations trouvées (FIX VALIDÉ)');
    });

    test('🔍 Test extraction regex isolée', () => {
        const testText = `
Texte avant les instructions importantes.

<new_task mode="architect">
<message>Concevoir l'architecture système</message>
</new_task>

Autre contenu intermédiaire.

<new_task mode="code">
<message>Développer les composants principaux</message>
</new_task>

Fin du texte avec conclusions.`.trim();

        const extracted = extractSubInstructions(testText);
        
        expect(extracted).toHaveLength(2);
        expect(extracted[0]).toBe('Concevoir l\'architecture système');
        expect(extracted[1]).toBe('Développer les composants principaux');
        
        console.log('✅ Extraction regex : 2 instructions trouvées');
    });

    test('🚨 Test de non-régression complet', async () => {
        // Test combinant plusieurs patterns d'instructions
        const complexParentText = `
Projet de développement d'application web complète.

## Phase 1 : Architecture
<new_task mode="architect">
<message>Définir l'architecture microservices</message>
</new_task>

## Phase 2 : Développement  
<new_task mode="code">
<message>Implémenter les API REST</message>
</new_task>

## Phase 3 : Tests
<new_task mode="debug">  
<message>Valider les tests d'intégration</message>
</new_task>

Conclusion du projet avec documentation.`.trim();

        const parentId = 'complex-parent-123';
        const count = await instructionIndex.addParentTaskWithSubInstructions(parentId, complexParentText);
        
        // Doit extraire 3 sous-instructions
        expect(count).toBe(3);
        
        // Vérifier que toutes les relations sont trouvées
        const relation1 = instructionIndex.searchExactPrefix('Définir l\'architecture microservices');
        const relation2 = instructionIndex.searchExactPrefix('Implémenter les API REST');
        const relation3 = instructionIndex.searchExactPrefix('Valider les tests d\'intégration');
        
        expect(relation1).toHaveLength(1);
        expect(relation1[0]?.taskId).toBe(parentId);
        expect(relation2).toHaveLength(1);
        expect(relation2[0]?.taskId).toBe(parentId);
        expect(relation3).toHaveLength(1);
        expect(relation3[0]?.taskId).toBe(parentId);
        
        console.log('✅ TEST NON-RÉGRESSION : 3/3 relations complexes trouvées');
    });
});