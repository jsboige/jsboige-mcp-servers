# Index complémentaire `sup-` (#4352, option a3)

**Statut :** implémenté, non déployé. Écriture Qdrant et déploiement attendent le verdict
#4131 (arbitrage ai-01, 25/10 14:00Z).

## Le problème

Zoo 3.92 n'indexe jamais certaines familles de fichiers, par construction : toute extension
hors de sa liste de scanners (`.ps1`, `.psm1`, `.psd1`, `.sh`, `.bat`, `.cmd`, `.mjs`, `.cjs`,
`.yml`, `.yaml`, `.sql`, `.svelte`) et tout répertoire caché (`-g !**/.*/**` : `.claude/`,
`.roo/`, `.github/`). Mesure ai-01 sur roo-extensions, 25/10 : 9 332 fichiers visibles par git,
7 555 indexables par Zoo, 1 775 ignorés — dont ~750 fichiers texte qui portent des règles, des
scripts et des workflows que les agents cherchent. Aucun classement ne peut retourner un fichier
qui n'a jamais été vectorisé.

`codebase_search` nomme déjà ces angles morts (`not_indexed_by_design`) au lieu de laisser
l'agent lire le silence comme une absence. L'option (a3) ajoute la deuxième moitié : une
collection qui les contient.

## Ce qui a été construit

| Élément | Décision | Pourquoi |
|---|---|---|
| Nom de collection | `sup-` + `sha256(remote normalisé)[:16]` | Une par **dépôt**, pas par chemin. Les `ws-` sont indexées par chemin : deux sièges au même chemin partagent une collection, un même dépôt à deux chemins en a deux. Le complément prend l'inverse, ce qui rend un écrivain unique possible. |
| Normalisation du remote | schéma/credentials/`.git`/slash final retirés, minuscules | `git@…`, `https://…` et `https://user:token@…` du même dépôt doivent tomber sur la même clé — et un token ne doit jamais finir dans un nom de collection. |
| Écrivain unique | Sentinelle Qdrant + échappatoire `takeover` | Deux sièges qui écrivent avec deux modèles d'embedding produisent une collection dont les points ne sont pas comparables : le classement devient absurde, sans aucune erreur. `takeover` est le seul chemin de passage et il enregistre `takenOverFrom`. | 
| Empreinte d'embedding | `embeddingModelId` + `embeddingModelDimensions` + `embeddingEndpoint` dans la sentinelle (fix 2, review ms#1514 + Hermes pt 2) | L'incrémental saute sur `fileHash` seul : après un changement de modèle — **ou d'endpoint** (`EMBEDDING_API_BASE_URL`, même nom de modèle) — tous les hashes sont « inchangés », la collection mélangerait deux espaces vectoriels en silence. Un run dont l'empreinte diffère **refuse** (message nommant les deux empreintes) ; `takeover` ne traverse PAS un changement de modèle. L'endpoint est enregistré par **hôte** (jamais l'URL brute — un identifiant qui pourrait vivre dans une URL ne finit pas dans un payload Qdrant). Remède : le complément est une donnée dérivée — supprimer la collection `sup-` et relancer pour la reconstruire entière sous le modèle courant. |
| Sélection | git-visible + `isZooBlindSpot` + texte + ≤ 1 Mo | Zoo liste avec ripgrep (donc `.gitignore` respecté) ; la borne 1 Mo est son propre plafond de scanner, gardée pour que les deux corpus restent comparables. |
| Chunker | Port du chunker ligne-fenêtre de Zoo (`MIN_BLOCK_CHARS=50`, `MAX_BLOCK_CHARS=1000`, tolérance 1,15, reste ≥ 200) | Une même ligne doit se découper pareil dans les deux pipelines. **Une divergence assumée** : Zoo perd les lignes entre le point de split ré-équilibré et la ligne courante (mesuré : 8 lignes sur 56) ; ce port rejoue depuis le nouveau départ. Aucune compatibilité à préserver — Zoo ne découpe jamais ces fichiers. |
| Payload | champs Zoo (`filePath`, `codeChunk`, `startLine`, `endLine`, `segmentHash`, `pathSegments.*`) + `fileHash`, `writer`, `source: "rsm-supplement"` | La fusion dans `codebase_search` n'a besoin d'aucun cas particulier : mêmes malus, même plafond par fichier, même dédoublonnage. |
| Incrémental | `fileHash` par fichier | Un fichier inchangé n'est ni découpé ni embedé. Un fichier modifié voit ses anciens points supprimés avant réécriture (pas d'orphelin). Un fichier disparu du disque est purgé — le trou de GC de Zoo (#2609/#2554) n'est pas reproduit. |
| Recherche | Même vecteur de requête, mêmes bornes, en parallèle, fusionnée, étiquetée `index: "supplement"` | Un hit du complément n'est pas un hit privilégié : il traverse exactement les mêmes malus et le même plafond. Étiqueté par origine, jamais par rang. |

## Surface d'appel

```
roosync_indexing(action: "index_code_supplement", workspace, dry_run)
```

- **`dry_run` par défaut à `true`** — inversion assumée par rapport aux autres actions : celle-ci
  écrit des vecteurs, et l'absence de paramètre est plus fréquente que sa présence. Écrire exige
  `dry_run: false`.
- `takeover: true` : prendre la propriété de la collection à une autre lane.
- `max_files`, `batch_size` : bornes d'exécution (défaut 32 chunks par lot, 200 ms entre lots).

Réponse : `collection`, `remote`, `writer`, `collection_exists`, `writer_guard`, `vector_config`,
`files_selected` / `files_to_index` / `files_indexed` / `files_skipped_unchanged` / `files_removed`,
`points_deleted`, `chunks_embedded`, `points_written`, `batches`, `truncated`, `elapsed_ms`.

Côté `codebase_search`, la réponse gagne `supplement: {collection, points, hits}` — `points` =
candidats apportés au pool, `hits` = combien ont survécu au classement. Le bloc est absent quand le
workspace n'a pas de remote (pas de collection possible) **et quand la collection est prouvée
absente de Qdrant** (fix 1, review ms#1514 : un nom dérivé du remote n'est pas une preuve
d'existence — sans cette porte, chaque recherche paierait une requête 404 et le hint affirmerait
« searched separately » à tort ; l'absence **prouvée** (404 / « not found ») est mise en cache 5 min
par workspace, comme la sonde remote, et le hint retombe sur Grep) et porte `error` quand la
collection existe mais que la requête échoue : la panne d'un corpus secondaire ne fait jamais tomber
le corpus principal. Une erreur de **transport** sur la sonde de présence (ECONNREFUSED, timeout)
n'est ni une absence ni un motif de suppression : elle n'est pas cachée, la requête part quand même
et porte son `error` — une micropanne de 2 secondes ne doit pas acheter 5 minutes de corpus invisible
sans raison (review ms#1514, Hermes pt 1).

## Ce qui reste à faire / à vérifier

1. **Écriture réelle et déploiement** : après le verdict #4131. L'écrivain désigné pour
   roo-extensions est ai-01.
2. **Critères d'acceptation de #4352** : les 4 requêtes à réponse connue doivent trouver leur
   cible dans le top 5 ; le benchmark 11 cas doit garder MRR ≥ 0,391 ; surcoût de latence à chaud
   < 1 s. Aucun de ces trois points n'est mesurable sans écrire la collection.
3. **Taille** : ~750 fichiers ≈ 8 000 chunks ≈ 1,6 % de la collection servie actuelle
   (486 535 points) — à confirmer sur le premier run réel.

## Tests

- `src/services/code-index/__tests__/supplement-index.test.ts` (33 tests) : normalisation du
  remote, fidélité du chunker (dont la conservation exhaustive des lignes), sélection sur un
  **vrai** dépôt git temporaire, garde d'écrivain (refus sans `takeover`, reprise avec), dry run
  qui n'écrit rien, incrémental, purge des fichiers disparus, batch d'embedding désaligné refusé.
  Chaque garde a son contrôle de mutation dans le nom du test.
- `src/tools/search/__tests__/search-codebase.supplement.test.ts` (5 tests) : même vecteur et
  mêmes bornes pour les deux collections, fusion étiquetée, plafond par fichier appliqué aux hits
  du complément, et fail-open sur collection injoignable ou workspace sans remote.
