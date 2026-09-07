# Nomenclature des consolidations (CONS-N) — Roo State Manager

Référence canonique de la numérotation des consolidations d'outils MCP (épisode #603 / #1841,
issue racine jsboige/roo-extensions#2307). Créée pour lever la collision « CONS-8 » (mcp#754).

## Numérotation retenue

La série CONS-N désigne chaque **consolidation d'outils** (n→1). Chaque numéro est unique.
Le tableau ci-dessous fait foi ; les numéros non renseignés sont **inconnus**, pas omis par
négligence.

| n | Consolidation | Outil(s) résultant(s) | Commit |
|---|---------------|------------------------|--------|
| 1 | Messagerie 7→3 | `roosync_read`, `roosync_send`, `roosync_manage` | commentaire `src/tools/roosync/index.ts` |
| 6 | (cf. issue #220) | — | — |
| 7 | Pièces jointes 3→1 | `roosync_attachments` | `faf4f77d` |
| **8** | **Retrait de 4 outils morts (tools/list 19→15)** | retirés : `roosync_init`, `roosync_claim`, `roosync_decision`, `roosync_list_diffs` | `6be78ab9` |
| 9 | Retrait `export_task_tree_markdown` | `task_export` (action `markdown`) | commentaire `src/tools/registry.ts` |
| 10 | Retrait handlers export legacy (#519) | `export_data`, `export_config` | commentaire `src/tools/registry.ts` |
| 12 | Résumés (`roosync_summarize`) | repris par `conversation_browser(action: "summarize")` après retrait | `5bf69ff5` (création) · `9369ca50` (retrait, #1863 Phase B) |
| 14 | Export : fusion `task_export` → `export_data` (Cluster H) | `export_data` | `498c4604` |

> **Numéros sans référence vérifiable** : 2, 3, 4, 5, 11, 13. Aucune occurrence trouvée dans
> l'historique git ni les commentaires de code à la date de rédaction. Ne pas les citer comme
> canoniques.

## Collision CONS-8 résolue

Deux consolidations ont historiquement porté le numéro CONS-8 :

1. **Retrait des 4 outils morts** (`6be78ab9`) — titre de commit littéral :
   `feat(#603): CONS-8 remove 4 dead tools from tools/list (19→15)`. **C'est le CONS-8 retenu.**
   Les outils morts sont `roosync_init`, `roosync_claim`, `roosync_decision`,
   `roosync_list_diffs` ; ils restent dans `registry.ts` / `tool-definitions.ts` en
   backward-compat redirect, commentés `[REMOVED CONS-8 #603]`.

2. **Fusion messagerie** `send+read+manage+attachments` → `roosync_messages`
   (`8e57176c`, #1841 **Cluster G**). Ce n'est **PAS** CONS-8 : c'est l'item **Cluster G**
   de l'épisode #1841. Seul `src/tools/roosync/index.ts` le laissait étiqueter « CONS-8 »
   (mislabel — corrigé par mcp#754). Les deux autres sites (`src/tools/registry.ts`,
   `src/tools/tool-definitions.ts`) disent uniquement « #1841 Cluster G », sans numéro CONS.

**Règle de lecture** : les consolidations Cluster A–H de l'épisode #1841 sont indépendantes de
la série numérotée CONS-N (certains clusters ont reçu un numéro, d'autres non). Ne pas déduire
un numéro CONS d'une lettre de cluster, et réciproquement.
