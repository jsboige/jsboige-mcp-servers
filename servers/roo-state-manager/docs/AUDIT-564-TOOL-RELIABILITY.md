# Issue #564: Audit Systématique des Outils MCP roo-state-manager

**Date**: 2026-03-06
**Machine**: myia-po-2025
**Status**: Phase 1 Complete - Inventory & Coverage Analysis

## Contexte

Suite à l'issue #562 et aux bugs découverts dans `conversation_browser` (commit `96014f99`), cet audit systématique vise à identifier tous les bugs silencieux similaires dans les 36 outils MCP.

**Bugs identifiés dans conversation_browser:**
1. `list` ne scannait jamais le disque (nouveaux tasks invisibles)
2. `ToolUsageInterceptor` jetait les résultats du scan disque
3. `ensureSkeletonCacheIsFresh` lisait le mauvais répertoire

**Problème fondamental**: 242 fichiers de tests, des milliers de tests unitaires, mais les tests ne validaient que le comportement du cache, pas l'intégration avec le filesystem réel.

## Phase 1: Inventaire des 36 Outils MCP

### Outils Exposés dans ListTools (36 tools)

#### Groupe 1: Storage & Maintenance (3 tools)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `storage_info` | Info stockage Roo (detect/stats) | ✅ Unit | Cache-heavy | **HIGH** - Peut retourner données stale |
| `touch_mcp_settings` | Force rechargement MCPs | ⚠️ Manual | Side-effect | MEDIUM |
| `maintenance` | Consolidé (cache_rebuild, diagnose_bom, repair_bom) | ✅ Unit | Filesystem | **HIGH** - Interaction disque critique |

#### Groupe 2: Conversation & Task (3 tools)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `conversation_browser` | **CONSOLIDÉ** (list/tree/current/view/summarize) | ✅ Unit, ❌ Integration | Cache+Disk | **CRITICAL** - Bugs #562 identifiés |
| `task_export` | Export arbre tasks (markdown/debug) | ✅ Unit | Cache-heavy | MEDIUM |
| `view_task_details` | Détails techniques task | ✅ Unit | Cache-only | LOW |

#### Groupe 3: Search & Indexing (3 tools)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `roosync_search` | Recherche sémantique/textuelle tasks | ✅ Unit, ❌ Integration | Cache+Qdrant | **HIGH** - Peut manquer nouveaux tasks |
| `roosync_indexing` | Indexation Qdrant (index/reset/rebuild) | ✅ Unit, ⚠️ E2E | Qdrant+Cache | **HIGH** - Dépend de Qdrant externe |
| `codebase_search` | Recherche sémantique code workspace | ✅ Unit, ❌ Integration | Qdrant+FS | **HIGH** - Nouveau, peu testé en prod |

#### Groupe 4: Logs & Config (4 tools)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `read_vscode_logs` | Scan logs VS Code/Roo | ✅ Unit | Filesystem | MEDIUM |
| `manage_mcp_settings` | Gestion mcp_settings.json | ✅ Unit | Filesystem | **HIGH** - Config critique |
| `rebuild_and_restart_mcp` | Build npm + restart MCP | ⚠️ Manual | Side-effect | MEDIUM |
| `get_mcp_best_practices` | Guide bonnes pratiques MCP | ✅ Unit | Static | LOW |

#### Groupe 5: Export & Config (3 tools)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `export_data` | Export XML/JSON/CSV tasks | ✅ Unit | Cache+FS | MEDIUM |
| `export_config` | Config XML export | ✅ Unit | State-only | LOW |
| `get_raw_conversation` | Contenu brut conversation | ✅ Unit | Filesystem | MEDIUM |

#### Groupe 6: Diagnostic (1 tool)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `analyze_roosync_problems` | Analyse sync-roadmap.md | ✅ Unit | Filesystem | MEDIUM |

#### Groupe 7: RooSync Core (19 tools via roosyncTools array)
| Tool | Description | Tests | Type | Risque |
|------|-------------|-------|------|--------|
| `roosync_send` | Envoyer/répondre/amender messages | ✅ Unit, ❌ Integration | GDrive+FS | **CRITICAL** - Communication inter-machine |
| `roosync_read` | Lire inbox/message | ✅ Unit, ❌ Integration | GDrive+FS | **CRITICAL** - Peut manquer messages |
| `roosync_manage` | Gestion messages (mark_read/archive) | ✅ Unit | GDrive+FS | HIGH |
| `roosync_get_status` | État sync système | ✅ Unit | GDrive | MEDIUM |
| `roosync_compare_config` | Comparaison configs machines | ✅ Unit, ⚠️ Manual | GDrive+PowerShell | **HIGH** - Inventaire critique |
| `roosync_list_diffs` | Liste différences détectées | ✅ Unit | GDrive | MEDIUM |
| `roosync_decision` | Workflow décision (approve/reject/apply/rollback) | ✅ Unit | GDrive+FS | HIGH |
| `roosync_decision_info` | Détails décision | ✅ Unit | GDrive | LOW |
| `roosync_init` | Initialiser infra RooSync | ✅ Unit | GDrive+FS | MEDIUM |
| `roosync_baseline` | Gestion baseline (update/version/restore/export) | ✅ Unit, ⚠️ Manual | GDrive+Git | **HIGH** - Versions critiques |
| `roosync_config` | Config sync (collect/publish/apply/apply_profile) | ✅ Unit, ❌ Integration | GDrive+FS | **HIGH** - Déploiement config |
| `roosync_inventory` | Inventaire machine/heartbeat | ✅ Unit, ⚠️ PowerShell | PowerShell+GDrive | **HIGH** - Dépend Get-MachineInventory.ps1 |
| `roosync_machines` | Machines offline/warning | ✅ Unit | GDrive | MEDIUM |
| `roosync_heartbeat` | Heartbeat complet (status/register/start/stop) | ✅ Unit, ⚠️ Integration | GDrive+State | HIGH |
| `roosync_mcp_management` | Gestion MCPs (manage/rebuild/touch) | ✅ Unit, ⚠️ Integration | FS+npm+PowerShell | **HIGH** - Config critique |
| `roosync_storage_management` | Gestion stockage (storage/maintenance) | ✅ Unit | FS+Cache | HIGH |
| `roosync_refresh_dashboard` | Refresh dashboard via PowerShell | ⚠️ Manual | PowerShell+GDrive | MEDIUM |
| `roosync_update_dashboard` | MAJ section dashboard (#546) | ✅ Unit | GDrive+FS | MEDIUM |
| `roosync_sync_event` | Événements sync (online/offline) | ✅ Unit | GDrive | MEDIUM |

**Total: 36 tools exposés**

## Analyse des Risques

### Outils CRITIQUES (Risque élevé de bugs silencieux)

| Tool | Symptôme potentiel | Root cause | Priority |
|------|-------------------|------------|----------|
| **conversation_browser** | Nouveaux tasks invisibles | Ne scanne pas le disque après démarrage MCP | **P0** |
| **roosync_send** | Messages non envoyés/perdus | Échec GDrive silencieux, pas de retry | **P0** |
| **roosync_read** | Messages manquants dans inbox | Cache stale, scan incomplet | **P0** |
| **roosync_search** | Résultats incomplets | Index Qdrant pas à jour, nouveaux tasks non indexés | **P1** |
| **roosync_indexing** | Index incohérent | Échecs Qdrant silencieux, pas de validation | **P1** |
| **codebase_search** | Résultats manquants | Chunks fragmentés, embeddings en français mal supportés | **P1** |
| **manage_mcp_settings** | Config corrompue | Pas de validation schema, BOM issues | **P1** |
| **roosync_config** | Config drift non détecté | Diff incomplet, machines non scannées | **P1** |
| **roosync_baseline** | Versions corrompues | Git tags manquants, backup incomplet | **P1** |
| **roosync_inventory** | Inventaire incorrect | PowerShell script fail, cache TTL expiré | **P2** |

### Pattern des Bugs Silencieux

**3 catégories identifiées:**

1. **Cache Stale (8 tools)**
   - `conversation_browser`, `roosync_search`, `roosync_read`, `task_export`
   - **Symptôme**: Données anciennes retournées, nouveaux éléments invisibles
   - **Root cause**: Pas de scan disque après init, cache jamais invalidé
   - **Fix requis**: Tests d'intégration avec données créées APRÈS init MCP

2. **Filesystem/GDrive Silent Fail (6 tools)**
   - `roosync_send`, `roosync_config`, `maintenance`, `roosync_baseline`
   - **Symptôme**: Opération "réussit" mais rien n'est écrit
   - **Root cause**: Pas de vérification post-write, erreurs GDrive avalées
   - **Fix requis**: Tests avec GDrive mock + validation post-write

3. **External Dependency Fail (4 tools)**
   - `roosync_indexing`, `codebase_search`, `roosync_inventory`, `roosync_compare_config`
   - **Symptôme**: Outil retourne succès mais dépendance externe (Qdrant, PowerShell) a échoué
   - **Root cause**: Pas de health check, timeout trop court, retry absent
   - **Fix requis**: Tests E2E avec dépendances mockées + timeout testing

## Gaps de Couverture Tests

### Tests Unitaires ✅ (242 fichiers)
- Couvrent bien les happy paths
- Testent la logique métier isolée
- Mocks extensifs (cache, filesystem, GDrive)

### Tests d'Intégration ❌ (Critiques manquants)

**Scenarios non testés:**

1. **Données créées après init MCP**
   - Tools: `conversation_browser`, `roosync_search`, `task_export`
   - Test: Créer task/message, vérifier visible immédiatement
   - **MANQUANT**: Aucun test ne vérifie le scan disque en cours d'exécution

2. **Échecs GDrive silencieux**
   - Tools: `roosync_send`, `roosync_config`, `maintenance`
   - Test: GDrive read-only, vérifier erreur propagée
   - **MANQUANT**: Tests avec GDrive mock qui fail

3. **Dépendances externes down**
   - Tools: `roosync_indexing`, `codebase_search`, `roosync_inventory`
   - Test: Qdrant down, PowerShell fail, vérifier erreur claire
   - **MANQUANT**: Tests avec dépendances indisponibles

4. **Timeout & Retry**
   - Tools: Tous les outils avec I/O (15+)
   - Test: Opération lente, vérifier timeout + retry
   - **MANQUANT**: Tests de timeout, pas de retry configuré

5. **Cache Invalidation**
   - Tools: `conversation_browser`, `roosync_read`, `task_export`
   - Test: Modifier fichier disque, vérifier cache invalidé
   - **MANQUANT**: Tests de cache invalidation

### Tests de Données Stale ❌ (CRITIQUE)

**Template de test manquant:**

```typescript
describe('Stale Data Detection', () => {
  it('should detect tasks created after MCP init', async () => {
    // 1. Init MCP, cache vide
    await initMCP();
    // 2. Créer task sur disque (simuler Roo)
    await createTaskOnDisk('new-task-id');
    // 3. Appeler conversation_browser(action: 'list')
    const result = await conversationBrowser({ action: 'list' });
    // 4. ASSERTION: 'new-task-id' doit être dans les résultats
    expect(result).toContain('new-task-id');
  });
});
```

**Outils nécessitant ce test:**
- `conversation_browser` (action: list/tree/current) ⚠️
- `roosync_search` (action: text/semantic) ⚠️
- `roosync_read` (mode: inbox) ⚠️
- `task_export` (action: markdown) ⚠️
- `storage_info` (action: stats) ⚠️

## Recommandations Phase 2 (Smoke Tests)

### Test Suite "Smoke Tests Multi-Machine"

**Objectif**: Valider que chaque outil retourne des données cohérentes et à jour.

**Protocole par outil:**

1. **Setup**: État initial connu (X tasks, Y messages)
2. **Action**: Modifier état (créer task/message)
3. **Call**: Appeler l'outil
4. **Assert**: Vérifier que la modification est visible
5. **Cleanup**: Restaurer état initial

**Exemple pour conversation_browser:**

```bash
# 1. Setup: Compter tasks actuels
BEFORE=$(conversation_browser action=list | jq '.tasks | length')

# 2. Action: Créer nouveau task (simuler Roo)
echo '{"id":"smoke-test-1"}' > $ROO_STORAGE/smoke-test-1/skeleton.json

# 3. Call: Lister tasks
AFTER=$(conversation_browser action=list | jq '.tasks | length')

# 4. Assert: AFTER = BEFORE + 1
if [ $AFTER -ne $(($BEFORE + 1)) ]; then
  echo "FAIL: conversation_browser ne détecte pas nouveau task"
  exit 1
fi

# 5. Cleanup
rm -rf $ROO_STORAGE/smoke-test-1
```

**Outils prioritaires pour Phase 2:**

| Priority | Tool | Smoke Test | Machine |
|----------|------|------------|---------|
| P0 | `conversation_browser` | Nouveau task visible | ALL |
| P0 | `roosync_send` | Message envoyé + reçu | ai-01 → po-2025 |
| P0 | `roosync_read` | Message non lu visible | ALL |
| P1 | `roosync_search` | Nouveau task trouvé | ALL |
| P1 | `roosync_indexing` | Task indexé dans Qdrant | ALL (Qdrant up) |
| P1 | `codebase_search` | Nouveau fichier trouvé | ALL |
| P1 | `manage_mcp_settings` | Config lue/écrite correctement | ALL |

## Recommandations Phase 3 (Tests d'Intégration)

### Template Tests d'Intégration

**Créer dans `tests/integration/` (nouveau répertoire):**

```typescript
// tests/integration/conversation-browser.integration.test.ts
describe('conversation_browser Integration Tests', () => {
  describe('Stale Data Detection', () => {
    it('should detect tasks created after MCP start', async () => {
      // Test du bug #562
    });

    it('should invalidate cache when disk changes', async () => {
      // Test cache invalidation
    });
  });

  describe('Disk Scan Behavior', () => {
    it('should scan disk on first call', async () => {
      // Vérifier ensureSkeletonCacheIsFresh appelé
    });

    it('should rescan on subsequent calls', async () => {
      // Vérifier scan multi-calls
    });
  });
});
```

### Infrastructure Requise

**Tests d'intégration nécessitent:**

1. **Fixture Filesystem**
   - Créer/supprimer tasks sur disque
   - Modifier skeleton.json en cours de test
   - Cleanup automatique

2. **Mock GDrive**
   - Simuler read/write GDrive
   - Simuler échecs (read-only, network fail)
   - Vérifier retry logic

3. **Mock Qdrant**
   - Simuler indexation
   - Simuler recherche
   - Simuler service down

4. **Assertions Avancées**
   - Vérifier appels filesystem
   - Vérifier ordre d'exécution
   - Vérifier timeout/retry

## Critères de Succès

**Phase 1 ✅ DONE:**
- [x] Inventaire 36 outils
- [x] Classifier par risque
- [x] Identifier gaps couverture tests

**Phase 2 (À faire):**
- [ ] Smoke tests sur 7 outils prioritaires (ALL machines)
- [ ] Documenter résultats par machine
- [ ] Créer issues pour bugs détectés

**Phase 3 (À faire):**
- [ ] Tests d'intégration pour 10 outils critiques
- [ ] Infrastructure tests (fixtures, mocks)
- [ ] CI/CD: Tests d'intégration dans pipeline

**Cible finale:**
- [ ] Chaque outil MCP a >= 1 test unitaire
- [ ] Chaque outil MCP a >= 1 test d'intégration
- [ ] Chaque outil MCP a >= 1 test de données stale
- [ ] Taux couverture intégration >= 80% pour outils CRITICAL

## Actions Immédiates

**Pour Coordinateur (ai-01):**
1. Valider cette analyse Phase 1
2. Dispatcher smoke tests Phase 2 aux 6 machines
3. Créer template smoke test script

**Pour Exécutants (ALL):**
1. Exécuter smoke tests locaux (7 outils prioritaires)
2. Reporter résultats dans issue #564
3. Créer issues pour bugs détectés

**Pour ai-01 (après Phase 2):**
1. Synthèse résultats smoke tests
2. Prioriser tests d'intégration Phase 3
3. Créer infrastructure tests

---

**Status:** Phase 1 COMPLETE
**Next:** Phase 2 - Smoke Tests Multi-Machine
**Owner:** myia-po-2025 (Phase 1), myia-ai-01 (Phase 2 dispatch)
