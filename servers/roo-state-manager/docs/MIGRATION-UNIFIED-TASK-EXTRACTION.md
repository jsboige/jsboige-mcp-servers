# Guide de migration — ConversationSkeleton → extraction unifiée (task extraction)

**Statut :** J+0 livré (2026-09-29) — annotation + warn-once. **Retrait :** pas avant le
**2026-10-28**, gardé par roo-extensions #1394 (recensement et migration des consommateurs
`src/tools/`).

**Références :** roo-extensions #1360 / #1395 · architecture :
`docs/architecture/unified-task-extraction-architecture.md` (repo roo-extensions, PR #3922) ·
dual-write PG : roo-extensions #2191.

---

## Ce qui est déprécié

Le type **`ConversationSkeleton`** (`src/types/conversation.ts`) — format de conversation
Roo-spécifique (`sequence: (MessageSkeleton | ActionMetadata)[]`) servi par le cache
multi-tiers et produit depuis les archives GDrive.

Deux sites de production émettent un avertissement console **warn-once** par processus :

| Site | Fichier |
|---|---|
| `SkeletonCacheService.getInstance()` | `src/services/skeleton-cache.service.ts` |
| `archiveToSkeleton(archive)` | `src/services/archive-skeleton-builder.ts` |

**J+0 ne change AUCUN comportement** : le cache reste fonctionnel, l'avertissement est
purement informatif. Les autres producteurs du type (dont `archiveToStub`, stubs Tier 3)
ne sont pas warnés à J+0 — la couverture warn porte les deux sites déclarés ci-dessus.

## Le remplacement

L'**extraction unifiée PG** (`src/services/unified-store/`) :

- écriture via `getUnifiedStoreWriter()` (`src/services/unified-store/writer-factory.ts`) ;
- gate d'activation : `UNIFIED_STORE_DUAL_WRITE` (+ `UNIFIED_STORE_PG_URL`) — dual-write
  fichier + PostgreSQL (#2191) ;
- le format unifié n'est pas Roo-spécifique et alimente la recherche / les vues sans
  reconstruction de skeletons par machine.

## Ce que chaque consommateur doit faire

1. **Nouveau code** : ne pas ajouter de consommateur de `ConversationSkeleton`. Lire depuis
   l'unified store (PG) ou, si le chemin n'existe pas encore, ouvrir le point dans #1394
   plutôt que de consommer le format déprécié.
2. **Consommateurs existants (~90 fichiers sous `src/tools/`, recensement #1394)** : migrer
   au fil de #1394 — le plan de migration par vague vit dans l'issue, pas ici.
3. **Personne ne supprime rien avant** : (a) la fenêtre J+30 (2026-10-28), (b) la
   confirmation #1394 que les consommateurs sont migrés, (c) un dual-store vérifié comme
   source d'entrée complète.

## Anti-patterns

- Supprimer `ConversationSkeleton` ou ses sites de production avant la fenêtre J+30.
- « Migrer » un outil en le débranchant du cache sans vérifier la parité de données PG
  (le dual-write doit avoir couvert le corpus).
- Ajouter un nouveau consommateur « temporaire » du format déprécié.

---

*Ce guide accompagne la dépréciation J+0 (roo-extensions #1395, PR #3922 sortie (a) de la
review ai-01). Toute évolution du calendrier se répercute ici et dans le CHANGELOG.*
