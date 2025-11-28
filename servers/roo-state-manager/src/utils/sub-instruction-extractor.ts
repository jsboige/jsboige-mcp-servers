/**
 * Extracteur de sous-instructions depuis le texte des tâches parent
 * Corrige la régression critique de la reconstruction hiérarchique
 */

/**
 * Extrait les sous-instructions depuis le texte d'une tâche parent
 * Recherche les patterns typiques de création de sous-tâches
 */
export function extractSubInstructions(parentText: string): string[] {
    const subInstructions: string[] = [];
    
    if (!parentText) return subInstructions;
    
    // Pattern 1: new_task XML tags - VRAIS PATTERNS ROO
    // <new_task mode="code"><message>Créer le composant...</message></new_task>
    const newTaskPattern = /<new_task[^>]*>\s*<message>(.*?)<\/message>/gs;
    let match;
    while ((match = newTaskPattern.exec(parentText)) !== null) {
        const instruction = match[1].trim();
        if (instruction.length > 10) {
            subInstructions.push(instruction);
        }
    }
    
    // Pattern 2: Code blocks avec instructions
    // ```typescript\n// Créer composant\nexport class Test {}\n```
    const codeBlockPattern = /```(\w+)\s*(.*?)```/gs;
    while ((match = codeBlockPattern.exec(parentText)) !== null) {
        const codeContent = match[2].trim();
        if (codeContent.length > 20) {
            subInstructions.push(codeContent);
        }
    }
    
    // Pattern 3: Bullet points markdown
    // - Créer le fichier de configuration
    // - Implémenter la validation
    const bulletPattern = /^[-*+]\s+(.+)$/gm;
    while ((match = bulletPattern.exec(parentText)) !== null) {
        const instruction = match[1].trim();
        if (instruction.length > 10) {
            subInstructions.push(instruction);
        }
    }
    
    // Pattern 4: Numbered lists
    // 1. Analyser les exigences
    // 2. Développer l'architecture
    const numberedListPattern = /^\d+\.\s+(.+)$/gm;
    while ((match = numberedListPattern.exec(parentText)) !== null) {
        const instruction = match[1].trim();
        if (instruction.length > 10) {
            subInstructions.push(instruction);
        }
    }
    
    // Pattern 5: Task XML tags (alternative)
    // <task>Créer le composant principal</task>
    const taskPattern = /<task>(.*?)<\/task>/gs;
    while ((match = taskPattern.exec(parentText)) !== null) {
        const instruction = match[1].trim();
        if (instruction.length > 10) {
            subInstructions.push(instruction);
        }
    }
    
    // Pattern 6: Instructions imbriquées avec indentation
    //   Analyser les dépendances
    //   Créer les tests unitaires
    const nestedPattern = /(?:^|\n)(?:\s{2,}|  )(.+)$/gm;
    while ((match = nestedPattern.exec(parentText)) !== null) {
        const instruction = match[1].trim();
        if (instruction.length > 10 && !instruction.startsWith('//')) {
            subInstructions.push(instruction);
        }
    }
    
    // Déduplication et nettoyage
    const uniqueInstructions = Array.from(new Set(subInstructions))
        .map(instr => instr.trim())
        .filter(instr => instr.length > 10); // Filtrer les instructions trop courtes
    
    return uniqueInstructions;
}

/**
 * Teste l'extraction sur les données réelles des fixtures fonctionnelles
 */
export function testSubInstructionExtraction(): void {
    const testParentText = `Analyse l'architecture du système et prépare l'implémentation.

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

    console.log('🔬 TEST EXTRACTION DES SOUS-INSTRUCTIONS:\n');
    console.log('Texte parent (extrait):');
    console.log(testParentText.substring(0, 200) + '...\n');
    
    const extracted = extractSubInstructions(testParentText);
    console.log(`📋 Sous-instructions extraites (${extracted.length}):`);
    extracted.forEach((instr, i) => {
        console.log(`   ${i+1}. "${instr}"`);
    });
    
    // Validation
    const expectedCount = 4;
    const hasNewTask1 = extracted.some(instr => instr.includes('UserManager.ts'));
    const hasNewTask2 = extracted.some(instr => instr.includes('Documente l\'API'));
    const hasTestTask = extracted.some(instr => instr.includes('tests unitaires'));
    const hasDeployTask = extracted.some(instr => instr.includes('Déployer la documentation'));
    
    console.log('\n✅ VALIDATION:');
    console.log(`   Nombre attendu: ${expectedCount}, trouvé: ${extracted.length}`);
    console.log(`   UserManager.ts trouvé: ${hasNewTask1}`);
    console.log(`   Documentation API trouvé: ${hasNewTask2}`);
    console.log(`   Tests unitaires trouvé: ${hasTestTask}`);
    console.log(`   Déploiement documentation trouvé: ${hasDeployTask}`);
    
    if (extracted.length >= expectedCount && hasNewTask1 && hasNewTask2 && hasTestTask && hasDeployTask) {
        console.log('🎉 EXTRACTION RÉUSSIE!');
    } else {
        console.log('❌ EXTRACTION ÉCHOUÉE!');
    }
}