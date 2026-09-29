# Changelog - Roo State Manager

## [Unreleased]

### Added
- **allow-list harnais serré — 5 clés #3657 pour le canon settings v2 (roo-extensions #3924/#3545, TASK settings 29/09)** : `ALLOWED_KEY_PATHS` s'élargit à `env.ENABLE_TOOL_SEARCH`, `disableBundledSkills`, `disableClaudeAiConnectors`, `disableRemoteControl`, `outputStyle` (+ severities : IMPORTANT ×4, WARNING pour outputStyle). Sans cela, `validateCanon` rejetait tout canon v2 mentionnant le harnais (« chemin non allow-listé ») — la dérive post-campagne #3544 (bascules `model`, tier ids expirés) restait invisible au MCP. **`permissions.*`/`hooks` restent volontairement hors allow-list** : le deny ENSURE-list et `mode` sont portés par `Deploy-GlobalConfig.ps1` (#3924, repo parent) — séparation des pouvoirs, le MCP n'harmonise que des valeurs. Squelette campagne v2 (payload create `enforce-value` + routine remind/drift-check coordinateur) : `docs/HARMONIZATION-CANON-V2.md`.
- **reconcile-roosync-channel — réconciliation PG ↔ pool GDrive avant arming `UNIFIED_STORE_CHANNEL_READ_PG` (roo-extensions #3151 Phase B, escalade user 29/09)** : `scripts/reconcile-roosync-channel.mjs` + module `channel-reconcile.ts`. Le pool inbox partagé étant la vérité d'appartenance (l'archive déplace le fichier vers une archive LOCALE par machine), les lignes PG `unread|read` dont le fichier est absent et plus vieilles que la fenêtre de grâce (48 h par défaut) sont marquées `archived` — sans quoi une machine armant READ_PG servirait des milliers de messages fantômes (mesuré po-2026 : 169 unread PG dont seules les récentes ont un fichier ; ~24k lignes non-archivées >90 j flotte). **Dry-run par défaut**, manifeste réversible (ids + status_before) toujours écrit, `--apply` gardé par `UNIFIED_STORE_DUAL_WRITE=1`. Arming : backfill → reconcile → `UNIFIED_STORE_CHANNEL_READ_PG=1`.
- **trend_report `fleet:true` — vue agrégée flotte (#2336 D3/D5)** : nouveau paramètre optionnel `fleet` (défaut `false`, comportement mono-machine inchangé). Produit UN artefact répondant à « usage et utilité ont-ils monté depuis le cycle dernier ? » au niveau flotte : tableau par machine (cycle-over-cycle), agrégat flotte sur l'ensemble comparable uniquement (machines avec ≥2 snapshots — les machines à snapshot unique sont listées baseline-only et n'inflent pas le delta), et tendance par outil (top 20, appels sommés, taux pondérés par appels, garde #3381 `MIN_CALLS_FOR_ERROR_RATE` sur les appels sommés, tolérance #2623 aux snapshots sans `.tools`).

### Changed
- **roosync_dashboard update — réécriture v3 create-or-replace (roo-extensions#3549, Option A)** : `action:"update"` rejoint le chemin v3 commun — `type` désormais **requis** (même clé que read/write/append), section `status` par défaut, modes replace/append/prepend, création du dashboard absent avec le contenu fourni, dual-write fichier + PostgreSQL, verrous et gardes de write (#3459/#3482/#1791). **Breaking** : les sections legacy `machine`/`global`/`decisions`/`metrics` (titres du `DASHBOARD.md` monolithique) et `intercom` (append-only → `action=append`) sont rejetées avec guidage v3. L'outil legacy `update-dashboard.ts` et ses 3 fichiers de tests (64 tests) sont supprimés ; l'exclusion CI associée disparaît (31→30, census aligné).
- **tool_usage_stats — bornes de fenêtre inclusives du jour entier (#753, PR #1123)** : le filtre de fenêtre compare désormais des clés de jour (`YYYY-MM-DD`) au lieu d'horodatages contre un `endDate` à minuit UTC. Conséquence : **le jour de fin est compté en entier** — `end_date: '2026-05-21'` inclut désormais les appels du 21/05 à 10:00 (exclus avant). Toute comparaison `trend_report` / `save_snapshot` à cheval sur ce changement verra les chiffres du jour de fin monter sans autre explication. L'attribution des actions aval change aussi aux bornes : une action assistant hors fenêtre suivant un `tool_use` en fenêtre est attribuée au jour du `tool_use`.

### Deprecated
- **ConversationSkeleton — dépréciation J+0 du format Roo-spécifique (roo-extensions #1360/#1395, PR roo-extensions #3922)** : le type `ConversationSkeleton` (`src/types/conversation.ts`) est marqué `@deprecated`. Deux sites de production émettent un avertissement console **warn-once** par processus : `SkeletonCacheService.getInstance()` et `archiveToSkeleton()`. Remplacement : l'extraction unifiée PG (`src/services/unified-store/`) — guide `docs/MIGRATION-UNIFIED-TASK-EXTRACTION.md`. Suppression pas avant le 2026-10-28, gardée par roo-extensions #1394 (migration des ~90 consommateurs `src/tools/`).

### Fixed
- **appendDashboardIncremental — un append depuis une copie locale en retard devient une réparation, pas une perte (roo-extensions #3230, incident 28/09)** : sur un hôte `UNIFIED_STORE_DASHBOARD_READ_PG=1`, l'incrément relisait le fichier LOCAL et y collait le bloc neuf — le fichier écrit valait « copie locale, même en retard, + mon message », et DriveFS poussait ce fichier au cloud (mesuré ai-01 28/09 : 2 vagues d'écrasement sur `workspace-roo-extensions`, 11 des 15 messages vivants omis à 23:21Z, restaurés via union PG). Désormais : si le fichier local manque des ids vivants de la vue PG en main, le fichier COMPLET est écrit depuis la vue (`writeDashboardFile`) au lieu de l'incrément. Garde volontairement **unidirectionnelle** (un fichier portant des ids absents de la vue — writer concurrent, condensation — reste le suffixe intact de l'incrément) et **gated** (hors READ_PG, la vue provient du fichier : garde muette par construction). Tests : `dashboard-stale-copy-append.test.ts` (réparation à la spec ai-01, unidirectionnalité, contrôle gate-off ; contre-preuve mutation-vérifiée).
- **reconcile-roosync-channel — gardes de santé du pool : un montage DriveFS débranché ABORTE la passe (review #1256 point 1, #3151 Phase B)** : si le pool inbox n'a AUCUN fichier vivant alors que PG a des candidats (`pool-empty`), ou si > 90 % d'un ensemble ≥ 100 candidats est classé fantôme (`ghost-ratio` — aucun premier passage légitime n'a dépassé 0,61, mesuré 9 346/15 225 le 29/09), la passe refuse d'archiver quoi que ce soit : `ghosts=[]`, manifeste `aborted` documenté, exit 2 du script. Un pool non monté aurait fait passer chaque message vivant pour un fantôme et archivé toute la mailbox au-delà de la fenêtre de grâce. 7 tests (bornes exactes : ratio 0,9 strict, population minimale, pool vierge, mode apply).
- **getRooSyncMailbox — les messages détruits ne doivent pas peupler la mailbox PG-primaire (#3151 Phase B, escalade user 29/09)** : la requête filtrait `status <> 'archived'` mais pas `destroyed_at IS NULL` — une ligne détruite (auto-destruct/expiry) dont le `status` était resté `unread|read` serait servie par `readInbox` en lecture PG-primaire. Garde ajoutée + test SQL asserçant la clause.
- **condensation fallback — le discriminant d'archive `fallbackError` distingue 3 états confondus (roo-extensions#2719, spec po-204, datapoint po-2027 2026-09-07)** : le frontmatter des archives `-fallback.md` était construit exclusivement sur `fallbackAttempted` (stampé uniquement sur un échec cloud), faisant lire `not-attempted-or-unconfigured` pour (1) un cloud réellement non configuré, (2) un cloud ayant répondu 200 avec un contenu VIDE (retournait le `null` muet « unconfigured ») et (3) un cloud ayant RÉUSSI sur l'autre appel de la même passe (`fallbackUsed` ignoré). Désormais : contenu vide = erreur stampée non-retryable `empty-content (HTTP 200, 0-byte completion)` (le non-retry #3011 est préservé), et `fallbackUsed` sans échec capturé = `no-fallback-failure-captured`. Tests (h)/(i) dans `dashboard.fallback-cloud.test.ts`.
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