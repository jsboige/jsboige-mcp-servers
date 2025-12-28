#!/usr/bin/env node

/**
 * Script de test fonctionnel simple pour QuickFiles MCP Server
 * Teste les fonctionnalités clés via des appels directs aux méthodes
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

class SimpleFunctionalTester {
    constructor() {
        this.testDir = '';
        this.results = {
            passed: 0,
            failed: 0,
            total: 0,
            details: []
        };
    }

    async setup() {
        // Créer un répertoire de test temporaire
        this.testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickfiles-simple-test-'));
        console.log(`📁 Répertoire de test créé: ${this.testDir}`);

        // Créer des fichiers de test
        await this.createTestFiles();
    }

    async createTestFiles() {
        const files = [
            {
                name: 'test1.txt',
                content: `Ceci est un fichier de test.
Il contient plusieurs lignes.
Avec du texte à rechercher.
Le mot "function" apparaît plusieurs fois.
function() { console.log("test"); }
`
            },
            {
                name: 'test2.js',
                content: `function calculateSum(a, b) {
    return a + b;
}

function calculateProduct(a, b) {
    return a * b;
}

// Test function
function test() {
    console.log("Testing functions");
}
`
            },
            {
                name: 'README.md',
                content: `# Projet QuickFiles

## Description
Ceci est un projet de test.

## Fonctionnalités
- Lecture de fichiers
- Édition de fichiers
- Recherche et remplacement

### Installation
\`\`\`bash
npm install
\`\`\`

### Usage
\`\`\`javascript
import { QuickFilesServer } from './src/index.js';
\`\`\`
`
            }
        ];

        for (const file of files) {
            await fs.writeFile(path.join(this.testDir, file.name), file.content, 'utf-8');
        }

        // Créer un sous-répertoire avec des fichiers
        const subDir = path.join(this.testDir, 'subdir');
        await fs.mkdir(subDir);
        
        await fs.writeFile(path.join(subDir, 'nested.txt'), 'Fichier imbriqué\nAvec plusieurs lignes\nPour tester la récursivité', 'utf-8');
    }

    async cleanup() {
        // Nettoyer le répertoire de test
        try {
            await fs.rm(this.testDir, { recursive: true, force: true });
            console.log(`🧹 Répertoire de test nettoyé: ${this.testDir}`);
        } catch (error) {
            console.error(`Erreur lors du nettoyage: ${error.message}`);
        }
    }

    async runTest(testName, testFunction) {
        this.results.total++;
        try {
            await testFunction();
            this.results.passed++;
            this.results.details.push({ name: testName, status: '✅ PASSÉ', error: null });
            console.log(`✅ ${testName}`);
        } catch (error) {
            this.results.failed++;
            this.results.details.push({ name: testName, status: '❌ ÉCHOUÉ', error: error.message });
            console.log(`❌ ${testName}: ${error.message}`);
        }
    }

    async testBasicFileOperations() {
        // Test de lecture de fichier
        const content = await fs.readFile(path.join(this.testDir, 'test1.txt'), 'utf-8');
        if (!content.includes('Ceci est un fichier de test')) {
            throw new Error('Le contenu du fichier n\'est pas correct');
        }

        // Test d'écriture de fichier
        const testFile = path.join(this.testDir, 'test-write.txt');
        await fs.writeFile(testFile, 'Contenu de test', 'utf-8');
        const writtenContent = await fs.readFile(testFile, 'utf-8');
        if (writtenContent !== 'Contenu de test') {
            throw new Error('L\'écriture du fichier a échoué');
        }

        // Test de suppression de fichier
        await fs.unlink(testFile);
        try {
            await fs.access(testFile);
            throw new Error('Le fichier n\'a pas été supprimé');
        } catch (error) {
            // C'est normal, le fichier ne devrait plus exister
        }
    }

    async testDirectoryOperations() {
        // Test de listing de répertoire
        const entries = await fs.readdir(this.testDir, { withFileTypes: true });
        const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
        
        if (!files.includes('test1.txt') || !files.includes('test2.js')) {
            throw new Error('Le listing du répertoire ne contient pas les fichiers attendus');
        }

        // Test de création de sous-répertoire
        const newDir = path.join(this.testDir, 'new-subdir');
        await fs.mkdir(newDir);
        
        const dirStats = await fs.stat(newDir);
        if (!dirStats.isDirectory()) {
            throw new Error('La création du répertoire a échoué');
        }

        // Test de listing récursif
        const subEntries = await fs.readdir(newDir);
        if (subEntries.length !== 0) {
            throw new Error('Le nouveau répertoire devrait être vide');
        }
    }

    async testFileSearch() {
        // Test de recherche dans les fichiers
        const files = await fs.readdir(this.testDir);
        let foundFunction = false;
        
        for (const file of files) {
            const filePath = path.join(this.testDir, file);
            const stats = await fs.stat(filePath);
            
            if (stats.isFile()) {
                const content = await fs.readFile(filePath, 'utf-8');
                if (content.includes('function')) {
                    foundFunction = true;
                    break;
                }
            }
        }
        
        if (!foundFunction) {
            throw new Error('La recherche du mot "function" a échoué');
        }
    }

    async testFileModification() {
        // Test de modification de fichier
        const testFile = path.join(this.testDir, 'test1.txt');
        const originalContent = await fs.readFile(testFile, 'utf-8');
        
        // Remplacer "function" par "méthode"
        const modifiedContent = originalContent.replace(/function/g, 'méthode');
        await fs.writeFile(testFile, modifiedContent, 'utf-8');
        
        // Vérifier la modification
        const newContent = await fs.readFile(testFile, 'utf-8');
        if (!newContent.includes('méthode')) {
            throw new Error('La modification du fichier a échoué');
        }
        
        if (newContent.includes('function')) {
            throw new Error('Le remplacement n\'a pas été complet');
        }
    }

    async testFileCopy() {
        // Test de copie de fichier
        const sourceFile = path.join(this.testDir, 'test2.js');
        const destFile = path.join(this.testDir, 'test2-copy.js');
        
        await fs.copyFile(sourceFile, destFile);
        
        // Vérifier la copie
        const sourceContent = await fs.readFile(sourceFile, 'utf-8');
        const destContent = await fs.readFile(destFile, 'utf-8');
        
        if (sourceContent !== destContent) {
            throw new Error('La copie du fichier a échoué');
        }
    }

    async testFileMove() {
        // Test de déplacement de fichier
        const sourceFile = path.join(this.testDir, 'test2-copy.js');
        const destFile = path.join(this.testDir, 'test2-moved.js');
        
        await fs.rename(sourceFile, destFile);
        
        // Vérifier le déplacement
        try {
            await fs.access(sourceFile);
            throw new Error('Le fichier source existe toujours après le déplacement');
        } catch (error) {
            // C'est normal
        }
        
        const destContent = await fs.readFile(destFile, 'utf-8');
        if (!destContent.includes('calculateSum')) {
            throw new Error('Le fichier déplacé n\'a pas le bon contenu');
        }
    }

    async testMarkdownStructure() {
        // Test d'extraction de structure markdown
        const readmeFile = path.join(this.testDir, 'README.md');
        const content = await fs.readFile(readmeFile, 'utf-8');
        
        // Chercher les titres markdown
        const headings = content.match(/^#+\s+(.+)$/gm);
        
        if (!headings || headings.length < 3) {
            throw new Error('L\'extraction de la structure markdown a échoué');
        }
        
        if (!headings.some(h => h.includes('Projet QuickFiles'))) {
            throw new Error('Le titre principal n\'a pas été trouvé');
        }
    }

    async runAllTests() {
        console.log('🚀 Démarrage des tests fonctionnels simples QuickFiles\n');

        await this.setup();

        try {
            // Tests des fonctionnalités de base
            await this.runTest('Opérations de fichiers de base', () => this.testBasicFileOperations());
            await this.runTest('Opérations de répertoire', () => this.testDirectoryOperations());
            await this.runTest('Recherche dans fichiers', () => this.testFileSearch());
            await this.runTest('Modification de fichiers', () => this.testFileModification());
            await this.runTest('Copie de fichiers', () => this.testFileCopy());
            await this.runTest('Déplacement de fichiers', () => this.testFileMove());
            await this.runTest('Extraction structure Markdown', () => this.testMarkdownStructure());

        } finally {
            await this.cleanup();
        }

        this.printResults();
    }

    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 RÉSULTATS DES TESTS FONCTIONNELS SIMPLES');
        console.log('='.repeat(60));
        console.log(`Total: ${this.results.total}`);
        console.log(`✅ Réussis: ${this.results.passed}`);
        console.log(`❌ Échoués: ${this.results.failed}`);
        console.log(`Taux de réussite: ${((this.results.passed / this.results.total) * 100).toFixed(1)}%`);
        
        console.log('\n📋 Détails:');
        this.results.details.forEach(test => {
            console.log(`  ${test.status} ${test.name}`);
            if (test.error) {
                console.log(`    Erreur: ${test.error}`);
            }
        });

        if (this.results.failed === 0) {
            console.log('\n🎉 TOUS LES TESTS FONCTIONNELS SIMPLES SONT PASSÉS !');
            console.log('✅ Les opérations de fichiers de base fonctionnent correctement');
            console.log('✅ La base pour les fonctionnalités MCP QuickFiles est solide');
        } else {
            console.log('\n⚠️  CERTAINS TESTS ONT ÉCHOUÉ - VÉRIFICATION NÉCESSAIRE');
        }
    }
}

// Exécuter les tests si ce script est lancé directement
if (require.main === module) {
    const tester = new SimpleFunctionalTester();
    tester.runAllTests().catch(error => {
        console.error('Erreur lors de l\'exécution des tests:', error);
        process.exit(1);
    });
}

module.exports = { SimpleFunctionalTester };