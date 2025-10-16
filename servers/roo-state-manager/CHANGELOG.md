# Changelog - Roo State Manager

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