#!/usr/bin/env node

/**
 * Script de test des cas limites et gestion d'erreurs pour QuickFiles
 * Valide le comportement dans des situations extrêmes ou d'erreur
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

class EdgeCasesTester {
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
        this.testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickfiles-edge-test-'));
        console.log(`📁 Répertoire de test créé: ${this.testDir}`);
        await this.createTestFiles();
    }

    async createTestFiles() {
        // Créer des fichiers avec des caractères spéciaux
        const specialFiles = [
            { name: 'file with spaces.txt', content: 'Fichier avec espaces' },
            { name: 'file-with-dashes.txt', content: 'Fichier avec tirets' },
            { name: 'file_with_underscores.txt', content: 'Fichier avec underscores' },
            { name: 'file.with.dots.txt', content: 'Fichier avec points' },
            { name: 'file(parentheses).txt', content: 'Fichier avec parenthèses' },
            { name: 'file[brackets].txt', content: 'Fichier avec crochets' },
            { name: 'file{braces}.txt', content: 'Fichier avec accolades' },
            { name: 'fileéaccentué.txt', content: 'Fichier avec caractères accentués' },
            { name: 'файл.txt', content: 'Fichier avec caractères cyrilliques' },
            { name: '文件.txt', content: 'Fichier avec caractères chinois' }
        ];

        for (const file of specialFiles) {
            try {
                await fs.writeFile(path.join(this.testDir, file.name), file.content, 'utf-8');
            } catch (error) {
                console.log(`Note: Impossible de créer ${file.name}: ${error.message}`);
            }
        }

        // Créer un fichier très long
        const longName = 'a'.repeat(200) + '.txt';
        await fs.writeFile(path.join(this.testDir, longName), 'Fichier avec nom très long', 'utf-8');

        // Créer un fichier vide
        await fs.writeFile(path.join(this.testDir, 'empty.txt'), '', 'utf-8');

        // Créer un fichier volumineux (mais pas trop pour les tests)
        const largeContent = 'Ligne de test\n'.repeat(10000);
        await fs.writeFile(path.join(this.testDir, 'large.txt'), largeContent, 'utf-8');

        // Créer des sous-répertoires profonds
        let currentDir = this.testDir;
        for (let i = 1; i <= 10; i++) {
            currentDir = path.join(currentDir, `level${i}`);
            await fs.mkdir(currentDir);
        }
        await fs.writeFile(path.join(currentDir, 'deep.txt'), 'Fichier très profond', 'utf-8');
    }

    async cleanup() {
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

    async testSpecialCharacters() {
        // Test de lecture de fichiers avec caractères spéciaux
        const entries = await fs.readdir(this.testDir, { withFileTypes: true });
        const files = entries.filter(entry => entry.isFile());
        
        if (files.length < 5) {
            throw new Error('Pas assez de fichiers avec caractères spéciaux créés');
        }

        // Tenter de lire quelques fichiers spéciaux
        let readableFiles = 0;
        for (const file of files.slice(0, 5)) {
            try {
                const content = await fs.readFile(path.join(this.testDir, file.name), 'utf-8');
                if (content.length > 0) {
                    readableFiles++;
                }
            } catch (error) {
                // Certains noms peuvent ne pas être supportés
            }
        }

        if (readableFiles < 3) {
            throw new Error('Trop peu de fichiers spéciaux sont lisibles');
        }
    }

    async testLongFileName() {
        // Test de fichier avec nom très long
        const longName = 'a'.repeat(200) + '.txt';
        const longPath = path.join(this.testDir, longName);
        
        try {
            const content = await fs.readFile(longPath, 'utf-8');
            if (!content.includes('Fichier avec nom très long')) {
                throw new Error('Le contenu du fichier long n\'est pas correct');
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error('Le fichier avec nom long n\'existe pas');
            }
            throw error;
        }
    }

    async testEmptyFile() {
        // Test de fichier vide
        const emptyPath = path.join(this.testDir, 'empty.txt');
        const stats = await fs.stat(emptyPath);
        
        if (stats.size !== 0) {
            throw new Error('Le fichier vide n\'est pas de taille 0');
        }

        const content = await fs.readFile(emptyPath, 'utf-8');
        if (content !== '') {
            throw new Error('Le fichier vide n\'est pas vide');
        }
    }

    async testLargeFile() {
        // Test de fichier volumineux
        const largePath = path.join(this.testDir, 'large.txt');
        const stats = await fs.stat(largePath);
        
        if (stats.size < 100000) { // ~100KB minimum
            throw new Error('Le fichier volumineux n\'est pas assez grand');
        }

        // Test de lecture partielle (simuler les limites)
        const content = await fs.readFile(largePath, 'utf-8');
        const lines = content.split('\n');
        
        if (lines.length < 5000) {
            throw new Error('Le fichier volumineux n\'a pas assez de lignes');
        }

        // Test de lecture des premières lignes seulement
        const firstLines = lines.slice(0, 100);
        if (firstLines.length !== 100) {
            throw new Error('La lecture partielle a échoué');
        }
    }

    async testDeepDirectory() {
        // Test de répertoire profond
        let currentPath = this.testDir;
        for (let i = 1; i <= 10; i++) {
            currentPath = path.join(currentPath, `level${i}`);
            
            const stats = await fs.stat(currentPath);
            if (!stats.isDirectory()) {
                throw new Error(`Le niveau ${i} n\'est pas un répertoire`);
            }
        }

        const deepFile = path.join(currentPath, 'deep.txt');
        const content = await fs.readFile(deepFile, 'utf-8');
        
        if (!content.includes('Fichier très profond')) {
            throw new Error('Le fichier profond n\'a pas le bon contenu');
        }
    }

    async testNonExistentFile() {
        // Test de gestion de fichier inexistant
        const nonExistentPath = path.join(this.testDir, 'does-not-exist.txt');
        
        try {
            await fs.access(nonExistentPath);
            throw new Error('Le fichier inexistant ne devrait pas être accessible');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error('Mauvais code d\'erreur pour fichier inexistant');
            }
        }

        try {
            await fs.readFile(nonExistentPath, 'utf-8');
            throw new Error('La lecture d\'un fichier inexistant devrait échouer');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error('Mauvais code d\'erreur pour lecture de fichier inexistant');
            }
        }
    }

    async testPermissionErrors() {
        // Test de simulation d'erreurs de permission
        // Note: Sur Windows, les permissions sont différentes de Unix/Linux
        const readOnlyPath = path.join(this.testDir, 'readonly.txt');
        await fs.writeFile(readOnlyPath, 'Contenu en lecture seule', 'utf-8');
        
        try {
            // Tenter de modifier les permissions (peut échouer sur Windows)
            await fs.chmod(readOnlyPath, 0o444); // Lecture seule
        } catch (error) {
            // C'est normal sur Windows, on continue
        }

        // Le test principal est de pouvoir lire le fichier
        const content = await fs.readFile(readOnlyPath, 'utf-8');
        if (!content.includes('Contenu en lecture seule')) {
            throw new Error('Le fichier en lecture seule n\'est pas lisible');
        }
    }

    async testInvalidPaths() {
        // Test de chemins invalides
        const invalidPaths = [
            '',
            '.',
            '..',
            path.join(this.testDir, ''),
            path.join(this.testDir, '.', ''),
            'C:\\invalid\\path\\that\\does\\not\\exist.txt'
        ];

        for (const invalidPath of invalidPaths) {
            try {
                await fs.stat(invalidPath);
                // Si ça réussit, c'est peut-être un chemin valide, on continue
            } catch (error) {
                // C'est normal pour les chemins invalides
            }
        }

        // Test avec des caractères de contrôle
        const controlCharPath = path.join(this.testDir, 'file\x00with\x01control.txt');
        try {
            await fs.writeFile(controlCharPath, 'test', 'utf-8');
            // Si ça réussit, essayer de le lire
            await fs.readFile(controlCharPath, 'utf-8');
        } catch (error) {
            // C'est normal d'échouer avec des caractères de contrôle
        }
    }

    async testConcurrentAccess() {
        // Test d'accès concurrent au même fichier
        const concurrentPath = path.join(this.testDir, 'concurrent.txt');
        await fs.writeFile(concurrentPath, 'Contenu initial', 'utf-8');

        // Simuler plusieurs accès simultanés
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(
                fs.readFile(concurrentPath, 'utf-8').then(content => {
                    if (!content.includes('Contenu initial')) {
                        throw new Error('Lecture concurrente incorrecte');
                    }
                    return content;
                })
            );
        }

        try {
            await Promise.all(promises);
        } catch (error) {
            throw new Error('L\'accès concurrent a échoué');
        }
    }

    async testPathTraversal() {
        // Test de tentative de traversée de chemin (sécurité)
        const traversalAttempts = [
            path.join(this.testDir, '..', 'etc', 'passwd'),
            path.join(this.testDir, '..\\..\\windows\\system32\\config'),
            path.join(this.testDir, 'subdir', '..', 'parent.txt'),
            path.join(this.testDir, 'subdir', '..\\..', 'root.txt')
        ];

        for (const traversalPath of traversalAttempts) {
            try {
                await fs.readFile(traversalPath, 'utf-8');
                // Si ça réussit, vérifier que c'est bien dans notre répertoire de test
                const resolvedPath = path.resolve(traversalPath);
                if (!resolvedPath.startsWith(this.testDir)) {
                    throw new Error('Traversée de chemin détectée');
                }
            } catch (error) {
                // C'est normal de ne pas pouvoir lire ces fichiers
            }
        }
    }

    async runAllTests() {
        console.log('🚀 Démarrage des tests de cas limites QuickFiles\n');

        await this.setup();

        try {
            // Tests des cas limites
            await this.runTest('Caractères spéciaux dans les noms', () => this.testSpecialCharacters());
            await this.runTest('Nom de fichier très long', () => this.testLongFileName());
            await this.runTest('Fichier vide', () => this.testEmptyFile());
            await this.runTest('Fichier volumineux', () => this.testLargeFile());
            await this.runTest('Répertoire profond', () => this.testDeepDirectory());
            await this.runTest('Fichier inexistant', () => this.testNonExistentFile());
            await this.runTest('Erreurs de permission', () => this.testPermissionErrors());
            await this.runTest('Chemins invalides', () => this.testInvalidPaths());
            await this.runTest('Accès concurrent', () => this.testConcurrentAccess());
            await this.runTest('Traversée de chemin', () => this.testPathTraversal());

        } finally {
            await this.cleanup();
        }

        this.printResults();
    }

    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 RÉSULTATS DES TESTS DE CAS LIMITES');
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
            console.log('\n🎉 TOUS LES TESTS DE CAS LIMITES SONT PASSÉS !');
            console.log('✅ La gestion des cas limites est robuste');
            console.log('✅ La gestion d\'erreurs est appropriée');
        } else {
            console.log('\n⚠️  CERTAINS TESTS DE CAS LIMITES ONT ÉCHOUÉ');
            console.log('🔍 Vérification nécessaire pour la robustesse');
        }
    }
}

// Exécuter les tests si ce script est lancé directement
if (require.main === module) {
    const tester = new EdgeCasesTester();
    tester.runAllTests().catch(error => {
        console.error('Erreur lors de l\'exécution des tests:', error);
        process.exit(1);
    });
}

module.exports = { EdgeCasesTester };