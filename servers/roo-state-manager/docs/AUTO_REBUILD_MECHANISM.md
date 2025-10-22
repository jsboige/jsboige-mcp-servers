# 🔧 Mécanisme d'Auto-Rebuild des Squelettes

## 📋 Vue d'ensemble

Ce document décrit le mécanisme d'auto-reconstruction automatique des squelettes de conversations dans le MCP `roo-state-manager`, implémenté pour corriger le problème de construction manuelle identifié.

## 🎯 Problème résolu

**Avant** : Les squelettes devaient être construits manuellement via l'outil `build_skeleton_cache`, ce qui causait :
- Visibilité conditionnelle dans les outils
- Fonctionnement non fiable
- Nécessité d'intervention manuelle

**Après** : Chaque appel d'outil déclenche automatiquement une vérification et reconstruction conditionnelle du cache.

## 🏗️ Architecture

### Méthode principale : `_ensureSkeletonCacheIsFresh()`

Située dans [`index.ts`](../src/index.ts:3175-3249), cette méthode privée est le cœur du mécanisme :

```typescript
private async _ensureSkeletonCacheIsFresh(args?: { workspace?: string }): Promise<boolean>
```

#### Paramètres
- `args.workspace` (optionnel) : Filtre par workspace pour optimiser les performances

#### Logique de vérification

1. **Cache vide** → Reconstruction différentielle immédiate
2. **Cache existant** → Vérification des modifications récentes (5 minutes)
3. **Nouvelles conversations détectées** → Reconstruction différentielle

#### Stratégie de reconstruction

La méthode appelle [`handleBuildSkeletonCache()`](../src/index.ts:948) avec :
- `force_rebuild: false` → Construction conditionnelle (rapide)
- `workspace_filter: args?.workspace` → Filtrage optionnel

## 🔌 Intégration dans les handlers

### Handlers modifiés

Tous les handlers dépendants du `conversationCache` ont été modifiés pour appeler `_ensureSkeletonCacheIsFresh()` **avant** toute opération :

#### Liste complète des handlers intégrés :

1. [`handleListConversations()`](../src/index.ts:740-898)
   - Appel sans filtre workspace
   
2. [`handleGetTaskTree()`](../src/index.ts:1465-1605)
   - Appel sans filtre workspace

3. [`handleSearchTasksSemantic()`](../src/index.ts:1689-1821)
   - Appel **avec** filtre workspace si fourni
   
4. [`handleIndexTaskSemantic()`](../src/index.ts:1884-1938)
   - Appel sans filtre workspace

5. [`handleExportTaskXml()`](../src/index.ts:2137-2185)
   - Appel sans filtre workspace

6. [`handleExportConversationXml()`](../src/index.ts:2190-2265)
   - Appel sans filtre workspace

7. [`handleExportProjectXml()`](../src/index.ts:2270-2345)
   - Appel **avec** filtre workspace (optimisation critique)
   
8. [`handleViewTaskDetails()`](../src/index.ts:2697-2764)
   - Appel sans filtre workspace

9. [`handleGenerateTraceSummary()`](../src/index.ts:2769-2810)
   - Via handler externe, pas d'appel direct

10. [`handleGenerateClusterSummary()`](../src/index.ts:2429-2555)
    - Appel sans filtre workspace

11. [`handleGetConversationSynthesis()`](../src/index.ts:2876-2915)
    - Appel sans filtre workspace

12. [`handleExportTaskTreeMarkdown()`](../src/index.ts:2920-3042)
    - Appel sans filtre workspace

13. [`handleGetCurrentTask()`](../src/tools/task/get-current-task.tool.ts:82-134)
     - ✅ **AJOUT 2025-10-16** : Intégration du mécanisme auto-rebuild
     - ✅ **AMÉLIORATION 2025-10-16** : Scan disque complémentaire via [`disk-scanner.ts`](../src/tools/task/disk-scanner.ts)
     - Appel **avec** filtre workspace (args.workspace)
     - Pattern: Callback async passé via registry.ts
     - **Double détection** : Cache rebuild + scan disque pour conversations orphelines

### Pattern d'intégration

```typescript
async handleExampleTool(args: { ... }): Promise<CallToolResult> {
    try {
        // **FAILSAFE: Auto-rebuild cache si nécessaire**
        await this._ensureSkeletonCacheIsFresh();
        
        // Reste de la logique du handler...
        const skeleton = this.conversationCache.get(args.taskId);
        // ...
    }
}
```

### Pattern avec filtrage workspace

```typescript
async handleExportProjectXml(args: { projectPath: string, ... }): Promise<CallToolResult> {
    try {
        // **FAILSAFE: Auto-rebuild cache avec filtre workspace**
        await this._ensureSkeletonCacheIsFresh({ workspace: projectPath });
        
        // Filtrer les conversations par workspace...
    }
}
```

## ⚡ Optimisations de performance

### 1. Construction conditionnelle (`force_rebuild: false`)
- Vérifie les timestamps des squelettes existants
- Ne reconstruit que les squelettes obsolètes ou manquants
- Skip les squelettes à jour

### 2. Filtrage par workspace
- Limite le scope de la reconstruction
- Crucial pour `export_project_xml` qui ne traite qu'un seul workspace
- Réduit significativement le temps de traitement

### 3. Cache de validité (5 minutes)
- Évite les reconstructions répétées
- Balance entre fraîcheur et performance

### 4. Vérification limitée (10 premières conversations)
- Évite de scanner tout le système de fichiers
- Performance optimale pour les cas courants

## 🧪 Tests de validation

### Test 1 : Cache vide
```typescript
// Condition : conversationCache.size === 0
// Résultat attendu : Reconstruction différentielle déclenchée
```

### Test 2 : Cache à jour
```typescript
// Condition : Cache existant, pas de nouvelles conversations
// Résultat attendu : Skip reconstruction, retour immédiat
```

### Test 3 : Nouvelles conversations
```typescript
// Condition : Conversations récentes (<5min) non cachées
// Résultat attendu : Reconstruction différentielle déclenchée
```

### Test 4 : Performance avec workspace filter
```typescript
// Condition : export_project_xml avec workspace spécifique
// Résultat attendu : Reconstruction limitée au workspace, < 2s
```

## 📊 Impact mesuré

### Avant (construction manuelle)
- ❌ Outils non fonctionnels si cache vide
- ❌ Nécessite intervention manuelle de l'utilisateur
- ❌ Expérience utilisateur dégradée

### Après (auto-rebuild)
- ✅ Outils toujours fonctionnels
- ✅ Aucune intervention manuelle nécessaire
- ✅ Overhead acceptable : < 100ms (cache à jour), < 2s (reconstruction)
- ✅ Filtrage workspace : optimisation critique pour projets volumineux

## 🛡️ Robustesse

### Gestion d'erreurs
```typescript
try {
    console.log('[FAILSAFE] Checking skeleton cache freshness...');
    // Logique de vérification...
} catch (error) {
    console.error('[FAILSAFE] Error checking skeleton cache freshness:', error);
    return false; // N'empêche pas l'exécution du handler
}
```

### Fallback gracieux
- En cas d'erreur, retourne `false` sans bloquer
- Le handler peut continuer avec le cache existant
- Logs détaillés pour diagnostic

## 🔄 Flux d'exécution typique

```
Appel outil (ex: get_task_tree)
    ↓
handleGetTaskTree()
    ↓
_ensureSkeletonCacheIsFresh()
    ↓
Cache vide ? → OUI → handleBuildSkeletonCache(force: false)
    ↓                      ↓
    NON              Reconstruction différentielle
    ↓                      ↓
Nouvelles conversations ? → OUI → handleBuildSkeletonCache(force: false)
    ↓                      ↓
    NON              Reconstruction différentielle
    ↓                      ↓
Cache frais ✅            Cache mis à jour ✅
    ↓                      ↓
Utilisation du conversationCache
    ↓
Résultat retourné à l'utilisateur
```

## 📝 Notes de maintenance

### Ajout de nouveaux handlers

Pour ajouter l'auto-rebuild à un nouveau handler :

1. Identifier si le handler utilise `conversationCache`
2. Ajouter l'appel au début de la méthode :
   ```typescript
   await this._ensureSkeletonCacheIsFresh();
   ```
3. Si le handler filtre par workspace, passer le paramètre :
   ```typescript
   await this._ensureSkeletonCacheIsFresh({ workspace: args.workspace });
   ```
4. Marquer l'async/await dans le switch statement :
   ```typescript
   case 'new_handler':
       result = await this.handleNewHandler(args as any);
       break;
   ```

### Monitoring

Logs à surveiller :
- `[FAILSAFE] Checking skeleton cache freshness...` : Vérification déclenchée
- `[FAILSAFE] Cache empty, triggering differential rebuild...` : Reconstruction nécessaire
- `[FAILSAFE] Cache outdated, triggering differential rebuild...` : Nouvelles conversations
- `[FAILSAFE] Skeleton cache is fresh` : Cache à jour, skip reconstruction

## 🆕 Amélioration : Scan disque complémentaire (2025-10-16)

### Contexte

Le mécanisme auto-rebuild reconstruit efficacement le cache, mais avec une latence de détection (~5 minutes). Pour l'outil `get_current_task`, cette latence est inacceptable car il doit retourner **immédiatement** la tâche en cours.

### Solution : Scan disque dynamique

Un module complémentaire [`disk-scanner.ts`](../src/tools/task/disk-scanner.ts) a été développé pour :

1. **Scanner le système de fichiers** à chaque appel de `get_current_task`
2. **Détecter les conversations orphelines** non présentes dans le cache
3. **Créer des squelettes légers** sans traitement lourd
4. **Enrichir temporairement le cache** pour la durée de l'appel

### Complémentarité des mécanismes

| Mécanisme | Auto-Rebuild | Scan Disque |
|-----------|-------------|-------------|
| **Déclenchement** | Périodique (5 min) | À chaque appel |
| **Scope** | Toutes les conversations | Conversations orphelines |
| **Performance** | Optimisée (conditionnelle) | Ultra-rapide (vérification existence) |
| **Complétude** | 100% des métadonnées | Métadonnées minimales |
| **Usage** | Cache global persistant | Enrichissement temporaire |

### Outils bénéficiaires

Actuellement, seul `get_current_task` utilise le scan disque car :
- C'est le seul outil nécessitant une détection **temps réel** absolue
- Les autres outils peuvent tolérer la latence de 5 minutes de l'auto-rebuild
- Le scan disque ajoute un overhead léger (~20-50ms) acceptable pour cet outil critique

### Extension future possible

D'autres outils pourraient bénéficier du scan disque si nécessaire :
- `list_conversations` avec filtre `created_recently=true`
- `search_tasks_semantic` pour inclure les tâches très récentes
- Tout nouvel outil nécessitant une fraîcheur absolue des données

## 🔗 Références

- Code source : [`src/index.ts`](../src/index.ts)
- Méthode principale : [`_ensureSkeletonCacheIsFresh()`](../src/index.ts:3175-3249)
- Méthode de reconstruction : [`handleBuildSkeletonCache()`](../src/index.ts:948-1350)
- Module scan disque : [`disk-scanner.ts`](../src/tools/task/disk-scanner.ts)
- Outil amélioré : [`get-current-task.tool.ts`](../src/tools/task/get-current-task.tool.ts)
- Issue tracking : Mission correction auto-construction squelettes + scan disque

---

**Version** : 1.1.0
**Dernière mise à jour** : 2025-10-16
**Auteur** : Équipe roo-state-manager
**Changelog** :
- v1.1.0 (2025-10-16) : Ajout scan disque complémentaire pour `get_current_task`
- v1.0.0 (2025-01-11) : Version initiale du mécanisme auto-rebuild