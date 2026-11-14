# 🔧 Mécanisme d'auto-rafraîchissement des squelettes

## 📋 Vue d'ensemble

Ce document décrit comment le cache de squelettes de conversations du MCP `roo-state-manager`
reste frais sans intervention manuelle.

Depuis #1244, le mécanisme n'est plus porté par un appel synchrone dans chaque handler : la
fraîcheur est garantie par un **worker périodique (Worker A)**, et le chemin d'appel des outils ne
porte plus qu'un **filet de sécurité rapide et non bloquant**.

> **v2.0.0 (2026-11-14)** — Le document décrivait le mécanisme d'origine (v1.x, octobre 2025) :
> handlers monolithiques dans `src/index.ts`, vérification synchrone à chaque appel, cache de
> validité de 5 minutes. Le code a été ré-architecturé depuis ; les ancres ont été reprises sur
> les symboles actuels (#4687).

## 🎯 Problème résolu

**Avant** : les squelettes devaient être construits manuellement via l'outil `build_skeleton_cache`,
d'où une visibilité conditionnelle dans les outils et des interventions manuelles.

**Après** : le cache se rafraîchit en tâche de fond ; les outils lisent un cache déjà chaud et ne
bloquent jamais dessus.

`build_skeleton_cache` **n'est plus exposé** comme outil MCP (`src/tools/registry.ts:201`, retiré en
#625). Le handler reste disponible en interne : c'est lui que le worker et le filet de sécurité
appellent.

## 🏗️ Architecture

Le mécanisme est à deux couches.

### Couche 1 — Worker A, garant de la fraîcheur

| Élément | Ancre |
|---|---|
| Worker de rafraîchissement | [`startSkeletonRefreshWorker()`](../src/services/background-services.ts:643) |
| Intervalle (2 min) | [`SKELETON_REFRESH_INTERVAL_MS`](../src/services/background-services.ts:610) |
| Démarrage au boot | [`initializeBackgroundServices()`](../src/services/background-services.ts:925) |
| Appel du démarrage | [`src/index.ts:362-364`](../src/index.ts:362-364) |

Le worker repart d'un **checkpoint** — `state.lastSkeletonRefreshAt`
([`state-manager.service.ts:31`](../src/services/state-manager.service.ts:31)) — et ne relit que les
fichiers dont le `mtime` est postérieur au dernier tick (scan **incrémental**). Le checkpoint est
persisté entre deux démarrages par [`persistIndexerCursor()`](../src/services/background-services.ts:348)
et relu par [`loadPersistedIndexerCursors()`](../src/services/background-services.ts:381) — sans quoi
un redémarrage relirait tout le disque.

`ROO_INDEX_FORCE=1` contourne le filtre incrémental et force un scan complet (découverte de fichiers
anciens, par exemple des sessions Claude Code jamais vues).

### Couche 2 — `ensureSkeletonCacheIsFresh()`, filet de sécurité non bloquant

Méthode privée du serveur : [`src/index.ts:824-870`](../src/index.ts:824-870).

```typescript
private async ensureSkeletonCacheIsFresh(args?: { workspace?: string }): Promise<boolean>
```

Comportement réel :

1. **Throttle** — au plus une vérification par minute
   ([`CACHE_CHECK_THROTTLE_MS`](../src/index.ts:216)) ; en deçà, retour immédiat `false`.
2. **État non initialisé** → retour immédiat : c'est l'enveloppe `CallTool` qui a déjà attendu
   `ensureInitialized()`.
3. **Cache non vide** → retour immédiat (cas nominal, < 5 ms) : Worker A fait le travail.
4. **Cache vide** (premier run, index absent, chargement de fond inachevé) → planifie un
   remplissage en tâche de fond via `setImmediate`, **jamais attendu**.

> ⚠️ **Les outils ne doivent pas compter sur cette méthode pour obtenir de la fraîcheur.** Elle ne
> reconstruit rien sur le chemin d'appel ; elle évite seulement qu'un cache vide le reste.

#### Stratégie de reconstruction

Le remplissage de fond et le worker appellent tous deux
[`handleBuildSkeletonCache()`](../src/tools/cache/build-skeleton-cache.tool.ts:190) avec :

- `force_rebuild: false` → construction conditionnelle (rapide)
- `workspace_filter` → filtrage optionnel, quand l'appelant en fournit un

## 🔌 Intégration dans les handlers

### Injection du callback

Les handlers ne sont plus des méthodes du serveur : ils vivent dans `src/tools/**` et reçoivent le
callback en paramètre.

| Élément | Ancre |
|---|---|
| Liaison au démarrage | [`src/index.ts:721`](../src/index.ts:721) |
| Paramètre du dispatcher | [`registry.ts:125`](../src/tools/registry.ts:125) |

Le dispatcher `registerCallToolHandler()` injecte ensuite ce callback, outil par outil
([`registry.ts:209`](../src/tools/registry.ts:209), [`363`](../src/tools/registry.ts:363),
[`383`](../src/tools/registry.ts:383), [`402`](../src/tools/registry.ts:402),
[`469`](../src/tools/registry.ts:469), [`520`](../src/tools/registry.ts:520)).

### Consommateurs actuels

| Outil MCP | Handler | Site d'appel |
|---|---|---|
| `conversation_browser` — `tree` | [`handleGetTaskTree()`](../src/tools/task/get-tree.tool.ts:87) | [`get-tree.tool.ts:103`](../src/tools/task/get-tree.tool.ts:103) |
| `conversation_browser` — `current` | [`getCurrentTaskTool`](../src/tools/task/get-current-task.tool.ts:87) | [`get-current-task.tool.ts:114-121`](../src/tools/task/get-current-task.tool.ts:114-121) (callback **optionnel**) |
| `roosync_search` — `semantic` / `text` | [`handleRooSyncSearch()`](../src/tools/search/roosync-search.tool.ts:167) | [`269`](../src/tools/search/roosync-search.tool.ts:269), [`376`](../src/tools/search/roosync-search.tool.ts:376) — **avec** filtre workspace |
| `roosync_indexing` | [`handleRooSyncIndexing()`](../src/tools/indexing/roosync-indexing.tool.ts:882) | via le callback injecté (registre, `469`/`520`) |
| `index_task_semantic` | [`indexTaskSemanticTool`](../src/tools/indexing/index-task.tool.ts:41) | via le callback injecté |
| `export_data` | [`handleExportData()`](../src/tools/export/export-data.ts:783) | [`export-tasks-xml.ts:67`](../src/tools/export/export-tasks-xml.ts:67), [`export-conversation-xml.ts:73`](../src/tools/export/export-conversation-xml.ts:73), [`export-project-xml.ts:73`](../src/tools/export/export-project-xml.ts:73), [`export-tree-md.tool.ts:117`](../src/tools/task/export-tree-md.tool.ts:117) |
| `task_export` | [`handleTaskExport()`](../src/tools/task/export.ts:158) | [`export.ts:183`](../src/tools/task/export.ts:183) |

Seul `export_project_xml` (via `export_data`) passe un **filtre workspace** — cf.
[`export-project-xml.ts:73`](../src/tools/export/export-project-xml.ts:73).

### Ce qui n'appelle plus le callback

- **`conversation_browser` — `list`** : `listConversationsTool.handler()` est appelé sans callback
  ([`conversation-browser.ts:500`](../src/tools/conversation/conversation-browser.ts:500)) ; la
  liste lit le cache tel que Worker A l'a laissé.
- **`view_task_details`** : dispatché sans callback
  ([`registry.ts:373-375`](../src/tools/registry.ts:373-375)).
- **`generate_trace_summary`, `generate_cluster_summary`, `get_conversation_synthesis`** : **retirés
  de la surface MCP** (CLEANUP-2, [`registry.ts:533`](../src/tools/registry.ts:533)). Leurs fichiers
  subsistent comme bibliothèques, mais aucun dispatch ne les atteint. Les versions v1.x de ce
  document les citaient comme intégrés : ce n'est plus vrai.

### Pattern d'intégration

```typescript
export async function handleExampleTool(
    args: ExampleArgs,
    conversationCache: Map<string, StoredConversation>,
    ensureSkeletonCacheIsFresh: () => Promise<void>
): Promise<CallToolResult> {
    try {
        // FAILSAFE: rafraîchissement best-effort avant lecture du cache
        await ensureSkeletonCacheIsFresh();

        const skeleton = conversationCache.get(args.taskId);
        // ...
    }
}
```

Variante avec filtre workspace :

```typescript
export async function handleExportProjectXml(
    args: { projectPath: string },
    conversationCache: Map<string, StoredConversation>,
    ensureSkeletonCacheIsFresh: (options?: { workspace?: string }) => Promise<void>
): Promise<CallToolResult> {
    await ensureSkeletonCacheIsFresh({ workspace: args.projectPath });
    // ...
}
```

## ⚡ Optimisations de performance

### 1. Construction conditionnelle (`force_rebuild: false`)
- Ne reconstruit que les squelettes obsolètes ou manquants.

### 2. Filtrage par workspace
- Limite le périmètre du scan ; critique pour `export_project_xml`, qui ne traite qu'un workspace.

### 3. Throttle de la vérification (1 minute)
- [`CACHE_CHECK_THROTTLE_MS`](../src/index.ts:216) — évite de brûler des cycles sur des appels
  répétés. Ce n'est **pas** un cache de validité de 5 minutes : la fraîcheur vient du worker.

### 4. Scan incrémental par `mtime`
- Le worker ne relit que les fichiers postérieurs à `lastSkeletonRefreshAt`, au lieu de rescanner
  tout le système de fichiers à chaque tick.

## 🧪 Tests de validation

- Construction du cache et comportement conditionnel :
  [`build-skeleton-cache.test.ts`](../src/tools/cache/__tests__/build-skeleton-cache.test.ts)
- Arbre de tâches (chemin `tree`) : [`get-tree.test.ts`](../src/tools/task/__tests__/get-tree.test.ts)

Les scénarios à couvrir lors d'une modification :

1. **Cache vide** → remplissage de fond planifié, retour immédiat.
2. **Cache à jour** → aucun travail, retour < 5 ms.
3. **Throttle** → deux appels dans la même minute ne déclenchent qu'une vérification.
4. **Filtre workspace** → le périmètre de reconstruction est limité au workspace demandé.

## 📊 Impact

- ✅ Les outils restent fonctionnels sans intervention manuelle.
- ✅ Le chemin d'appel ne bloque plus sur une reconstruction.
- ⚠️ Les chiffres de la v1.x (« < 100 ms », « < 2 s ») ont été mesurés sur l'architecture
  précédente ; ils n'ont **pas** été re-mesurés depuis #1244 et ne doivent pas être cités comme
  mesures courantes.

## 🛡️ Robustesse

### Gestion d'erreurs

```typescript
} catch (error) {
    logger.error('[FAILSAFE] Error in fast freshness check:', { error });
    return false; // N'empêche pas l'exécution du handler
}
```

### Fallback gracieux
- En cas d'erreur, retourne `false` sans bloquer.
- Le handler continue avec le cache existant.
- Les échecs de remplissage de fond sont journalisés en `warn`, sans propagation.

## 🔄 Flux d'exécution typique

```
Démarrage du serveur
    ↓
initializeBackgroundServices() → Worker A (toutes les 2 min)
    ↓
scan incrémental (mtime > lastSkeletonRefreshAt) → mise à jour du cache


Appel outil (ex: conversation_browser action=tree)
    ↓
handleGetTaskTree()
    ↓
ensureSkeletonCacheIsFresh()   ← throttlé, non bloquant
    ↓
cache non vide ? → OUI → retour immédiat
    ↓
    NON → setImmediate(handleBuildSkeletonCache(force: false))  (jamais attendu)
    ↓
lecture du conversationCache
    ↓
Résultat retourné à l'utilisateur
```

## 📝 Notes de maintenance

### Ajouter l'auto-rafraîchissement à un nouvel outil

1. Ajouter le paramètre au handler :
   ```typescript
   ensureSkeletonCacheIsFresh: () => Promise<void>
   ```
2. L'appeler au début de la méthode :
   ```typescript
   await ensureSkeletonCacheIsFresh();
   ```
3. Si le handler filtre par workspace, transmettre l'option :
   ```typescript
   await ensureSkeletonCacheIsFresh({ workspace: args.workspace });
   ```
4. Câbler l'injection dans le case du dispatcher :
   ```typescript
   case 'new_tool': {
       const m = await import('./chemin/du/module.js');
       result = await m.handleNewTool(args as any, cache, ensureSkeletonCacheIsFresh);
       break;
   }
   ```

### Monitoring

Logs à surveiller :
- `[FAILSAFE] Cache empty — scheduling background populate (non-blocking)` : cache vide détecté
- `[FAILSAFE] Background populate complete` : remplissage terminé
- `[FAILSAFE] Background populate failed (non-blocking)` : échec, sans impact sur l'appel
- `[FAILSAFE] Error in fast freshness check` : erreur dans le filet de sécurité
- `🔄 Worker A (skeleton refresh) started — interval: 120s` : worker démarré

## 🆕 Scan disque complémentaire (`get_current_task`)

### Contexte

Le rafraîchissement périodique a une latence de détection (jusqu'à 2 minutes). Pour
`get_current_task`, cette latence est inacceptable : l'outil doit retourner **immédiatement** la
tâche en cours.

### Solution

Un module complémentaire, [`disk-scanner.ts`](../src/tools/task/disk-scanner.ts), fournit :

- [`scanDiskForNewTasks()`](../src/tools/task/disk-scanner.ts:122) — détecte les conversations
  orphelines absentes du cache et crée des squelettes légers ;
- [`invalidateDiskScanCache()`](../src/tools/task/disk-scanner.ts:108) — invalide le cache de scan ;
- [`evictGoneLocalTasks()`](../src/tools/task/disk-scanner.ts:249) — purge les tâches locales
  disparues du disque.

### Complémentarité des mécanismes

| Mécanisme | Worker A | Scan disque |
|---|---|---|
| **Déclenchement** | Périodique (2 min) | À chaque appel de `get_current_task` |
| **Scope** | Toutes les conversations | Conversations orphelines |
| **Performance** | Incrémentale (`mtime`) | Vérification d'existence |
| **Complétude** | Métadonnées complètes | Métadonnées minimales |
| **Usage** | Cache global persistant | Enrichissement temporaire |

### Outils bénéficiaires

Seul `get_current_task` (via `conversation_browser` action `current`) utilise le scan disque : c'est
le seul outil exigeant une détection temps réel. Les autres tolèrent la latence du worker.

### Extension future possible

- `conversation_browser` action `list` avec filtre de récence
- `roosync_search` action `semantic` pour inclure les tâches très récentes

## 🔗 Références

- Serveur : [`src/index.ts`](../src/index.ts)
- Filet de sécurité : [`ensureSkeletonCacheIsFresh()`](../src/index.ts:824-870)
- Worker de rafraîchissement : [`background-services.ts`](../src/services/background-services.ts)
- Reconstruction : [`handleBuildSkeletonCache()`](../src/tools/cache/build-skeleton-cache.tool.ts:190)
- Dispatcher et injection : [`registry.ts`](../src/tools/registry.ts)
- Module scan disque : [`disk-scanner.ts`](../src/tools/task/disk-scanner.ts)
- Outil concerné : [`get-current-task.tool.ts`](../src/tools/task/get-current-task.tool.ts)
- Issue tracking : #1244 (ré-architecture), #4687 (réparation des ancres de ce document)

---

**Version** : 2.0.0
**Dernière mise à jour** : 2026-11-14
**Auteur** : Équipe roo-state-manager
**Changelog** :
- v2.0.0 (2026-11-14) : ré-architecture #1244 documentée (Worker A + filet de sécurité non bloquant) ;
  ancres reprises sur les symboles actuels (#4687) ; outils retirés de la surface MCP signalés
- v1.1.0 (2025-10-16) : ajout du scan disque complémentaire pour `get_current_task`
- v1.0.0 (2025-01-11) : version initiale du mécanisme auto-rebuild
