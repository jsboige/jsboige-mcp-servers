#!/usr/bin/env node

/**
 * Script de test fonctionnel pour QuickFiles MCP Server
 * Valide les fonctionnalités clés dans un contexte réel
 */

const { QuickFilesServer } = require('./build/index.js');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

class FunctionalTester {
    constructor() {
        this.server = new QuickFilesServer();
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
        this.testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickfiles-functional-test-'));
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
            },
            {
                name: 'config.json',
                content: `{
    "name": "test-config",
    "version": "1.0.0",
    "settings": {
        "debug": true,
        "timeout": 5000
    }
}`
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

    async testReadMultipleFiles() {
        const request = {
            params: {
                arguments: {
                    paths: [
                        path.join(this.testDir, 'test1.txt'),
                        path.join(this.testDir, 'test2.js')
                    ],
                    show_line_numbers: true,
                    max_lines_per_file: 10
                }
            }
        };

        const result = await this.server.handleReadMultipleFiles(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('test1.txt') || !content.includes('test2.js')) {
            throw new Error('Les noms de fichiers ne sont pas présents dans le résultat');
        }

        if (!content.includes('1 |')) {
            throw new Error('Les numéros de ligne ne sont pas affichés');
        }
    }

    async testListDirectoryContents() {
        const request = {
            params: {
                arguments: {
                    paths: [this.testDir],
                    recursive: false,
                    max_lines: 20
                }
            }
        };

        const result = await this.server.handleListDirectoryContents(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('test1.txt') || !content.includes('test2.js')) {
            throw new Error('Les fichiers ne sont pas listés');
        }

        if (!content.includes('subdir')) {
            throw new Error('Le sous-répertoire n\'est pas listé');
        }
    }

    async testListDirectoryRecursive() {
        const request = {
            params: {
                arguments: {
                    paths: [this.testDir],
                    recursive: true,
                    max_depth: 2,
                    max_lines: 50
                }
            }
        };

        const result = await this.server.handleListDirectoryContents(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('nested.txt')) {
            throw new Error('Le fichier imbriqué n\'est pas trouvé dans la liste récursive');
        }
    }

    async testEditMultipleFiles() {
        const request = {
            params: {
                arguments: {
                    files: [
                        {
                            path: path.join(this.testDir, 'test1.txt'),
                            diffs: [
                                {
                                    search: 'function',
                                    replace: 'méthode'
                                }
                            ]
                        }
                    ]
                }
            }
        };

        const result = await this.server.handleEditMultipleFiles(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('modification(s) effectuée(s)')) {
            throw new Error('La modification n\'a pas été appliquée');
        }

        // Vérifier que le fichier a bien été modifié
        const modifiedContent = await fs.readFile(path.join(this.testDir, 'test1.txt'), 'utf-8');
        if (!modifiedContent.includes('méthode')) {
            throw new Error('Le fichier n\'a pas été réellement modifié');
        }
    }

    async testSearchInFiles() {
        const request = {
            params: {
                arguments: {
                    paths: [this.testDir],
                    pattern: 'function',
                    use_regex: false,
                    case_sensitive: false,
                    context_lines: 1,
                    max_results_per_file: 10,
                    max_total_results: 20,
                    recursive: true
                }
            }
        };

        const result = await this.server.handleSearchInFiles(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('Résultats de recherche')) {
            throw new Error('Le format de résultat de recherche est incorrect');
        }

        if (!content.includes('test2.js')) {
            throw new Error('Les résultats de recherche ne contiennent pas les fichiers attendus');
        }
    }

    async testSearchAndReplace() {
        const request = {
            params: {
                arguments: {
                    paths: [this.testDir],
                    search: 'calculate',
                    replace: 'compute',
                    use_regex: false,
                    case_sensitive: true,
                    preview: false,
                    file_pattern: '*.js'
                }
            }
        };

        const result = await this.server.handleSearchAndReplace(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('Modifications effectuées')) {
            throw new Error('Le format de résultat de remplacement est incorrect');
        }

        // Vérifier que le fichier a bien été modifié
        const modifiedContent = await fs.readFile(path.join(this.testDir, 'test2.js'), 'utf-8');
        if (!modifiedContent.includes('computeSum')) {
            throw new Error('Le remplacement n\'a pas été appliqué correctement');
        }
    }

    async testCopyFiles() {
        const destDir = path.join(this.testDir, 'copied');
        await fs.mkdir(destDir);

        const request = {
            params: {
                arguments: {
                    operations: [
                        {
                            source: path.join(this.testDir, 'test1.txt'),
                            destination: path.join(destDir, 'test1-copy.txt')
                        }
                    ]
                }
            }
        };

        const result = await this.server.handleCopyFiles(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('fichier(s) traité(s)')) {
            throw new Error('Le format de résultat de copie est incorrect');
        }

        // Vérifier que le fichier a bien été copié
        const copiedContent = await fs.readFile(path.join(destDir, 'test1-copy.txt'), 'utf-8');
        if (!copiedContent.includes('Ceci est un fichier de test')) {
            throw new Error('Le fichier n\'a pas été copié correctement');
        }
    }

    async testMoveFiles() {
        const destDir = path.join(this.testDir, 'moved');
        await fs.mkdir(destDir);

        const request = {
            params: {
                arguments: {
                    operations: [
                        {
                            source: path.join(this.testDir, 'config.json'),
                            destination: path.join(destDir, 'config-moved.json')
                        }
                    ]
                }
            }
        };

        const result = await this.server.handleMoveFiles(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('fichier(s) traité(s)')) {
            throw new Error('Le format de résultat de déplacement est incorrect');
        }

        // Vérifier que le fichier a bien été déplacé
        const movedContent = await fs.readFile(path.join(destDir, 'config-moved.json'), 'utf-8');
        if (!movedContent.includes('test-config')) {
            throw new Error('Le fichier n\'a pas été déplacé correctement');
        }

        // Vérifier que l'original n'existe plus
        try {
            await fs.access(path.join(this.testDir, 'config.json'));
            throw new Error('Le fichier original existe toujours après le déplacement');
        } catch (error) {
            // C'est normal, le fichier ne devrait plus exister
        }
    }

    async testDeleteFiles() {
        // Créer un fichier temporaire à supprimer
        const tempFile = path.join(this.testDir, 'temp-to-delete.txt');
        await fs.writeFile(tempFile, 'Ce fichier va être supprimé', 'utf-8');

        const request = {
            params: {
                arguments: {
                    paths: [tempFile]
                }
            }
        };

        const result = await this.server.handleDeleteFiles(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('Fichier supprimé')) {
            throw new Error('Le format de résultat de suppression est incorrect');
        }

        // Vérifier que le fichier a bien été supprimé
        try {
            await fs.access(tempFile);
            throw new Error('Le fichier existe toujours après la suppression');
        } catch (error) {
            // C'est normal, le fichier ne devrait plus exister
        }
    }

    async testExtractMarkdownStructure() {
        const request = {
            params: {
                arguments: {
                    paths: [path.join(this.testDir, 'README.md')],
                    max_depth: 3,
                    include_context: false
                }
            }
        };

        const result = await this.server.handleExtractMarkdownStructure(request);
        
        if (!result.content || !result.content[0]) {
            throw new Error('Aucun contenu retourné');
        }

        const content = result.content[0].text;
        if (!content.includes('Structure des fichiers Markdown')) {
            throw new Error('Le format de résultat d\'extraction est incorrect');
        }

        if (!content.includes('Projet QuickFiles') || !content.includes('Description')) {
            throw new Error('La structure markdown n\'a pas été extraite correctement');
        }
    }

    async runAllTests() {
        console.log('🚀 Démarrage des tests fonctionnels QuickFiles MCP\n');

        await this.setup();

        try {
            // Tests des fonctionnalités clés
            await this.runTest('Lecture multiple de fichiers', () => this.testReadMultipleFiles());
            await this.runTest('Listage de répertoire', () => this.testListDirectoryContents());
            await this.runTest('Listage récursif', () => this.testListDirectoryRecursive());
            await this.runTest('Édition multiple de fichiers', () => this.testEditMultipleFiles());
            await this.runTest('Recherche dans fichiers', () => this.testSearchInFiles());
            await this.runTest('Recherche et remplacement', () => this.testSearchAndReplace());
            await this.runTest('Copie de fichiers', () => this.testCopyFiles());
            await this.runTest('Déplacement de fichiers', () => this.testMoveFiles());
            await this.runTest('Suppression de fichiers', () => this.testDeleteFiles());
            await this.runTest('Extraction structure Markdown', () => this.testExtractMarkdownStructure());

        } finally {
            await this.cleanup();
        }

        this.printResults();
    }

    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 RÉSULTATS DES TESTS FONCTIONNELS');
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
            console.log('\n🎉 TOUS LES TESTS FONCTIONNELS SONT PASSÉS !');
        } else {
            console.log('\n⚠️  CERTAINS TESTS ONT ÉCHOUÉ - VÉRIFICATION NÉCESSAIRE');
        }
    }
}

// Exécuter les tests si ce script est lancé directement
if (require.main === module) {
    const tester = new FunctionalTester();
    tester.runAllTests().catch(error => {
        console.error('Erreur lors de l\'exécution des tests:', error);
        process.exit(1);
    });
}

module.exports = { FunctionalTester };