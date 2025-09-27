/**
 * Script de migration pour ajouter les champs d'état d'indexation aux squelettes existants
 * Migre de l'ancien format qdrantIndexedAt vers le nouveau mécanisme d'idempotence
 */

import { RooStorageDetector } from '../build/src/utils/roo-storage-detector.js';
import { IndexingDecisionService } from '../build/src/services/indexing-decision.js';
import * as fs from 'fs/promises';
import * as path from 'path';

class IndexingStateMigration {
    constructor(dryRun = false, workspaceFilter = null) {
        this.dryRun = dryRun;
        this.workspaceFilter = workspaceFilter;
        this.indexingDecisionService = new IndexingDecisionService();
        this.stats = {
            totalSkeletons: 0,
            alreadyMigrated: 0,
            legacyMigrated: 0,
            newInitialized: 0,
            errors: 0,
            skipped: 0
        };
    }

    /**
     * Lance la migration complète
     */
    async run() {
        console.log('🚀 Démarrage de la migration des états d\'indexation...');
        console.log(`   Mode: ${this.dryRun ? 'DRY-RUN (simulation)' : 'ÉCRITURE RÉELLE'}`);
        
        if (this.workspaceFilter) {
            console.log(`   Filtre workspace: ${this.workspaceFilter}`);
        }
        
        try {
            // Obtenir tous les squelettes existants
            console.log('📊 Construction des squelettes hiérarchiques...');
            const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
                this.workspaceFilter,
                false // Pas de limite pour migration complète
            );
            
            console.log(`   Squelettes trouvés: ${skeletons.length}`);
            
            // Traiter chaque squelette
            for (const skeleton of skeletons) {
                await this.migrateSkeleton(skeleton);
            }
            
            // Rapport final
            this.printFinalReport();
            
        } catch (error) {
            console.error('💥 Erreur critique lors de la migration:', error);
            throw error;
        }
    }

    /**
     * Migre un squelette individuel
     */
    async migrateSkeleton(skeleton) {
        this.stats.totalSkeletons++;
        
        try {
            // Filtrage par workspace si spécifié
            if (this.workspaceFilter && skeleton.metadata.workspace !== this.workspaceFilter) {
                this.stats.skipped++;
                return;
            }
            
            let modified = false;
            
            // Cas 1: Déjà migré avec nouvel état complet
            if (skeleton.metadata.indexingState && 
                skeleton.metadata.indexingState.indexStatus && 
                skeleton.metadata.indexingState.indexVersion) {
                this.stats.alreadyMigrated++;
                console.log(`⏭️  [${skeleton.taskId}] Déjà migré`);
                return;
            }
            
            // Cas 2: Migration depuis qdrantIndexedAt
            if (skeleton.metadata.qdrantIndexedAt && !skeleton.metadata.indexingState?.indexStatus) {
                const migrated = this.indexingDecisionService.migrateLegacyIndexingState(skeleton);
                if (migrated) {
                    modified = true;
                    this.stats.legacyMigrated++;
                    console.log(`🔄 [${skeleton.taskId}] Migration legacy: ${skeleton.metadata.qdrantIndexedAt} → indexingState`);
                }
            }
            
            // Cas 3: Initialisation pour squelettes sans aucun état d'indexation
            else if (!skeleton.metadata.indexingState && !skeleton.metadata.qdrantIndexedAt) {
                // Initialiser un état vierge pour première indexation
                skeleton.metadata.indexingState = {
                    // Pas de status pour déclencher une première indexation
                    indexVersion: process.env.ROO_INDEX_VERSION || '1.0'
                };
                modified = true;
                this.stats.newInitialized++;
                console.log(`✨ [${skeleton.taskId}] Nouvel état initialisé`);
            }
            
            // Sauvegarder les modifications si nécessaire
            if (modified && !this.dryRun) {
                await this.saveSkeletonToDisk(skeleton);
                console.log(`💾 [${skeleton.taskId}] Sauvegardé sur disque`);
            }
            
        } catch (error) {
            this.stats.errors++;
            console.error(`❌ [${skeleton.taskId}] Erreur:`, error.message);
        }
    }

    /**
     * Sauvegarde un squelette sur le disque
     */
    async saveSkeletonToDisk(skeleton) {
        // Reproduire la logique de sauvegarde du serveur principal
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        
        for (const location of storageLocations) {
            const skeletonPath = path.join(location, '..', '.skeletons', `${skeleton.taskId}.json`);
            
            // Vérifier si le fichier existe déjà dans cet emplacement
            try {
                await fs.access(skeletonPath);
                
                // Fichier trouvé, le mettre à jour
                const skeletonData = {
                    ...skeleton,
                    lastUpdated: new Date().toISOString()
                };
                
                await fs.writeFile(skeletonPath, JSON.stringify(skeletonData, null, 2));
                return; // Arrêter après la première écriture réussie
                
            } catch (error) {
                // Fichier n'existe pas dans cet emplacement, continuer
                continue;
            }
        }
        
        // Si aucun fichier existant trouvé, créer dans le premier emplacement
        if (storageLocations.length > 0) {
            const skeletonsDir = path.join(storageLocations[0], '..', '.skeletons');
            await fs.mkdir(skeletonsDir, { recursive: true });
            
            const skeletonPath = path.join(skeletonsDir, `${skeleton.taskId}.json`);
            const skeletonData = {
                ...skeleton,
                lastUpdated: new Date().toISOString()
            };
            
            await fs.writeFile(skeletonPath, JSON.stringify(skeletonData, null, 2));
        }
    }

    /**
     * Affiche le rapport final de migration
     */
    printFinalReport() {
        console.log('\n📊 RAPPORT DE MIGRATION FINAL:');
        console.log(`   📋 Total squelettes analysés: ${this.stats.totalSkeletons}`);
        console.log(`   ✅ Déjà migrés: ${this.stats.alreadyMigrated}`);
        console.log(`   🔄 Migrations legacy: ${this.stats.legacyMigrated}`);
        console.log(`   ✨ Nouveaux initialisés: ${this.stats.newInitialized}`);
        console.log(`   ⏭️  Skippés (filtre): ${this.stats.skipped}`);
        console.log(`   ❌ Erreurs: ${this.stats.errors}`);
        
        const totalModified = this.stats.legacyMigrated + this.stats.newInitialized;
        console.log(`\n💫 Total de squelettes modifiés: ${totalModified}`);
        
        if (this.dryRun) {
            console.log('\n🔍 MODE DRY-RUN: Aucune modification réellement effectuée');
            console.log('   Relancez sans --dry-run pour appliquer les modifications');
        } else {
            console.log('\n💾 Modifications appliquées sur le disque');
        }
        
        // Estimation de la bande passante économisée
        const estimatedSavings = totalModified * 50000; // ~50KB par tâche avec état d'indexation
        console.log(`\n💰 Bande passante future économisée estimée: ~${Math.round(estimatedSavings / 1024 / 1024)}MB`);
        console.log('   (grâce aux mécanismes de skip et d\'idempotence)');
        
        if (this.stats.errors > 0) {
            console.warn(`\n⚠️  ${this.stats.errors} erreurs détectées. Vérifiez les logs ci-dessus.`);
        }
        
        console.log('\n🎉 Migration terminée avec succès !');
    }
}

// Interface CLI
async function main() {
    const args = process.argv.slice(2);
    let dryRun = false;
    let workspaceFilter = null;
    
    // Parsing des arguments
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--dry-run':
                dryRun = true;
                break;
            case '--workspace':
                workspaceFilter = args[i + 1];
                i++; // Skip next arg
                break;
            case '--help':
                printHelp();
                process.exit(0);
                break;
        }
    }
    
    try {
        const migration = new IndexingStateMigration(dryRun, workspaceFilter);
        await migration.run();
        process.exit(0);
    } catch (error) {
        console.error('💥 Migration échouée:', error);
        process.exit(1);
    }
}

function printHelp() {
    console.log('Usage: node scripts/migrate-indexing-state.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run           Simulation sans modifications réelles');
    console.log('  --workspace PATH    Filtrer par workspace spécifique');
    console.log('  --help              Afficher cette aide');
    console.log('');
    console.log('Exemples:');
    console.log('  node scripts/migrate-indexing-state.js --dry-run');
    console.log('  node scripts/migrate-indexing-state.js --workspace "d:/dev/mon-projet"');
    console.log('  node scripts/migrate-indexing-state.js');
}

// Lancer le script si appelé directement
if (process.argv[1].endsWith('migrate-indexing-state.js')) {
    main();
}

export { IndexingStateMigration };