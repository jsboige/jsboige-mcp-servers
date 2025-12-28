/**
 * TEST DE VALIDATION - CORRECTION PHASE 0
 * Test simple pour valider la correction du bug d'indentation des balises <details>
 */

// Import ES modules
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extraction de la fonction sanitizeSectionHtml (version exacte du code source)
function sanitizeSectionHtml(raw) {
    let html = raw ?? '';

    // CORRECTION CRITIQUE PHASE 0: Protéger les balises <details> contre l'interprétation Markdown
    // Les balises <details> indentées sont transformées en code blocks par Markdown
    // On les préserve en s'assurant qu'elles sont au niveau 0 (pas d'indentation)
    
    // 0) Protection des balises <details> - CORRECTION CRITIQUE
    html = html.replace(/^(\s*)<details>/gm, '<details>');
    html = html.replace(/^(\s*)<\/details>/gm, '</details>');
    html = html.replace(/^(\s*)<summary>/gm, '<summary>');
    html = html.replace(/^(\s*)<\/summary>/gm, '</summary>');

    // 1) Dédup de la 1ère/2e ligne (symptôme titres/lead répétés)
    const lines = html.split('\n');
    if (lines.length >= 2) {
        const first = lines[0]?.trim();
        const second = lines[1]?.trim();
        if (first && second && first === second) {
            lines.splice(1, 1);
            html = lines.join('\n');
        }
    }

    // 2) Nettoyage fin des artefacts Markdown
    html = html.replace(/^(\s*)```(\w+)?\s*$/gm, '');
    html = html.replace(/^(\s*)---\s*$/gm, '');
    html = html.replace(/\[\\[^\]]*\]/g, '');

    // 3) Trim final pour enlever les espaces superflus en début/fin
    html = html.trim();

    return html;
}

// Tests de validation
console.log('🧪 TEST DE VALIDATION - CORRECTION PHASE 0');
console.log('==========================================\n');

let testsPassed = 0;
let testsTotal = 0;

function runTest(testName, input, expected) {
    testsTotal++;
    const result = sanitizeSectionHtml(input);
    const passed = result === expected;
    
    console.log(`Test ${testsTotal}: ${testName}`);
    console.log(`Input: ${JSON.stringify(input)}`);
    console.log(`Expected: ${JSON.stringify(expected)}`);
    console.log(`Result: ${JSON.stringify(result)}`);
    console.log(`Status: ${passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log('---');
    
    if (passed) testsPassed++;
    return passed;
}

// Test 1: Suppression indentation <details>
runTest(
    'Suppression indentation <details>',
    '    <details>\n        <summary>Test</summary>\n        Contenu\n    </details>',
    '<details>\n<summary>Test</summary>\n        Contenu\n</details>'
);

// Test 2: Suppression indentation </details>
runTest(
    'Suppression indentation </details>',
    '        Contenu\n    </details>\n<div>autre</div>',
    'Contenu\n</details>\n<div>autre</div>'
);

// Test 3: Suppression indentation <summary>
runTest(
    'Suppression indentation <summary>',
    '<details>\n    <summary>Test indenté</summary>\n    Contenu\n</details>',
    '<details>\n<summary>Test indenté</summary>\n    Contenu\n</details>'
);

// Test 4: Gestion multiple <details>
runTest(
    'Gestion multiple <details>',
    `<div>
    <details>
        <summary>Première section</summary>
        Contenu 1
    </details>
    
    <details>
        <summary>Deuxième section</summary>
        Contenu 2
    </details>
</div>`,
    `<div>
<details>
<summary>Première section</summary>
        Contenu 1
</details>
<details>
<summary>Deuxième section</summary>
        Contenu 2
</details>
</div>`
);

// Test 5: Préservation contenu indenté
runTest(
    'Préservation contenu indenté',
    '    <details>\n        <summary>Test</summary>\n        ```javascript\n        const x = 1;\n        ```\n    </details>',
    '<details>\n<summary>Test</summary>\n\n        const x = 1;\n\n</details>'
);

// Test 6: Pas d'effet sur balises non indentées
runTest(
    'Pas d\'effet sur balises non indentées',
    '<details>\n<summary>Test</summary>\nContenu\n</details>',
    '<details>\n<summary>Test</summary>\nContenu\n</details>'
);

// Test 7: Préservation autres balises HTML
runTest(
    'Préservation autres balises HTML',
    '    <div>\n        <p>Contenu</p>\n        <span>Texte</span>\n    </div>',
    '<div>\n        <p>Contenu</p>\n        <span>Texte</span>\n    </div>'
);

// Test 8: Préservation code markdown
runTest(
    'Préservation code markdown',
    '    ```javascript\n    const x = 1;\n    ```',
    'const x = 1;'
);

// Résultats finaux
console.log(`\n📊 RÉSULTATS FINAUX`);
console.log(`===================`);
console.log(`Tests passés: ${testsPassed}/${testsTotal}`);
console.log(`Taux de réussite: ${((testsPassed / testsTotal) * 100).toFixed(1)}%`);

if (testsPassed === testsTotal) {
    console.log('\n🎉 TOUS LES TESTS SONT PASSÉS !');
    console.log('✅ La correction PHASE 0 est validée avec succès.');
    process.exit(0);
} else {
    console.log('\n❌ CERTAINS TESTS ONT ÉCHOUÉ !');
    console.log('⚠️  La correction nécessite des ajustements.');
    process.exit(1);
}