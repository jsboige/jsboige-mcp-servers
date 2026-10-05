# Recensement des exclusions CI — `vitest.config.ci.ts`

**Dernier audit :** 2026-10-05 (#2639 réactivation)
**Mesure canonique :** `node scripts/count-ci-exclusions.mjs` (script, jamais à la main)
**Drift-guard :** `tests/unit/ci-exclusion-drift-guard.test.ts` — échoue si le header du config dérive ou si une entrée ghost apparaît

---

## Mesures canoniques

| Mesure | Valeur (2026-10-05) | Méthode |
|---|---|---|
| **Entrées fichiers de test déclarées** | **20** | parse du tableau `exclude` du config |
| **Globs répertoires de tests déclarés** | **4** | idem |
| Entrées structurelles (node_modules/build/dist/backups) | 9 | idem — hygiène, pas des exclusions de tests |
| Fichiers effectivement non collectés en CI (vs run local) | **11** | `node scripts/count-ci-exclusions.mjs --collect` (diff `vitest list` unit vs CI) |
| Tests sautés en CI (vs run local) | **240** | idem |

**Pourquoi deux nombres.** Le compte *déclaré* ne change que quand on édite le config — c'est lui que le
drift-guard verrouille et que les docs citent. Le compte *effectif* (11 fichiers / 240 tests) dépend
aussi des patterns `include` et du contenu des fichiers (ex. `dashboard-llm-live` collecte 0 test sans
`LLM_LIVE_INTEGRATION=1`) : il dérive sans toucher au config, donc il n'est pas gardé et se mesure à la
demande via `--collect`. **Contrôle croisé de cette tranche** : 363 − 328 = **35** tests et
16 − 14 = **2** fichiers, soit exactement les 12 + 23 tests des deux fichiers réactivés.

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
**#2639 (2026-10-04, 6e réactivation — audit des 8 entrées restantes) :** les 8 entrées ont été
**mesurées une par une**, en levant l'exclusion et en exécutant le fichier sous `vitest.config.ci.ts`
(la config qui fait autorité — pas `vitest.config.ts`, dont le verdict diffère). **2 réactivées** :
`baseline.integration.test.ts` (12/12) et `diagnose.integration.test.ts` (23/23) — elles routent
`ROOSYNC_SHARED_PATH` vers un tmpdir **`mkdtemp(os.tmpdir())` monté en `beforeAll`** (racine hors
arbre du dépôt ; `baseline.integration` l'avait déjà, `diagnose.integration` l'a reçue du fix #1355
— le census disait « déjà … en `beforeEach` », inexact des deux côtés), ne portent **aucune**
référence APPDATA/GDrive/chemin Windows (grep
`APPDATA|process.platform|win32|C:\|G:\|RooStorageDetector|globalStorage` → **0 hit** sur les deux, et
sur **11 des 12** `*.integration.test.ts` de `src/tools/roosync/__tests__/` — le 12ᵉ,
`mcp-management.integration.test.ts`, est le seul à toucher `process.env.APPDATA` et il **n'est pas
exclu`) et créent elles-mêmes leurs répertoires de fixture (hors arbre du dépôt, via `mkdtemp`) :
l'exclusion blanket du 2026-07-26 était périmée, même classe que les SMOKE.
**Les 6 autres restent exclues, chacune pour une raison MESURÉE** (section dédiée ci-dessous) — la
catégorie « APPDATA/GDRIVE » ne décrivait correctement **aucune** des trois qui y figuraient →
**23 entrées**. **#2639 (2026-10-05, 7e réactivation) :** `decision.integration.test.ts` réactivé —
le fichier `D` de 0 octet du CWD était un **flux ADS NTFS** : le nom de backup pré-fix conservait le
`:` du lecteur (`D:_dev_…json` = flux porté par un fichier de base `D`), et le `copyFileSync(…, 'D')`
du restore copiait ce `D` vide dans le CWD (root-cause #1358 : nom déterministe, restauration pilotée
par manifeste). Mesuré 28/28 verts sous config CI sur Windows — la plateforme **native** du flux ADS,
donc le cas défavorable — sans aucun `D` avant ni après → **22 entrées**. **#2639 (2026-10-05, 8e réactivation) :**
`config.integration.test.ts` réactivé — l'unique rouge (`apply_profile` « profile not found ») tenait à
ce que la branche source-locale résout `model-configs.json` via **`InventoryService`** (inventaire frais
de la machine réelle), pas via le `getSharedStatePath` mocké : vert **par accident** sur les machines
qui ont le fichier, rouge une branche plus tôt ailleurs. Correctif : inventaire épinglé sur le tmpdir
(spy prototype) + fixture `model-configs.json` + racine fixtures déplacée **hors arbre** (`mkdtemp`,
classe #1355) — rouge d'abord puis 41/41 mesurés sous config CI → **21 entrées**. **#2639 (2026-10-05, 9e réactivation) :**
`tests/unit/tools/roosync/baseline.test.ts` réactivé — entrée **mal catégorisée** dès l'origine (tests de
schéma purs, zéro référence APPDATA/GDrive). Les 2 rouges passaient au schéma vivant exactement ce
qu'il refuse depuis **#4001** : des sources `baseline-v*` (tags Git), rejetées car restore-from-tag non
supporté (#2983 — le contenu baseline vit sur GDrive). Tests réalignés sur des chemins
`sync-config.ref.backup.*` + un nouveau cas **assertant le rejet** `baseline-v*` (21 tests) → **20 entrées**.

---

## Les 20 entrées fichiers de test

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

### Plateforme (PowerShell) / état-dépendant / schéma périmé — 3 entrées

Ces trois entrées **ne dépendent pas de GDrive** : le libellé de section « APPDATA/GDRIVE » ne
décrivait correctement **aucune** d'elles. Chacune porte une raison propre, **mesurée le 2026-10-04**
(#2639, tranche 6) en levant son exclusion et en exécutant le fichier **sous `vitest.config.ci.ts`**
— la config qui fait autorité (le verdict sous `vitest.config.ts` diffère et ne vaut pas).
*(`decision.integration`, `config.integration` puis `baseline.test` ont quitté cette section le
2026-10-05, 7e-9e réactivations #2639 — voir historique.)*

| Entrée | Tests | Raison mesurée (2026-10-04) |
|---|---|---|
| `src/tools/roosync/__tests__/refresh-dashboard.integration.test.ts` | 13 — **13 rouges** | Dépendance **plateforme dure** : le tool shell vers `pwsh -NoProfile -ExecutionPolicy Bypass -c "& .../scripts/roosync/generate-mcp-dashboard.ps1"` (`refresh-dashboard.ts` **l.161**). CI = `ubuntu-22.04`. **Seule** entrée dont le label « platform-dependent » était exact. |
| `src/tools/roosync/__tests__/compare-config.integration.test.ts` | 39 — **3 rouges** | Le bloc « environment variables checking (#495) » filtre les diffs sur la sous-chaîne `manquante`, qui matche **aussi** le libellé de `checkRosterPartitionDrift()` (« manquantes du roster », `compare-config.ts` **l.2010/2031**) — or ce drift dérive de `service.loadDashboard()`, donc de l'**état partagé réel**. Correctif = resserrer le filtre du test (`path.startsWith('env.')` + `severity`). |
| `src/tools/roosync/__tests__/dashboard-llm-live.integration.test.ts` | 0 (no-op) | Opt-in via `LLM_LIVE_INTEGRATION=1` (repro 502 #1578) — 0 test collecté sans la variable ; exclusion déclarative, **sans effet** sur le delta. |

**Constat transversal.** Les 7 fichiers d'intégration roosync ne référencent **aucun** chemin Windows
ni GDrive en propre : la catégorie « APPDATA/GDRIVE » héritée du 2026-07-26 décrivait une dépendance
**indirecte** qui n'existe plus après les réécritures #564/#815. C'est elle qui avait aussi masqué le
caractère périmé de **7 exclusions** (les 5 SMOKE des tranches 3-5 et les 2 intégrations réactivées
ici) : le label de section a été renommé d'après les raisons **mesurées**, et non conservé par inertie.

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

**Total déclaré : 6+0+3+7+1+1+1+1 = 20 · effectif : mesure 2026-10-05 post-#2639 (`--collect`) — 11 fichiers / 240 tests**

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
2. **Plateforme / état-dépendant / schéma périmé (3)** — **mesurées** le 2026-10-04 (#2639, tranche 6),
   chacune avec son correctif identifié (section dédiée ci-dessus). Aucune n'est un candidat tmpdir :
   `refresh-dashboard` restera Windows-only (→ job matrix, avec les 6 POWERSHELL) ·
   `compare-config` (3 tests rouges) un filtre resserré ·
   `dashboard-llm-live` est un no-op (opt-in `LLM_LIVE_INTEGRATION=1`).
   (`decision.integration`, `config.integration` puis `baseline.test` ont été réactivées le
   2026-10-05 — 7e-9e réactivations #2639 ; la 10e, `compare-config`, attend le merge de #1363
   comme décidé au dispatch c0100.)
   **SMOKE est clos** : les 5 fichiers smoke ont été réactivés (2026-10-03/04, #2639), et plus aucune
   entrée de cette catégorie ne dépend réellement de GDrive.
3. **Inherited no-op (7)** — dont 3 sans raison documentée (parent-child-validation,
   skeleton-cache-reconstruction, workspace-filtering-diagnosis) : soit documenter la raison au niveau
   du config unit, soit rouvrir — en l'état elles sont invisibles pour la CI comme pour le run local.
4. **STRESS (1)** — seuils à re-calibrer ou à rendre proportionnels au hardware.

## Leçon de méthode (2026-10-04, #2639 tranche 6)

**Mesurer sous la config qui fait autorité.** Un premier passage sous `vitest.config.ts` (racine,
« local dev ») rendait 5 fichiers verts ; sous `vitest.config.ci.ts` — qui **étend
`vitest.config.unit.ts`** — seuls 3 le sont. Les deux configs n'ont ni les mêmes `setupFiles`, ni les
mêmes `include` : un verdict rendu par la mauvaise pousse à lever une exclusion que la CI refusera.
**Exception à documenter, pas exclusion à poser** : quand un fichier n'est pas isolable, écrire la
raison *mesurée* (quelle assertion, quelle ligne) plutôt que de reconduire la catégorie héritée —
c'est la reconduction qui avait laissé 3 exclusions périmées sous un label « APPDATA ».

## Maintenance

Après toute modification du tableau `exclude` :

```bash
node scripts/count-ci-exclusions.mjs          # vérifier le nouveau compte + ghosts
# mettre à jour les 4 surfaces du même chiffre :
#   1. header de vitest.config.ci.ts
#   2. servers/roo-state-manager/README.md (table des configs)
#   3. README.md racine du submodule (2 emplacements : section CI + « Avant de committer »)
#   4. ce census
npx vitest run tests/unit/ci-exclusion-drift-guard.test.ts --config vitest.config.ci.ts
```
