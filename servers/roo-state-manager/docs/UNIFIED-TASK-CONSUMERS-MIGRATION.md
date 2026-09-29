# Migration des consommateurs vers UnifiedTask

**Issue :** #1394 (Phase 4 de #1360)
**Statut :** en cours — outil #1 (conversation_browser/list) migré, 5 restants
**Complément de :** `docs/MIGRATION-UNIFIED-TASK-EXTRACTION.md` (#1395, côté
déprécation). Ce document couvre le côté consommateurs : comment chaque outil
downstream passe au schéma unifié SANS casser l'existant.

---

## Le principe : header-level d'abord, sequence ensuite

`UnifiedTask` (v1.1, `src/types/unified-task.ts`) est un schéma de **niveau
header** : identification, temporalité, métriques, contexte (workspace,
machine, mode), statut. Il ne modélise **pas** la `sequence` de messages/actions
de `ConversationSkeleton`.

Conséquence pratique pour la migration :

- Les étapes d'un outil qui ne lisent que les métadonnées (filtrer, trier,
  compter, router, lister) migrent sur `UnifiedTask` **maintenant**.
- Les étapes qui consomment la `sequence` (extraire le premier message,
  chercher un pattern dans le contenu, formater les actions) restent sur le
  squelette **pendant la transition** — c'est exactement ce que la couche de
  compatibilité permet.

## La couche de compatibilité (paire d'adaptateurs)

Deux fonctions, dans `src/types/unified-task.ts`, forment le pont bidirectionnel :

| Fonction | Direction | Usage |
|---|---|---|
| `toUnifiedTask(skeleton)` | squelette → `UnifiedTask` | Projeter un squelette (ou tout `SourceTaskLike`) dans le schéma unifié. Existant depuis #1391. |
| `unifiedTaskToSkeletonHeader(task)` | `UnifiedTask` → `SkeletonHeader` | **Nouveau (#1394).** Restituer un `UnifiedTask` sous forme de header legacy pour le code pas encore migré. |

Propriété de round-trip (testée dans `src/__tests__/types/unified-task.test.ts`) :
les champs header passent sans perte dans les deux sens —
`id`/`taskId`, `parentId`/`parentTaskId`, `title`, `createdAt`, `lastActivity`,
`messageCount`, `actionCount`, `totalSizeBytes`/`totalSize`, `workspace`,
`machineId`, `mode`, `indexedAt`/`qdrantIndexedAt`, `source`, `instruction`
(convention troncature 500), et `status=completed` ↔ `isCompleted=true`.

## La méthode de preuve « 0 régression » : test A/B

Chaque outil migré EST accompagné d'un test de comparaison qui exécute en
parallèle :

- **Path A (legacy)** : la logique d'avant migration, copiée *verbatim* dans le
  test (congelée comme référence) ;
- **Path B (unified)** : le nouveau chemin passant par `UnifiedTask`.

et asserte que les deux produisent le **même résultat observable** (même
séquence d'ids, mêmes compteurs) sur un corpus couvrant les cas limites. Voir
la référence : `src/tools/conversation/__tests__/unified-header-pipeline.test.ts`
(22 scénarios : filtres workspace×3 stratégies, fenêtres temporelles, machineId,
tri×clé×ordre, ex æquo, combinaisons, corpus vide).

C'est la traduction exécutable du critère d'acceptation #1394
« 0 régression fonctionnelle (tests comparison) ».

## Outil #1 migré : `conversation_browser` (action `list`)

Étape filtres/tri extraite dans `src/tools/conversation/unified-header-pipeline.ts`
(`applyUnifiedHeaderFiltersAndSort`) :

1. Projette chaque squelette en `UnifiedTask` (`toUnifiedTask`).
2. Applique les filtres header (workspace / startDate-endDate / machineId) et
   le tri (lastActivity / messageCount / totalSize) **sur la projection**.
3. Restitue les squelettes d'origine, filtrés puis triés — l'étape suivante du
   pipeline (extraction sequence, `pendingSubtaskOnly`, `contentPattern`),
   dépendante du squelette, est inchangée.

Note sémantique : trier puis filtrer (filtres async séquence-dépendants) donne
le même ordre final que filtrer puis trier — le filtrage préserve l'ordre
relatif et `Array.prototype.sort` est stable. Le test A/B couvre ce point.

`matchesWorkspace` (#1244 couche 2.2) a été extraite vers
`src/utils/workspace-match.ts` — une seule définition partagée entre le
pipeline unifié et les sites restés sur le squelette.

## État de migration des outils (#1394)

| Outil | Étape(s) header-level | Étape(s) sequence | Statut |
|---|---|---|---|
| `conversation_browser` (list) | filtres + tri | extraction sequence, pendingSubtask, contentPattern | **migré** (#1394 slice 1) |
| `view_task_details` | — | tout (rendu des actions) | à migrer (pattern : projection pour le header du rapport, sequence inchangée) |
| `codebase_search` | filtrage workspace des collections | — | à migrer |
| `roosync_search` (semantic) | filtres dates/machine/workspace des résultats | — | à migrer |
| `conversation_summarizer` | sélection/tâches stats | rendu des messages | à migrer |
| Méta-analystes (scripts) | agrégats cross-machine | — | à migrer |

## Checklist pour migrer l'outil suivant

1. Identifier les étapes qui ne lisent que des champs header → les faire
   passer par `toUnifiedTask` (ou consommer des `UnifiedTask` déjà produits par
   un appel en amont).
2. Si l'étape en aval attend un `SkeletonHeader`, utiliser
   `unifiedTaskToSkeletonHeader` — ne PAS réécrire un mapping ad-hoc.
3. Copier la logique pré-migration dans un test A/B (path A congelé) et
   asserter l'équivalence des résultats observables.
4. Faire tourner la suite de régression existante de l'outil — elle doit
   passer à l'identique, sans modification des assertions.
5. Mettre à jour la table ci-dessus.

## Relation avec la dépréciation #1395

`ConversationSkeleton` est annotée `@deprecated` avec warn-once (#1395 J+0,
PR submod #1255). La migration des consommateurs (ce document) est la
condition de sortie de la période de grâce : le warn-once ne disparaît que
quand les chemins actifs n'instantient plus le squelette. Les deux chantiers
avancent en parallèle sans se bloquent : la couche de compatibilité EST la
période de transition.
