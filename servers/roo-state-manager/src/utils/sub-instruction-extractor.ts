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
    
    // Pattern 1: Messages exacts avec guillemets
    // "TEST-LEAF-A1: Crée le fichier..." ou 'TEST-LEAF-A1: Crée le fichier...'
    const exactMessagePattern = /(?:message exact\s*:\s*)?["'](TEST-[^"']+)["']/gi;
    let match;
    while ((match = exactMessagePattern.exec(parentText)) !== null) {
        subInstructions.push(match[1]);
    }
    
    // Pattern 2: Instructions en bloc avec **Créer XXX**
    // **Créer TEST-LEAF-A1** en mode 'code' avec ce message exact :
    const blockPattern = /\*\*Créer\s+(TEST-[^*]+)\*\*/gi;
    while ((match = blockPattern.exec(parentText)) !== null) {
        // Chercher l'instruction complète qui suit
        const startPos = match.index;
        const remainingText = parentText.substring(startPos);
        
        // Chercher jusqu'à la fin de la section ou le prochain **
        const sectionMatch = remainingText.match(/["'](TEST-[^"']+)["']/);
        if (sectionMatch) {
            subInstructions.push(sectionMatch[1]);
        }
    }
    
    // Pattern 3: Listes numérotées avec instructions TEST-
    // 1. **Créer TEST-LEAF-A1** en mode...
    // 2. **Créer TEST-LEAF-A2** en mode...
    const listPattern = /^\s*\d+\.\s*.*?["'](TEST-[^"']+)["']/gm;
    while ((match = listPattern.exec(parentText)) !== null) {
        subInstructions.push(match[1]);
    }
    
    // Pattern 4: Direct TEST- instructions sans guillemets (backup)
    const directPattern = /(?:^|\n)\s*(TEST-[A-Z0-9-]+[^.\n]*)/gm;
    while ((match = directPattern.exec(parentText)) !== null) {
        const instruction = match[1].trim();
        // Éviter les doublons et s'assurer que c'est une instruction complète
        if (instruction.includes(':') && !subInstructions.some(existing => existing.startsWith(instruction.split(':')[0]))) {
            subInstructions.push(instruction);
        }
    }
    
    // Pattern 5: XML-like tags <message>TEST-XXX: ...</message>
    // <message>TEST-BRANCH-A: Crée le fichier...</message>
    const xmlMessagePattern = /<message>(TEST-[^<]+)<\/message>/gi;
    while ((match = xmlMessagePattern.exec(parentText)) !== null) {
        subInstructions.push(match[1]);
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
    const testParentText = `TEST-HIERARCHY-A: Tu es une branche de test A dans une hiérarchie de test en cascade. Ta mission PRINCIPALE et UNIQUE est de créer exactement 2 sous-tâches pour valider la reconstruction hiérarchique du MCP roo-state-manager.

### INSTRUCTIONS STRICTES :

1. **Créer TEST-LEAF-A1** en mode 'code' avec ce message exact :
   "TEST-LEAF-A1: Crée le fichier mcp-debugging/test-data/test-a1.py contenant une fonction validate_email() qui vérifie si un email est valide. La fonction doit retourner True/False et inclure des tests basiques. Termine avec attempt_completion en rapportant le chemin du fichier créé."

2. **Créer TEST-LEAF-A2** en mode 'ask' avec ce message exact :
   "TEST-LEAF-A2: Documente le processus de validation des emails en expliquant les étapes principales, les regex utilisés et les cas limites. Fournis une documentation technique complète. Termine avec attempt_completion en résumant ta documentation."`;

    console.log('🔬 TEST EXTRACTION DES SOUS-INSTRUCTIONS:\n');
    console.log('Texte parent (extrait):');
    console.log(testParentText.substring(0, 200) + '...\n');
    
    const extracted = extractSubInstructions(testParentText);
    console.log(`📋 Sous-instructions extraites (${extracted.length}):`);
    extracted.forEach((instr, i) => {
        console.log(`   ${i+1}. "${instr}"`);
    });
    
    // Validation
    const expectedCount = 2;
    const hasTestLeafA1 = extracted.some(instr => instr.startsWith('TEST-LEAF-A1:'));
    const hasTestLeafA2 = extracted.some(instr => instr.startsWith('TEST-LEAF-A2:'));
    
    console.log('\n✅ VALIDATION:');
    console.log(`   Nombre attendu: ${expectedCount}, trouvé: ${extracted.length}`);
    console.log(`   TEST-LEAF-A1 trouvé: ${hasTestLeafA1}`);
    console.log(`   TEST-LEAF-A2 trouvé: ${hasTestLeafA2}`);
    
    if (extracted.length >= expectedCount && hasTestLeafA1 && hasTestLeafA2) {
        console.log('🎉 EXTRACTION RÉUSSIE!');
    } else {
        console.log('❌ EXTRACTION ÉCHOUÉE!');
    }
}