# Recensement des exclusions CI — `vitest.config.ci.ts`

**Dernier audit :** 2026-10-04 (#2639 réactivation)
**Mesure canonique :** `node scripts/count-ci-exclusions.mjs` (script, jamais à la main)
**Drift-guard :** `tests/unit/ci-exclusion-drift-guard.test.ts` — échoue si le header du config dérive ou si une entrée ghost apparaît

---

## Mesures canoniques

| Mesure | Valeur (2026-10-04) | Méthode |
|---|---|---|
| **Entrées fichiers de test déclarées** | **25** | parse du tableau `exclude` du config |
| **Globs répertoires de tests déclarés** | **4** | idem |
| Entrées structurelles (node_modules/build/dist/backups) | 9 | idem — hygiène, pas des exclusions de tests |
| Fichiers effectivement non collectés en CI (vs run local) | **16** | `node scripts/count-ci-exclusions.mjs --collect` (diff `vitest list` unit vs CI) |
| Tests sautés en CI (vs run local) | **363** | idem |

**Pourquoi deux nombres.** Le compte *déclaré* ne change que quand on édite le config — c'est lui que le
drift-guard verrouille et que les docs citent. Le compte *effectif* (16 fichiers / 363 tests) dépend
aussi des patterns `include` et du contenu des fichiers (ex. `dashboard-llm-live` collecte 0 test sans
`LLM_LIVE_INTEGRATION=1`) : il dérive sans toucher au config, donc il n'est pas gardé et se mesure à la
demande via `--collect`.

## Historique de la dérive (avant #3322)

| Source | Claim | Verdict au 2026-08-31 |
|---|---|---|
| Header `vitest.config.ci.ts` | « 29 files excluded — 2026-03-14 (#699) » | périmé (>5 mois, 2 ghosts non détectés) |
| `.claude/rules/ci-guardrails.md` (parent) | « exclut 32 tests platform-dependants » | faux — mauvaise unité (tests ≠ fichiers) et mauvaise valeur |
| `mcps/internal/README.md` (2 emplacements) | « excludes 32 platform-dependent tests » | idem |
| `servers/roo-state-manager/README.md` | « 33 platform-dependent test files » | comptait 2 ghosts ; « platform-dependent » inexact (GDrive/live/stress ≠ plateforme) |

Alignement #3322 : toutes les sources citent désormais **« 31 fichiers de tests déclarés »** (unité :
entrées de fichiers déclarées dans le config CI). **#3549 (2026-09-09) :** `update-dashboard.integration.test.ts`
retiré avec son module (update v3-native, couvert en CI) → **30 entrées**. **#2639 (2026-10-03) :**
`get-status.smoke.test.ts` réactivé (réécriture #2639 : chaque scénario tourne sur un tmpdir
`ROOSYNC_SHARED_PATH` créé par le test — plus de dépendance GDrive réelle) → **29 entrées**. **#2639 (2026-10-03, 2e réactivation) :** `machines.smoke.test.ts` réactivé (même méthode : tmpdir `os.tmpdir()` remplaçant le chemin `/tmp` POSIX-only + contrat d'isolation) → **28 entrées**. **#2639 (2026-10-04, 3e réactivation) :** `send.smoke.test.ts` réactivé
(l'isolation tmpdir était déjà en place depuis la réécriture #564/#815 — l'exclusion blanket posée à sa
création `e514937d` était périmée ; ajout d'un contrat d'isolation explicite) → **27 entrées**.
**#2639 (2026-10-04, 4e réactivation) :** `storage-management.smoke.test.ts` réactivé (**isolation
mock-based**, écart documenté à la méthode tmpdir : les détecteurs scannent des chemins machine réels
via un cache global 5 min sans routage env — pattern CI établi `baseline.test.ts` #2967 ; fraîcheur #564
préservée sur état mock) → **26 entrées**. **#2639 (2026-10-04, 5e réactivation) :**
`list-diffs.smoke.test.ts` réactivé (isolation tmpdir déjà en place — baseline + inventaires écrits
dans le tmpdir, `ROOSYNC_SHARED_PATH` routé, cleanup ENOTEMPTY-retry ; contrat d'isolation ajouté,
écriture de fichier debug permanente retirée) → **25 entrées**.

---

## Les 25 entrées fichiers de test

### POWERSHELL — 6 entrées, toutes effectives (159 tests)

CI tourne sur `ubuntu-22.04` ; ces tests requièrent Windows PowerShell / APPDATA.

| Entrée | Tests | Datée |
|---|---|---|
| `src/services/__tests__/PowerShellExecutor.test.ts` | 29 | non |
| `tests/unit/services/PowerShellExecutor.test.ts` | 65 | non |
| `tests/unit/services/powershell-executor.test.ts` | 21 | non |
| `tests/unit/services/InventoryCollector.test.ts` | 28 | non |
| `tests/unit/services/InventoryCollectorWrapper.test.ts` | 3 | non |
| `src/tools/roosync/__tests__/inventory.integration.test.ts` | 13 | non |

### SMOKE — 0 entrée (toutes réactivées, #2639)

Les 5 anciennes exclusions smoke dépendaient de l'état réel GDrive/RooSync partagé (production) —
l'isolation de chaque fichier a été rétablie ou constatée déjà en place, une par une.

*(`get-status.smoke.test.ts` réactivé en CI le 2026-10-03 (#2639) : la réécriture tourne chaque
scénario sur un tmpdir `ROOSYNC_SHARED_PATH` créé par le test — 11/11 vérifiés sous config CI.
`machines.smoke.test.ts` réactivé le même jour, même méthode — tmpdir `os.tmpdir()` + contrat
d'isolation, 4/4 vérifiés sous config CI. `send.smoke.test.ts` réactivé le 2026-10-04 : isolation
tmpdir déjà en place (réécriture #564/#815, l'exclusion blanket de sa création était périmée),
contrat d'isolation ajouté — 4/4 vérifiés sous config CI. `storage-management.smoke.test.ts` réactivé
le 2026-10-04 : isolation **mock-based** — les détecteurs ne routent pas par env, les mocks
`baseline.test.ts` #2967 font tourner la fraîcheur #564 sur état mock — 4/4 vérifiés sous config CI.
`list-diffs.smoke.test.ts` réactivé le 2026-10-04, même classe que send : isolation tmpdir déjà en
place (baseline + inventaires écrits dans le tmpdir, `ROOSYNC_SHARED_PATH` routé, `SHARED_STATE_PATH`
supprimé en beforeEach, cleanup ENOTEMPTY-retry), contrat d'isolation ajouté, écriture de fichier
debug permanente retirée — 4/4 vérifiés sous config CI.)*

Plus aucune entrée : les cinq fichiers smoke tournent sous config CI.

### APPDATA/GDRIVE — 8 entrées, 7 effectives (175 tests) + 1 no-op

Intégrations contre le vrai GDrive (chemins Windows + état partagé).

| Entrée | Tests | Datée |
|---|---|---|
| `src/tools/roosync/__tests__/baseline.integration.test.ts` | 12 | non |
| `src/tools/roosync/__tests__/compare-config.integration.test.ts` | 39 | non |
| `src/tools/roosync/__tests__/config.integration.test.ts` | 40 | non |
| `src/tools/roosync/__tests__/decision.integration.test.ts` | 28 | non |
| `src/tools/roosync/__tests__/diagnose.integration.test.ts` | 23 | non |
| `src/tools/roosync/__tests__/refresh-dashboard.integration.test.ts` | 13 | non |
| `src/tools/roosync/__tests__/dashboard-llm-live.integration.test.ts` | 0 (no-op) | #1578 |
| `tests/unit/tools/roosync/baseline.test.ts` | 20 | non |

Note : `dashboard-llm-live` est opt-in via `LLM_LIVE_INTEGRATION=1` (repro 502 #1578) — le module
collecte 0 test sans la variable, l'exclusion est déclarative mais sans effet sur le delta.

### Inherited (doublons du config unit / hors include) — 7 entrées, toutes no-op

| Entrée | Statut | Raison |
|---|---|---|
| `tests/unit/parent-child-validation.test.ts` | no-op (exclue aussi du config unit) | non documentée dans les configs |
| `tests/unit/skeleton-cache-reconstruction.test.ts` | no-op (unit) | non documentée |
| `tests/unit/workspace-filtering-diagnosis.test.ts` | no-op (unit) | non documentée |
| `tests/integration/hierarchy-real-data.test.ts` | no-op (hors `include` des deux configs) | données réelles |
| `tests/integration/integration.test.ts` | no-op (hors `include`) | — |
| `tests/unit/services/roosync/FileLockManager.simple.test.ts` | no-op (unit) | #307 proper-lockfile/threads |
| `tests/unit/services/roosync/PresenceManager.integration.test.ts` | no-op (unit) | #307 |

### ARCHIVES — 1 entrée fichier, no-op (couverte par `**/_archives/**` du config unit)

| Entrée | Datée |
|---|---|
| `tests/unit/services/_archives/BaselineService.ci-excluded.test.ts` | 2026-05-14 (#1143) — superseded par la version `src/services/__tests__` |

### PARENT_REPO — 1 entrée, effective (13 tests)

| Entrée | Tests | Raison |
|---|---|---|
| `src/services/__tests__/skepticism-protocol.test.ts` | 13 | lit des fichiers du repo parent roo-extensions — impossible en CI submodule autonome |

### LIVE SERVICES — 1 entrée, effective (6 tests)

| Entrée | Tests | Raison |
|---|---|---|
| `src/tools/search/__tests__/search-live.integration.test.ts` | 6 | requiert Qdrant + service d'embeddings vivants |

### STRESS — 1 entrée, effective (10 tests)

| Entrée | Tests | Raison |
|---|---|---|
| `src/tools/roosync/__tests__/stress-large-inbox.test.ts` | 10 | seuils de timing dépendants du hardware (16 GB RAM, `--maxWorkers=1`) |

**Total déclaré : 6+0+8+7+1+1+1+1 = 25 · effectif : mesure 2026-10-04 post-#2639 (`--collect`) — 16 fichiers / 363 tests**

---

## Les 4 globs répertoires de tests

| Glob | Contenu au 2026-08-31 | Datée |
|---|---|---|
| `tests/integration/_archives/**` | 2 fichiers archivés | 2026-05-14 (#1143) |
| `tests/performance/_archives/**` | 1 fichier archivé (concurrency) | 2026-05-14 (#1143) |
| `tests/eval-harness/**` | harnais d'éval (services vivants) | non |
| `tests/e2e/**` | déjà exclu du config de base | non |

## Entrées structurelles (9) — hors périmètre tests

`node_modules`, `build`, `dist`, `**/node_modules/**`, `**/build/**`, `**/dist/**`, `**/backups/**`,
`**/vitest-migration/backups/**`, `vitest-migration/backups/**`

## Ghosts retirés le 2026-08-31 (#3322)

- `tests/unit/services/roosync/FileLockManager.test.ts` — fichier supprimé par #1843 (dead code), exclusion restée
- `tests/unit/services/roosync/FileLockManager.diagnostic.test.ts` — idem

(Le config legacy `vitest.config.ts` contient encore ces 2 ghosts — hors périmètre du census CI,
non corrigé ici pour rester chirurgical.)

## Candidats à la réactivation

Exclusions **sans raison datée** — à re-auditer avant d'en ajouter de nouvelles :

1. **POWERSHELL (6)** — plateforme légitime (CI = ubuntu), mais rien n'empêcherait un job matrix
   Windows de les exécuter. Candidat « job dédié », pas réactivation simple.
2. **SMOKE + APPDATA/GDRIVE (8 restantes, toutes APPDATA)** — dépendance état réel GDrive : réactivation seulement
   derrière un flag d'env type `GDRIVE_INTEGRATION=1` (pattern déjà utilisé par
   `LLM_LIVE_INTEGRATION=1`). (`get-status.smoke` puis `machines.smoke` ont quitté cette liste le
   2026-10-03, `send.smoke`, `storage-management.smoke` (mock-based) puis `list-diffs.smoke` le
   2026-10-04, #2639 — les 5 fichiers smoke sont réactivés.)
3. **Inherited no-op (7)** — dont 3 sans raison documentée (parent-child-validation,
   skeleton-cache-reconstruction, workspace-filtering-diagnosis) : soit documenter la raison au niveau
   du config unit, soit rouvrir — en l'état elles sont invisibles pour la CI comme pour le run local.
4. **STRESS (1)** — seuils à re-calibrer ou à rendre proportionnels au hardware.

## Maintenance

Après toute modification du tableau `exclude` :

```bash
node scripts/count-ci-exclusions.mjs          # vérifier le nouveau compte + ghosts
# mettre à jour : header du config + README table + ce census (3 mêmes chiffres)
npx vitest run tests/unit/ci-exclusion-drift-guard.test.ts --config vitest.config.ci.ts
```
