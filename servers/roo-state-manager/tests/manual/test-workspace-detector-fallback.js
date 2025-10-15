#!/usr/bin/env node

/**
 * Test spécifique WorkspaceDetector.detectFromEnvironmentDetails() avec patterns réels
 * Mission SDDD - Phase 3: Validation détection fallback environment_details
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceDetector } from './build/src/utils/workspace-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WorkspaceDetectorFallbackValidator {
    constructor() {
        this.detector = new WorkspaceDetector({
            enableCache: false,
            validateExistence: false, 
            normalizePaths: true
        });
        
        this.results = {
            tested: 0,
            successful: 0,
            failed: 0,
            details: [],
            patterns: new Map(),
            environmentDetailsFound: 0,
            performance: []
        };

        // Fixtures avec ui_messages.json à tester
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
                id: 'bc93a6f7-cd2e-4686-a832-46e3cd14d338', 
                expected: 'd:/dev/roo-extensions',
                subdir: 'real-tasks'
            },
            { 
                id: 'ac8aa7b4-319c-4925-a139-4f4adca81921', 
                expected: 'd:/dev/roo-extensions',
                subdir: 'real-tasks'
            }
        ];
    }

    /**
     * Test complet detectFromEnvironmentDetails sur fixtures réelles
     */
    async runTests() {
        console.log('🧪 TEST WorkspaceDetector.detectFromEnvironmentDetails() patterns réels');
        console.log('='*80);
        console.log(`📊 Fixtures à tester: ${this.testFixtures.length}`);
        console.log('');

        for (const fixture of this.testFixtures) {
            await this.testFixture(fixture);
        }

        this.printResults();
        this.analyzePatterns();
        this.analyzeEnvironmentDetailsContent();
        
        return this.results;
    }

    /**
     * Test d'une fixture individuelle pour fallback environment_details
     */
    async testFixture(fixture) {
        const fixturePath = path.join('./tests/fixtures', fixture.subdir, fixture.id);
        console.log(`🔍 Test Fallback ${fixture.id}...`);
        
        this.results.tested++;
        const startTime = process.hrtime.bigint();
        
        try {
            // Tester directement detectFromEnvironmentDetails (ignore les métadonnées)
            const result = await this.detector.detectFromEnvironmentDetails(fixturePath);
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
                testResult.issues.push('Aucun résultat depuis environment_details');
            } else {
                // Validation du workspace détecté
                const normalizedDetected = result.workspace?.toLowerCase();
                const normalizedExpected = fixture.expected.toLowerCase();
                
                testResult.workspaceMatch = normalizedDetected === normalizedExpected;
                testResult.sourceCorrect = result.source === 'environment_details';
                testResult.confidenceCorrect = result.confidence === 0.85;
                
                if (!testResult.workspaceMatch) {
                    testResult.issues.push(`Workspace: attendu '${fixture.expected}', reçu '${result.workspace}'`);
                }
                if (!testResult.sourceCorrect) {
                    testResult.issues.push(`Source: attendu 'environment_details', reçu '${result.source}'`);
                }
                if (!testResult.confidenceCorrect) {
                    testResult.issues.push(`Confidence: attendu 0.85, reçu ${result.confidence}`);
                }

                testResult.success = testResult.workspaceMatch && testResult.sourceCorrect && testResult.confidenceCorrect;
            }

            if (testResult.success) {
                this.results.successful++;
                console.log(`  ✅ ${fixture.id} → ${result.workspace} (${durationMs.toFixed(2)}ms)`);
                
                // Comptabiliser les patterns
                const pattern = this.categorizeWorkspace(result.workspace);
                this.results.patterns.set(pattern, (this.results.patterns.get(pattern) || 0) + 1);
                this.results.environmentDetailsFound++;
            } else {
                this.results.failed++;
                console.log(`  ❌ ${fixture.id} → ÉCHEC FALLBACK`);
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
     * Analyser le contenu environment_details trouvé
     */
    async analyzeEnvironmentDetailsContent() {
        console.log('\n🔍 ANALYSE CONTENU ENVIRONMENT_DETAILS:');
        
        for (const fixture of this.testFixtures.slice(0, 2)) {
            const fixturePath = path.join('./tests/fixtures', fixture.subdir, fixture.id);
            const uiMessagesPath = path.join(fixturePath, 'ui_messages.json');
            
            try {
                const content = await fs.readFile(uiMessagesPath, 'utf8');
                const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
                const messages = JSON.parse(cleanContent);
                
                console.log(`\n  📄 ${fixture.id}:`);
                console.log(`    • Messages totaux: ${messages.length}`);
                
                // Chercher patterns environment_details
                let workspacePatternFound = false;
                let patternCount = 0;
                
                for (const message of messages) {
                    let textContent = '';
                    
                    if (message.type === 'say' && typeof message.text === 'string') {
                        textContent = message.text;
                    } else if (message.type === 'ask' && typeof message.text === 'string') {
                        textContent = message.text;
                    }
                    
                    if (textContent.includes('Current Workspace Directory')) {
                        patternCount++;
                        const workspaceMatch = textContent.match(/# Current Workspace Directory \(([^)]+)\) Files/i);
                        if (workspaceMatch) {
                            workspacePatternFound = true;
                            console.log(`    • Pattern trouvé: "${workspaceMatch[1]}"`);
                        }
                    }
                }
                
                console.log(`    • Patterns détectés: ${patternCount}`);
                console.log(`    • Workspace extrait: ${workspacePatternFound ? '✅' : '❌'}`);
                
            } catch (error) {
                console.log(`    • Erreur analyse: ${error.message}`);
            }
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
     * Test simulation stratégie dual complète
     */
    async testDualStrategySimulation() {
        console.log('\n🔄 SIMULATION STRATÉGIE DUAL COMPLÈTE:');
        
        const testFixture = this.testFixtures[0];
        const fixturePath = path.join('./tests/fixtures', testFixture.subdir, testFixture.id);
        
        console.log(`📍 Test sur: ${testFixture.id}`);
        
        try {
            // Test stratégie complète detect()
            const fullResult = await this.detector.detect(fixturePath);
            console.log(`  • detect() → ${fullResult.workspace} (source: ${fullResult.source}, confiance: ${fullResult.confidence})`);
            
            // Simulation sans métadonnées (renommage temporaire)
            const metadataPath = path.join(fixturePath, 'task_metadata.json');
            const tempPath = path.join(fixturePath, 'task_metadata.json.tmp');
            
            try {
                await fs.rename(metadataPath, tempPath);
                console.log('  • Métadonnées temporairement masquées');
                
                const fallbackResult = await this.detector.detect(fixturePath);
                console.log(`  • detect() sans metadata → ${fallbackResult.workspace} (source: ${fallbackResult.source})`);
                
                // Restaurer métadonnées
                await fs.rename(tempPath, metadataPath);
                console.log('  • Métadonnées restaurées');
                
                // Vérifier que le fallback donne le même résultat
                const workspaceMatch = fallbackResult.workspace?.toLowerCase() === testFixture.expected.toLowerCase();
                console.log(`  • Cohérence dual: ${workspaceMatch ? '✅' : '❌'}`);
                
            } catch (renameError) {
                console.log(`  • Erreur simulation: ${renameError.message}`);
            }
            
        } catch (error) {
            console.log(`  • Erreur test dual: ${error.message}`);
        }
    }

    /**
     * Affichage des résultats détaillés
     */
    printResults() {
        console.log('\n📊 RÉSULTATS FALLBACK ENVIRONMENT_DETAILS:');
        console.log(`  • Tests exécutés: ${this.results.tested}`);
        console.log(`  • Succès fallback: ${this.results.successful} (${((this.results.successful/this.results.tested)*100).toFixed(1)}%)`);
        console.log(`  • Échecs: ${this.results.failed} (${((this.results.failed/this.results.tested)*100).toFixed(1)}%)`);
        console.log(`  • Environment_details trouvés: ${this.results.environmentDetailsFound}`);
        
        console.log('\n🎯 CRITÈRES FALLBACK:');
        const detectionRate = (this.results.successful/this.results.tested)*100;
        
        if (detectionRate >= 85) {
            console.log(`  ✅ Taux détection fallback: ${detectionRate.toFixed(1)}% (≥85% requis)`);
        } else {
            console.log(`  ❌ Taux détection fallback: ${detectionRate.toFixed(1)}% (<85% requis)`);
        }
    }

    /**
     * Analyse des patterns de workspace
     */
    analyzePatterns() {
        console.log('\n🔍 ANALYSE PATTERNS FALLBACK:');
        
        Array.from(this.results.patterns.entries())
            .sort((a, b) => b[1] - a[1])
            .forEach(([pattern, count]) => {
                console.log(`  • ${pattern}: ${count} détection(s) fallback réussie(s)`);
            });
    }
}

// Exécution si script appelé directement
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const validator = new WorkspaceDetectorFallbackValidator();
    
    validator.runTests()
        .then(async (results) => {
            await validator.testDualStrategySimulation();
            
            console.log('\n🎯 VALIDATION SDDD - PHASE 3 TERMINÉE');
            
            // Résumé final pour rapport
            const detectionRate = (results.successful/results.tested)*100;
            const avgPerformance = results.performance.reduce((a, p) => a + p.duration, 0) / results.performance.length;
            
            console.log('\n📋 RÉSUMÉ FALLBACK:');
            console.log(`  • Stratégie fallback validée: ${detectionRate >= 85 ? '✅' : '❌'}`);
            console.log(`  • Performance fallback: ${avgPerformance < 50 ? '✅' : '❌'}`);
            console.log(`  • Patterns environment_details: ${results.environmentDetailsFound} trouvés`);
            console.log(`  • Stratégie dual cohérente: Tests effectués`);
            
            process.exit(detectionRate >= 85 ? 0 : 1);
        })
        .catch(error => {
            console.error('\n❌ Échec validation fallback:', error);
            process.exit(1);
        });
}

export { WorkspaceDetectorFallbackValidator };