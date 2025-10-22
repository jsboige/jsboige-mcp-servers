#!/usr/bin/env node

/**
 * Script de validation détection workspace sur fixtures réelles
 * Mission SDDD - Phase 1: Inventaire et analyse patterns
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemins de fixtures
const FIXTURES_BASE = './tests/fixtures';
const FIXTURE_SUBDIRS = ['controlled-hierarchy', 'real-tasks'];

class WorkspaceDetectionValidator {
    constructor() {
        this.results = {
            withMetadata: [],
            withoutMetadata: [],
            workspacePatterns: new Map(),
            errors: []
        };
    }

    /**
     * Phase 1 : Inventaire complet des fixtures
     */
    async inventoryFixtures() {
        console.log('🔍 PHASE 1: Inventaire des fixtures disponibles\n');
        
        for (const subdir of FIXTURE_SUBDIRS) {
            const fixturesPath = path.join(FIXTURES_BASE, subdir);
            
            try {
                const entries = await fs.readdir(fixturesPath, { withFileTypes: true });
                const taskDirs = entries.filter(entry => entry.isDirectory());
                
                console.log(`📂 ${subdir}: ${taskDirs.length} fixtures`);
                
                for (const taskDir of taskDirs) {
                    await this.analyzeFixture(path.join(fixturesPath, taskDir.name), taskDir.name);
                }
            } catch (error) {
                this.results.errors.push(`Erreur lecture ${fixturesPath}: ${error.message}`);
            }
        }

        this.printInventoryResults();
    }

    /**
     * Analyse d'une fixture individuelle
     */
    async analyzeFixture(fixturePath, taskId) {
        try {
            const metadataPath = path.join(fixturePath, 'task_metadata.json');
            const uiMessagesPath = path.join(fixturePath, 'ui_messages.json');
            
            // Vérifier présence fichiers
            const hasMetadata = await this.fileExists(metadataPath);
            const hasUiMessages = await this.fileExists(uiMessagesPath);
            
            const fixtureInfo = {
                taskId,
                path: fixturePath,
                hasMetadata,
                hasUiMessages,
                workspace: null,
                workspaceSource: null,
                metadataStructure: null
            };

            // Analyser métadonnées si présentes
            if (hasMetadata) {
                try {
                    const content = await fs.readFile(metadataPath, 'utf8');
                    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
                    const metadata = JSON.parse(cleanContent);
                    
                    fixtureInfo.workspace = metadata.workspace || null;
                    fixtureInfo.workspaceSource = 'metadata';
                    fixtureInfo.metadataStructure = {
                        hasWorkspace: !!metadata.workspace,
                        hasCwd: !!metadata.cwd,
                        hasCreatedAt: !!metadata.createdAt,
                        hasMessageCount: !!metadata.messageCount,
                        keys: Object.keys(metadata)
                    };

                    // Compter les patterns de workspace
                    if (metadata.workspace) {
                        const normalized = path.normalize(metadata.workspace).toLowerCase();
                        this.results.workspacePatterns.set(
                            normalized,
                            (this.results.workspacePatterns.get(normalized) || 0) + 1
                        );
                    }

                    this.results.withMetadata.push(fixtureInfo);
                } catch (error) {
                    this.results.errors.push(`Erreur parsing metadata ${taskId}: ${error.message}`);
                    fixtureInfo.workspace = null;
                    this.results.withoutMetadata.push(fixtureInfo);
                }
            } else {
                // Fixture sans métadonnées - candidat pour fallback environment_details
                this.results.withoutMetadata.push(fixtureInfo);
            }

        } catch (error) {
            this.results.errors.push(`Erreur analyse fixture ${taskId}: ${error.message}`);
        }
    }

    /**
     * Vérifier existence d'un fichier
     */
    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Phase 2 : Analyse des patterns workspace détectés
     */
    async analyzeWorkspacePatterns() {
        console.log('\n🔍 PHASE 2: Analyse des patterns de workspace\n');
        
        console.log('📊 Distribution des workspaces:');
        
        // Trier par fréquence
        const sortedPatterns = Array.from(this.results.workspacePatterns.entries())
            .sort((a, b) => b[1] - a[1]);
        
        sortedPatterns.forEach(([workspace, count]) => {
            console.log(`  ${workspace}: ${count} fixture(s)`);
        });

        console.log('\n📋 Patterns identifiés:');
        sortedPatterns.forEach(([workspace, count]) => {
            if (workspace.includes('roo-extensions')) {
                console.log(`  ✅ Pattern roo-extensions: ${workspace}`);
            } else if (workspace.includes('epita') || workspace.includes('intelligence')) {
                console.log(`  ✅ Pattern Epita: ${workspace}`);
            } else {
                console.log(`  ❓ Pattern autre: ${workspace}`);
            }
        });
    }

    /**
     * Phase 3: Préparation données tests métadonnées
     */
    async prepareMetadataTests() {
        console.log('\n🔍 PHASE 3: Préparation tests détection métadonnées\n');
        
        const metadataFixtures = this.results.withMetadata.filter(f => f.workspace);
        
        console.log(`📊 Fixtures avec workspace metadata: ${metadataFixtures.length}`);
        console.log('🎯 Fixtures candidates pour tests detectFromMetadata():');
        
        metadataFixtures.forEach(fixture => {
            const workspaceShort = fixture.workspace.split('/').pop() || fixture.workspace.split('\\').pop();
            console.log(`  • ${fixture.taskId} → ${workspaceShort}`);
        });

        return metadataFixtures;
    }

    /**
     * Phase 4: Préparation données tests fallback
     */
    async prepareFallbackTests() {
        console.log('\n🔍 PHASE 4: Préparation tests fallback environment_details\n');
        
        const fallbackCandidates = this.results.withoutMetadata.filter(f => f.hasUiMessages);
        
        console.log(`📊 Fixtures sans metadata avec ui_messages: ${fallbackCandidates.length}`);
        console.log('🎯 Fixtures candidates pour tests detectFromEnvironmentDetails():');
        
        fallbackCandidates.forEach(fixture => {
            console.log(`  • ${fixture.taskId} → ui_messages.json disponible`);
        });

        return fallbackCandidates;
    }

    /**
     * Affichage résultats inventaire
     */
    printInventoryResults() {
        console.log('\n📊 RÉSULTATS INVENTAIRE:');
        console.log(`  • Fixtures avec task_metadata.json: ${this.results.withMetadata.length}`);
        console.log(`  • Fixtures sans métadonnées: ${this.results.withoutMetadata.length}`);
        console.log(`  • Patterns workspace uniques: ${this.results.workspacePatterns.size}`);
        console.log(`  • Erreurs rencontrées: ${this.results.errors.length}`);

        if (this.results.errors.length > 0) {
            console.log('\n⚠️ ERREURS:');
            this.results.errors.forEach(error => console.log(`  • ${error}`));
        }
    }

    /**
     * Exécution complète de l'inventaire
     */
    async run() {
        console.log('🚀 MISSION SDDD: Validation Détection Workspace sur Fixtures Réelles');
        console.log('='*80);
        
        try {
            // Phase 1: Inventaire
            await this.inventoryFixtures();
            
            // Phase 2: Analyse patterns
            await this.analyzeWorkspacePatterns();
            
            // Phase 3: Préparation tests métadonnées
            const metadataFixtures = await this.prepareMetadataTests();
            
            // Phase 4: Préparation tests fallback
            const fallbackFixtures = await this.prepareFallbackTests();
            
            // Résumé final
            console.log('\n🎯 RÉSUMÉ POUR TESTS:');
            console.log(`  • Tests detectFromMetadata(): ${metadataFixtures.length} fixtures`);
            console.log(`  • Tests detectFromEnvironmentDetails(): ${fallbackFixtures.length} fixtures`);
            console.log(`  • Couverture totale: ${metadataFixtures.length + fallbackFixtures.length} fixtures`);
            
            return {
                metadataFixtures,
                fallbackFixtures,
                summary: this.results
            };
            
        } catch (error) {
            console.error('❌ Erreur exécution:', error);
            throw error;
        }
    }
}

// Exécution si script appelé directement
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const validator = new WorkspaceDetectionValidator();
    validator.run()
        .then(() => {
            console.log('\n✅ Inventaire terminé avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Échec inventaire:', error);
            process.exit(1);
        });
}

export { WorkspaceDetectionValidator };