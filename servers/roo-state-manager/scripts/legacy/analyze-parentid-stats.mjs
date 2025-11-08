#!/usr/bin/env node
/**
 * Phase 2c : Génération des statistiques détaillées de reconstitution parentID
 * Analyse la proportion de tâches avec hiérarchie identifiée vs tâches orphelines
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Analyseur des statistiques de reconstitution parentID par workspace
 */
class ParentIDStatsAnalyzer {
  constructor() {
    this.workspaceStats = new Map();
    this.rootTaskPatterns = [
      /j'aimerais/i,
      /je voudrais/i,
      /peux-tu/i,
      /pourrais-tu/i,
      /j'ai besoin/i,
      /il faut/i,
      /créer/i,
      /générer/i,
      /faire/i,
      /ajouter/i
    ];
    this.cacheLocation = path.join(__dirname, '../.roo-state-manager');
  }

  /**
   * Charge le cache skeleton pour analyse
   */
  async loadSkeletonCache() {
    const cachePath = path.join(this.cacheLocation, 'skeleton-cache.json');
    
    try {
      const cacheContent = await fs.readFile(cachePath, 'utf8');
      const cache = JSON.parse(cacheContent);
      
      console.log(`📋 Cache skeleton chargé: ${Object.keys(cache).length} tâches`);
      return cache;
    } catch (error) {
      console.error('❌ Erreur chargement cache:', error.message);
      console.log(`   Chemin testé: ${cachePath}`);
      
      // Essayer chemin alternatif dans le répertoire build
      const altCachePath = path.join(__dirname, '../build/.roo-state-manager/skeleton-cache.json');
      try {
        const cacheContent = await fs.readFile(altCachePath, 'utf8');
        const cache = JSON.parse(cacheContent);
        console.log(`📋 Cache skeleton chargé (chemin alternatif): ${Object.keys(cache).length} tâches`);
        return cache;
      } catch (altError) {
        console.error('❌ Cache skeleton non trouvé dans les emplacements standards');
        console.log(`   Emplacements testés:`);
        console.log(`   - ${cachePath}`);
        console.log(`   - ${altCachePath}`);
        return {};
      }
    }
  }

  /**
   * Analyse un skeleton pour identifier les patterns de tâche racine
   */
  analyzeRootTaskPatterns(skeleton) {
    if (!skeleton.instruction) return { isLikelyRoot: false, patterns: [] };
    
    const instruction = skeleton.instruction.toLowerCase();
    const matchedPatterns = [];
    
    for (const pattern of this.rootTaskPatterns) {
      if (pattern.test(instruction)) {
        matchedPatterns.push(pattern.source);
      }
    }
    
    // Autres critères de tâche racine
    const isShortInstruction = instruction.length < 200;
    const hasUserTone = /^(bonjour|salut|hello|hi|hey)/i.test(instruction);
    const hasPoliteRequest = /(s'il vous plaît|stp|please)/i.test(instruction);
    const hasQuestionMark = instruction.includes('?');
    const startsWithVerb = /^(créer|générer|faire|ajouter|modifier|corriger|analyser)/i.test(instruction);
    
    const isLikelyRoot = matchedPatterns.length > 0 || 
                        (isShortInstruction && hasUserTone) ||
                        hasPoliteRequest ||
                        (isShortInstruction && hasQuestionMark) ||
                        startsWithVerb;
    
    return {
      isLikelyRoot,
      patterns: matchedPatterns,
      criteria: {
        hasUserPatterns: matchedPatterns.length > 0,
        isShortInstruction,
        hasUserTone,
        hasPoliteRequest,
        hasQuestionMark,
        startsWithVerb
      }
    };
  }

  /**
   * Génère les statistiques par workspace
   */
  analyzeByWorkspace(skeletonCache) {
    const workspaceStats = new Map();
    
    for (const [taskId, skeleton] of Object.entries(skeletonCache)) {
      if (!skeleton.workspace) continue;
      
      const workspace = skeleton.workspace;
      
      if (!workspaceStats.has(workspace)) {
        workspaceStats.set(workspace, {
          totalTasks: 0,
          tasksWithChildren: 0,
          tasksWithoutChildren: 0,
          avgChildTasks: 0,
          maxChildTasks: 0,
          likelyRootTasks: 0,
          orphanTasks: 0,
          patterns: new Map(),
          examples: {
            withChildren: [],
            likelyRoots: [],
            orphans: []
          },
          childTasksDistribution: new Map()
        });
      }
      
      const stats = workspaceStats.get(workspace);
      stats.totalTasks++;
      
      // Analyser enfants
      const childCount = skeleton.childTaskInstructionPrefixes?.length || 0;
      if (childCount > 0) {
        stats.tasksWithChildren++;
        stats.maxChildTasks = Math.max(stats.maxChildTasks, childCount);
        
        // Distribution des nombres d'enfants
        const currentDistrib = stats.childTasksDistribution.get(childCount) || 0;
        stats.childTasksDistribution.set(childCount, currentDistrib + 1);
        
        // Exemple de tâche avec enfants
        if (stats.examples.withChildren.length < 3) {
          stats.examples.withChildren.push({
            taskId: taskId.substring(0, 8),
            instruction: skeleton.instruction?.substring(0, 100) || 'N/A',
            childCount,
            workspace: skeleton.workspace
          });
        }
      } else {
        stats.tasksWithoutChildren++;
      }
      
      // Analyser patterns de tâche racine
      const rootAnalysis = this.analyzeRootTaskPatterns(skeleton);
      if (rootAnalysis.isLikelyRoot) {
        stats.likelyRootTasks++;
        
        // Comptabiliser patterns
        for (const pattern of rootAnalysis.patterns) {
          stats.patterns.set(pattern, (stats.patterns.get(pattern) || 0) + 1);
        }
        
        // Exemple de tâche racine probable
        if (stats.examples.likelyRoots.length < 3) {
          stats.examples.likelyRoots.push({
            taskId: taskId.substring(0, 8),
            instruction: skeleton.instruction?.substring(0, 100) || 'N/A',
            patterns: rootAnalysis.patterns,
            criteria: rootAnalysis.criteria
          });
        }
      } else if (childCount === 0) {
        stats.orphanTasks++;
        
        // Exemple de tâche orpheline
        if (stats.examples.orphans.length < 3) {
          stats.examples.orphans.push({
            taskId: taskId.substring(0, 8),
            instruction: skeleton.instruction?.substring(0, 100) || 'N/A',
            workspace: skeleton.workspace
          });
        }
      }
    }
    
    // Calculer moyennes
    for (const [workspace, stats] of workspaceStats.entries()) {
      if (stats.tasksWithChildren > 0) {
        // Calculer moyenne pondérée
        let totalChildren = 0;
        for (const [count, freq] of stats.childTasksDistribution.entries()) {
          totalChildren += count * freq;
        }
        stats.avgChildTasks = (totalChildren / stats.tasksWithChildren).toFixed(2);
      } else {
        stats.avgChildTasks = 0;
      }
    }
    
    return workspaceStats;
  }

  /**
   * Génère le rapport détaillé
   */
  generateReport(workspaceStats) {
    const report = [];
    
    report.push('# 📊 RAPPORT STATISTIQUES PARENTID - Phase 2c');
    report.push(`Generated: ${new Date().toISOString()}`);
    report.push('');
    
    // Vue d'ensemble
    const totalTasks = Array.from(workspaceStats.values())
      .reduce((sum, stats) => sum + stats.totalTasks, 0);
    const totalWithChildren = Array.from(workspaceStats.values())
      .reduce((sum, stats) => sum + stats.tasksWithChildren, 0);
    const totalRoots = Array.from(workspaceStats.values())
      .reduce((sum, stats) => sum + stats.likelyRootTasks, 0);
    const totalOrphans = Array.from(workspaceStats.values())
      .reduce((sum, stats) => sum + stats.orphanTasks, 0);
    
    report.push('## 🎯 VUE D\'ENSEMBLE');
    report.push(`- **Total tâches analysées** : ${totalTasks}`);
    report.push(`- **Tâches avec enfants** : ${totalWithChildren} (${((totalWithChildren/totalTasks)*100).toFixed(1)}%)`);
    report.push(`- **Tâches racines probables** : ${totalRoots} (${((totalRoots/totalTasks)*100).toFixed(1)}%)`);
    report.push(`- **Tâches orphelines** : ${totalOrphans} (${((totalOrphans/totalTasks)*100).toFixed(1)}%)`);
    report.push('');
    
    // Évaluation globale
    const globalHierarchyRate = (totalWithChildren / totalTasks) * 100;
    if (globalHierarchyRate >= 70) {
      report.push('🎯 **ÉVALUATION GLOBALE : EXCELLENT** - Système prêt pour production');
    } else if (globalHierarchyRate >= 50) {
      report.push('✅ **ÉVALUATION GLOBALE : BON** - Performance satisfaisante');
    } else if (globalHierarchyRate >= 30) {
      report.push('⚠️ **ÉVALUATION GLOBALE : MOYEN** - Amélioration recommandée');
    } else {
      report.push('❌ **ÉVALUATION GLOBALE : FAIBLE** - Investigation requise');
    }
    report.push('');
    
    // Détail par workspace
    report.push('## 📁 DÉTAIL PAR WORKSPACE');
    
    const sortedWorkspaces = Array.from(workspaceStats.entries())
      .sort(([,a], [,b]) => b.totalTasks - a.totalTasks);
    
    for (const [workspace, stats] of sortedWorkspaces) {
      report.push(`### ${workspace}`);
      report.push('');
      
      const hierarchyRate = ((stats.tasksWithChildren / stats.totalTasks) * 100).toFixed(1);
      const rootRate = ((stats.likelyRootTasks / stats.totalTasks) * 100).toFixed(1);
      const orphanRate = ((stats.orphanTasks / stats.totalTasks) * 100).toFixed(1);
      
      report.push(`**Métriques** :`);
      report.push(`- Total tâches : ${stats.totalTasks}`);
      report.push(`- Avec enfants : ${stats.tasksWithChildren} (${hierarchyRate}%)`);
      report.push(`- Sans enfants : ${stats.tasksWithoutChildren}`);
      report.push(`- Racines probables : ${stats.likelyRootTasks} (${rootRate}%)`);
      report.push(`- Orphelines : ${stats.orphanTasks} (${orphanRate}%)`);
      report.push(`- Max enfants par tâche : ${stats.maxChildTasks}`);
      report.push(`- Moyenne enfants par tâche parent : ${stats.avgChildTasks}`);
      report.push('');
      
      // Distribution des enfants
      if (stats.childTasksDistribution.size > 0) {
        report.push(`**Distribution du nombre d'enfants** :`);
        const sortedDistrib = Array.from(stats.childTasksDistribution.entries())
          .sort(([a], [b]) => a - b);
        for (const [count, freq] of sortedDistrib) {
          report.push(`- ${count} enfant(s) : ${freq} tâches`);
        }
        report.push('');
      }
      
      // Patterns détectés
      if (stats.patterns.size > 0) {
        report.push(`**Patterns utilisateur détectés** :`);
        const sortedPatterns = Array.from(stats.patterns.entries())
          .sort(([,a], [,b]) => b - a);
        for (const [pattern, count] of sortedPatterns) {
          report.push(`- ${pattern} : ${count} occurrences`);
        }
        report.push('');
      }
      
      // Exemples
      if (stats.examples.withChildren.length > 0) {
        report.push(`**Exemples tâches avec enfants** :`);
        for (const example of stats.examples.withChildren) {
          report.push(`- ${example.taskId}: "${example.instruction}..." (${example.childCount} enfants)`);
        }
        report.push('');
      }
      
      if (stats.examples.likelyRoots.length > 0) {
        report.push(`**Exemples tâches racines probables** :`);
        for (const example of stats.examples.likelyRoots) {
          const patterns = example.patterns.length > 0 ? ` [${example.patterns.join(', ')}]` : '';
          const criteriaCount = Object.values(example.criteria).filter(v => v).length;
          report.push(`- ${example.taskId}: "${example.instruction}..."${patterns} (${criteriaCount} critères)`);
        }
        report.push('');
      }
      
      if (stats.examples.orphans.length > 0) {
        report.push(`**Exemples tâches orphelines** :`);
        for (const example of stats.examples.orphans) {
          report.push(`- ${example.taskId}: "${example.instruction}..."`);
        }
        report.push('');
      }
      
      // Évaluation par workspace
      if (hierarchyRate >= 70) {
        report.push(`🎯 **EXCELLENT** : ${hierarchyRate}% de tâches avec hiérarchie - Prêt production`);
      } else if (hierarchyRate >= 50) {
        report.push(`✅ **BON** : ${hierarchyRate}% de tâches avec hiérarchie - Performance satisfaisante`);
      } else if (hierarchyRate >= 30) {
        report.push(`⚠️ **MOYEN** : ${hierarchyRate}% de tâches avec hiérarchie - Amélioration recommandée`);
      } else {
        report.push(`❌ **FAIBLE** : ${hierarchyRate}% de tâches avec hiérarchie - Investigation requise`);
      }
      
      report.push('---');
      report.push('');
    }
    
    // Recommandations
    report.push('## 🎯 RECOMMANDATIONS');
    report.push('');
    
    if (globalHierarchyRate >= 70) {
      report.push('✅ **SYSTÈME VALIDÉ** : Taux de hiérarchisation excellente');
      report.push('- **Action** : Prêt pour activation production');
      report.push('- **Suivi** : Monitoring des métriques recommandé');
      report.push('- **Phase suivante** : Déploiement en production avec surveillance');
    } else if (globalHierarchyRate >= 50) {
      report.push('⚠️ **AMÉLIORATION POSSIBLE** : Taux correct mais optimisable');
      report.push('- **Action** : Analyser workspaces à faible taux de hiérarchisation');
      report.push('- **Focus** : Améliorer détection patterns utilisateur');
      report.push('- **Test** : Validation sur échantillon plus large');
    } else {
      report.push('❌ **INVESTIGATION REQUISE** : Taux de hiérarchisation faible');
      report.push('- **Action critique** : Revoir algorithmes de matching parentID');
      report.push('- **Analyse** : Examiner formats de messages non supportés');
      report.push('- **Debug** : Valider fonctionnement RadixTree et seuils');
    }
    
    report.push('');
    report.push('## 📈 MÉTRIQUES DE VALIDATION PHASE 2C');
    report.push('');
    report.push(`- **Objectif ≥70% hiérarchie** : ${globalHierarchyRate >= 70 ? '✅ ATTEINT' : '❌ NON ATTEINT'} (${globalHierarchyRate.toFixed(1)}%)`);
    report.push(`- **Objectif patterns détectés** : ${totalRoots > 0 ? '✅ ATTEINT' : '❌ NON ATTEINT'} (${totalRoots} patterns)`);
    report.push(`- **Objectif <20% orphelines** : ${((totalOrphans/totalTasks)*100) < 20 ? '✅ ATTEINT' : '❌ NON ATTEINT'} (${((totalOrphans/totalTasks)*100).toFixed(1)}%)`);
    report.push(`- **Identification racines vs enfants** : ${totalRoots > totalOrphans ? '✅ COHÉRENT' : '⚠️ À VÉRIFIER'}`);
    
    return report.join('\n');
  }

  async run() {
    console.log('🔍 Phase 2c : Analyse des statistiques parentID...\n');
    
    const skeletonCache = await this.loadSkeletonCache();
    if (Object.keys(skeletonCache).length === 0) {
      console.log('❌ Cache skeleton vide ou inaccessible');
      console.log('💡 Suggestion: Exécuter d\'abord le script generate-skeleton-cache.mjs');
      return;
    }
    
    console.log('📊 Analyse des workspaces et hiérarchies...');
    const workspaceStats = this.analyzeByWorkspace(skeletonCache);
    
    console.log('📝 Génération du rapport...');
    const report = this.generateReport(workspaceStats);
    
    // Sauvegarder rapport
    const reportPath = path.join(__dirname, '../docs/RAPPORT-STATS-PARENTID-PHASE2C.md');
    await fs.writeFile(reportPath, report, 'utf8');
    
    console.log('\n📊 Rapport généré:', reportPath);
    console.log('\n' + '='.repeat(80));
    console.log(report);
    console.log('='.repeat(80));
    
    // Résumé final
    const totalTasks = Array.from(workspaceStats.values())
      .reduce((sum, stats) => sum + stats.totalTasks, 0);
    const totalWithChildren = Array.from(workspaceStats.values())
      .reduce((sum, stats) => sum + stats.tasksWithChildren, 0);
    const hierarchyRate = ((totalWithChildren / totalTasks) * 100).toFixed(1);
    
    console.log('\n🎯 RÉSUMÉ PHASE 2C:');
    console.log(`   - ${totalTasks} tâches analysées`);
    console.log(`   - ${hierarchyRate}% avec hiérarchie identifiée`);
    console.log(`   - ${workspaceStats.size} workspaces traités`);
    console.log(`   - Validation: ${hierarchyRate >= 70 ? '✅ SUCCÈS' : '❌ À AMÉLIORER'}`);
  }
}

// Exécution
const analyzer = new ParentIDStatsAnalyzer();
analyzer.run().catch(console.error);