# Changelog - Roo State Manager

## [Unreleased]

### Changed
- **roosync_dashboard update — réécriture v3 create-or-replace (roo-extensions#3549, Option A)** : `action:"update"` rejoint le chemin v3 commun — `type` désormais **requis** (même clé que read/write/append), section `status` par défaut, modes replace/append/prepend, création du dashboard absent avec le contenu fourni, dual-write fichier + PostgreSQL, verrous et gardes de write (#3459/#3482/#1791). **Breaking** : les sections legacy `machine`/`global`/`decisions`/`metrics` (titres du `DASHBOARD.md` monolithique) et `intercom` (append-only → `action=append`) sont rejetées avec guidage v3. L'outil legacy `update-dashboard.ts` et ses 3 fichiers de tests (64 tests) sont supprimés ; l'exclusion CI associée disparaît (31→30, census aligné).
- **tool_usage_stats — bornes de fenêtre inclusives du jour entier (#753, PR #1123)** : le filtre de fenêtre compare désormais des clés de jour (`YYYY-MM-DD`) au lieu d'horodatages contre un `endDate` à minuit UTC. Conséquence : **le jour de fin est compté en entier** — `end_date: '2026-05-21'` inclut désormais les appels du 21/05 à 10:00 (exclus avant). Toute comparaison `trend_report` / `save_snapshot` à cheval sur ce changement verra les chiffres du jour de fin monter sans autre explication. L'attribution des actions aval change aussi aux bornes : une action assistant hors fenêtre suivant un `tool_use` en fenêtre est attribuée au jour du `tool_use`.

### Fixed
- **tool_usage_stats — cache « lisible mais mal formé » ne casse plus l'outil (review ai-01 2026-09-07)** : `loadToolUsageCache` valide désormais la forme des entrées (perDay/buckets/records non nuls) en plus de `version` et `normalizer_version`. Un fichier cache corrompu ciblé (ex. `perDay: null`, versions correctes) tombait sur un chemin cache-hit sans try/catch → `TypeError` à chaque appel, fichier jamais réécrit ni invalidé (état absorbant). Rejeté au chargement, il retombe sur le chemin miss qui reconstruit et réécrit le cache.

## [2.0.0] - 2025-10-16

### 🎉 Messagerie RooSync Phase 2 - PRODUCTION READY

#### ✨ Nouvelles Fonctionnalités
- **roosync_mark_message_read** : Marquer messages comme lus avec persistence
- **roosync_archive_message** : Archiver messages avec déplacement physique (inbox → archive)
- **roosync_reply_message** : Répondre aux messages avec :
  - Inversion automatique from/to
  - Héritage thread_id et priority
  - Ajout automatique tag "reply"
  - Préfixe "Re:" au sujet

#### 🧪 Tests
- 18 nouveaux tests unitaires (70-85% coverage)
  - 4 tests mark_message_read
  - 5 tests archive_message
  - 9 tests reply_message
- 8 tests E2E workflow complet (100% succès)
  - Communication bidirectionnelle validée
  - Persistence fichiers validée
  - Thread management opérationnel

#### 📚 Documentation
- Guide utilisateur Phase 2 complet
- 5 scénarios d'usage documentés
- Workflow complets avec exemples
- Rapport tests E2E détaillé (426 lignes)

#### 📊 Statistiques Globales
- **6 outils MCP** (Phase 1+2)
- **49 tests unitaires** (100% passing)
- **~2300 lignes de code**
- **1200+ lignes documentation**

---

## [1.0.0] - 2025-10-16

### 🎉 Messagerie RooSync Phase 1 - Core Tools

#### ✨ Nouvelles Fonctionnalités
- **roosync_send_message** : Envoi messages structurés
- **roosync_read_inbox** : Lecture boîte de réception
- **roosync_get_message** : Lecture message complet
- **MessageManager** : Service de gestion messages (403 lignes)

#### 🧪 Tests
- 31 tests unitaires MessageManager (100% coverage)
- Tests E2E Phase 1 (3/3 outils validés)

#### 📚 Documentation
- Guide utilisateur MESSAGING-USAGE.md (253 lignes)
- Rapport implémentation Phase 1 (502 lignes)

---

## [Unreleased]

### Changed
- **Réparation complète de la suite de tests unitaires** : La suite de tests a été entièrement refactorisée pour être compatible avec les modules ES (ESM) TypeScript.
- **Configuration Jest** : Mise à jour de `jest.config.cjs` pour utiliser `ts-jest` avec le support ESM, incluant le mapping des modules pour une résolution correcte des imports.
- **Scripts `npm`** : Modification du script `npm run test` pour inclure les flags Node.js nécessaires (`--experimental-vm-modules`) et un script de pré-test (`test:setup`) pour la transpilation des helpers.
- **Refactoring des Tests** : Remplacement des références à `__dirname` par `import.meta.url` et importation explicite des globaux Jest (`describe`, `it`, etc.) pour se conformer aux standards ESM.
- **Dépendances** : Ajout de `ts-node`, `cross-env` et `esbuild` aux `devDependencies` pour supporter l'exécution des tests et des scripts dans un environnement TypeScript moderne.
- **Documentation (`README.md`)** : Ajout d'une section détaillant comment lancer la nouvelle suite de tests unitaires.