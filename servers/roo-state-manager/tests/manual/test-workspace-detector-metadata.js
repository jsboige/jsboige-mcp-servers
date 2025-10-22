#!/usr/bin/env node

/**
 * Test spécifique WorkspaceDetector.detectFromMetadata() sur fixtures réelles
 * Mission SDDD - Phase 2: Validation détection métadonnées
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceDetector } from './build/src/utils/workspace-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WorkspaceDetectorMetadataValidator {
    constructor() {
        this.detector = new WorkspaceDetector({
            enableCache: false, // Tests purs sans cache
            validateExistence: false, // Focus sur parsing
            normalizePaths: true
        });
        
        this.results = {
            tested: 0,
            successful: 0,
            failed: 0,
            details: [],
            patterns: new Map(),
            performance: []
        };

        // Fixtures candidates identifiées par l'inventaire
        this.testFixtures = [
            { 
                id: '03deadab-a06d-4b29-976d-3cc142add1d9', 
                expected: 'd:/dev/2025-epita-intelligence-symbolique',
                subdir: 'controlled-hierarchy'
            },
            { 
                id: '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4', 
                expected: 'd:/dev/2025-epita-intelligence-symbolique',
                subdir: 'controlled-hierarchy'
            },
            { 
                id: '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7', 
                expected: 'd:/dev/2025-epita-intelligence-symbolique',
                subdir: 'controlled-hierarchy'
            },
            { 
                id: '91e837de-a4b2-4c18-ab9b-6fcd36596e38', 
                expected: 'd:/dev/2025-epita-intelligence-symbolique',
                subdir: 'controlled-hierarchy'
            },
            { 
                id: 'e73ea764-4971-4adb-9197-52c2f8ede8ef', 
                expected: 'd:/dev/2025-epita-intelligence-symbolique',
                subdir: 'controlled-hierarchy'
            },
            { 
                id: 'bc93a6f7-cd2e-4686-a832-46e3cd14d338', 
                expected: 'd:/dev/roo-extensions',
                subdir: 'real-tasks'
            }
        ];
    }

    /**
     * Test complet detectFromMetadata sur toutes les fixtures
     */
    async runTests() {
        console.log('🧪 TEST WorkspaceDetector.detectFromMetadata() sur fixtures réelles');
        console.log('='*80);
        console.log(`📊 Fixtures à tester: ${this.testFixtures.length}`);
        console.log('');

        for (const fixture of this.testFixtures) {
            await this.testFixture(fixture);
        }

        this.printResults();
        this.analyzePatterns();
        this.analyzePerformance();
        
        return this.results;
    }

    /**
     * Test d'une fixture individuelle
     */
    async testFixture(fixture) {
        const fixturePath = path.join('./tests/fixtures', fixture.subdir, fixture.id);
        console.log(`🔍 Test ${fixture.id}...`);
        
        this.results.tested++;
        const startTime = process.hrtime.bigint();
        
        try {
            const result = await this.detector.detectFromMetadata(fixturePath);
            const endTime = process.hrtime.bigint();
            const durationMs = Number(endTime - startTime) / 1_000_000;
            
            const testResult = {
                fixture: fixture.id,
                fixturePath,
                expected: fixture.expected,
                result,
                success: false,
                workspaceMatch: false,
                sourceCorrect: false,
                confidenceCorrect: false,
                durationMs,
                issues: []
            };

            if (!result) {
                testResult.issues.push('Aucun résultat retourné');
            } else {
                // Validation du workspace détecté
                const normalizedDetected = result.workspace?.toLowerCase();
                const normalizedExpected = fixture.expected.toLowerCase();
                
                testResult.workspaceMatch = normalizedDetected === normalizedExpected;
                testResult.sourceCorrect = result.source === 'metadata';
                testResult.confidenceCorrect = result.confidence === 0.95;
                
                if (!testResult.workspaceMatch) {
                    testResult.issues.push(`Workspace: attendu '${fixture.expected}', reçu '${result.workspace}'`);
                }
                if (!testResult.sourceCorrect) {
                    testResult.issues.push(`Source: attendu 'metadata', reçu '${result.source}'`);
                }
                if (!testResult.confidenceCorrect) {
                    testResult.issues.push(`Confidence: attendu 0.95, reçu ${result.confidence}`);
                }

                testResult.success = testResult.workspaceMatch && testResult.sourceCorrect && testResult.confidenceCorrect;
            }

            if (testResult.success) {
                this.results.successful++;
                console.log(`  ✅ ${fixture.id} → ${result.workspace} (${durationMs.toFixed(2)}ms)`);
                
                // Comptabiliser les patterns
                const pattern = this.categorizeWorkspace(result.workspace);
                this.results.patterns.set(pattern, (this.results.patterns.get(pattern) || 0) + 1);
            } else {
                this.results.failed++;
                console.log(`  ❌ ${fixture.id} → ÉCHEC`);
                testResult.issues.forEach(issue => console.log(`      • ${issue}`));
            }

            this.results.details.push(testResult);
            this.results.performance.push({
                fixture: fixture.id,
                duration: durationMs,
                success: testResult.success
            });

        } catch (error) {
            this.results.failed++;
            console.log(`  ❌ ${fixture.id} → ERREUR: ${error.message}`);
            
            this.results.details.push({
                fixture: fixture.id,
                fixturePath,
                expected: fixture.expected,
                result: null,
                success: false,
                error: error.message,
                durationMs: Number(process.hrtime.bigint() - startTime) / 1_000_000
            });
        }
    }

    /**
     * Catégoriser le workspace pour analyse patterns
     */
    categorizeWorkspace(workspace) {
        if (!workspace) return 'null';
        const lower = workspace.toLowerCase();
        
        if (lower.includes('roo-extensions')) return 'roo-extensions';
        if (lower.includes('epita') || lower.includes('intelligence')) return 'epita-intelligence';
        return 'other';
    }

    /**
     * Affichage des résultats détaillés
     */
    printResults() {
        console.log('\n📊 RÉSULTATS DÉTAILLÉS:');
        console.log(`  • Tests exécutés: ${this.results.tested}`);
        console.log(`  • Succès: ${this.results.successful} (${((this.results.successful/this.results.tested)*100).toFixed(1)}%)`);
        console.log(`  • Échecs: ${this.results.failed} (${((this.results.failed/this.results.tested)*100).toFixed(1)}%)`);
        
        console.log('\n🎯 CRITÈRES DE SUCCÈS:');
        const detectionRate = (this.results.successful/this.results.tested)*100;
        
        if (detectionRate >= 95) {
            console.log(`  ✅ Taux détection métadonnées: ${detectionRate.toFixed(1)}% (≥95% requis)`);
        } else {
            console.log(`  ❌ Taux détection métadonnées: ${detectionRate.toFixed(1)}% (<95% requis)`);
        }
    }

    /**
     * Analyse des patterns de workspace
     */
    analyzePatterns() {
        console.log('\n🔍 ANALYSE PATTERNS WORKSPACE:');
        
        Array.from(this.results.patterns.entries())
            .sort((a, b) => b[1] - a[1])
            .forEach(([pattern, count]) => {
                console.log(`  • ${pattern}: ${count} détection(s) réussie(s)`);
            });
    }

    /**
     * Analyse des performances
     */
    analyzePerformance() {
        console.log('\n⚡ ANALYSE PERFORMANCES:');
        
        const durations = this.results.performance.map(p => p.duration);
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
        const maxDuration = Math.max(...durations);
        const minDuration = Math.min(...durations);
        
        console.log(`  • Temps moyen: ${avgDuration.toFixed(2)}ms`);
        console.log(`  • Temps minimum: ${minDuration.toFixed(2)}ms`);
        console.log(`  • Temps maximum: ${maxDuration.toFixed(2)}ms`);
        
        // Seuil performance (doit être rapide)
        if (avgDuration < 10) {
            console.log(`  ✅ Performance excellente (< 10ms en moyenne)`);
        } else if (avgDuration < 50) {
            console.log(`  ⚠️ Performance acceptable (< 50ms en moyenne)`);
        } else {
            console.log(`  ❌ Performance dégradée (≥ 50ms en moyenne)`);
        }
    }

    /**
     * Test de robustesse BOM UTF-8 et formats
     */
    async testRobustness() {
        console.log('\n🛡️ TESTS ROBUSTESSE:');
        
        // Test fixture avec BOM si disponible
        for (const fixture of this.testFixtures.slice(0, 2)) {
            await this.testBOMHandling(fixture);
        }
    }

    /**
     * Test gestion BOM UTF-8
     */
    async testBOMHandling(fixture) {
        const fixturePath = path.join('./tests/fixtures', fixture.subdir, fixture.id);
        const metadataPath = path.join(fixturePath, 'task_metadata.json');
        
        try {
            const originalContent = await fs.readFile(metadataPath, 'utf8');
            
            // Vérifier si BOM présent
            const hasBOM = originalContent.charCodeAt(0) === 0xFEFF;
            console.log(`  • ${fixture.id}: BOM UTF-8 ${hasBOM ? 'détecté ✅' : 'absent ℹ️'}`);
            
            // Tester détection même avec BOM
            const result = await this.detector.detectFromMetadata(fixturePath);
            if (result && result.workspace) {
                console.log(`    → Détection réussie malgré BOM: ${result.workspace}`);
            }
            
        } catch (error) {
            console.log(`  • ${fixture.id}: Erreur test BOM: ${error.message}`);
        }
    }
}

// Exécution si script appelé directement
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const validator = new WorkspaceDetectorMetadataValidator();
    
    validator.runTests()
        .then(async (results) => {
            await validator.testRobustness();
            
            console.log('\n🎯 VALIDATION SDDD - PHASE 2 TERMINÉE');
            
            // Résumé final pour rapport
            const detectionRate = (results.successful/results.tested)*100;
            const avgPerformance = results.performance.reduce((a, p) => a + p.duration, 0) / results.performance.length;
            
            console.log('\n📋 RÉSUMÉ MISSION:');
            console.log(`  • Stratégie métadonnées validée: ${detectionRate >= 95 ? '✅' : '❌'}`);
            console.log(`  • Performance acceptable: ${avgPerformance < 50 ? '✅' : '❌'}`);
            console.log(`  • Patterns supportés: ${results.patterns.size} types identifiés`);
            console.log(`  • Robustesse BOM: Tests effectués`);
            
            process.exit(detectionRate >= 95 ? 0 : 1);
        })
        .catch(error => {
            console.error('\n❌ Échec validation:', error);
            process.exit(1);
        });
}

export { WorkspaceDetectorMetadataValidator };