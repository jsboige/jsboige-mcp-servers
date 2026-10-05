# Recensement des exclusions CI — `vitest.config.ci.ts`

**Dernier audit :** 2026-10-05 (#2639 réactivation)
**Mesure canonique :** `node scripts/count-ci-exclusions.mjs` (script, jamais à la main)
**Drift-guard :** `tests/unit/ci-exclusion-drift-guard.test.ts` — échoue si le header du config dérive ou si une entrée ghost apparaît

---

## Mesures canoniques

| Mesure | Valeur (2026-10-05) | Méthode |
|---|---|---|
| **Entrées fichiers de test déclarées** | **9** | parse du tableau `exclude` du config |
| **Globs répertoires de tests déclarés** | **4** | idem |
| Entrées structurelles (node_modules/build/dist/backups) | 9 | idem — hygiène, pas des exclusions de tests |
| Fichiers effectivement non collectés en CI (vs run local) | **8** | `node scripts/count-ci-exclusions.mjs --collect` (diff `vitest list` unit vs CI) |
| Tests sautés en CI (vs run local) | **175** | idem |

**Pourquoi deux nombres.** Le compte *déclaré* ne change que quand on édite le config — c'est lui que le
drift-guard verrouille et que les docs citent. Le compte *effectif* (8 fichiers / 175 tests) dépend
aussi des patterns `include` et du contenu des fichiers (ex. `dashboard-llm-live` collecte 0 test sans
`LLM_LIVE_INTEGRATION=1`) : il dérive sans toucher au config, donc il n'est pas gardé et se mesure à la
demande via `--collect`. **Contrôle croisé (12e réactivation, mesuré)** : 9 − 8 = **1** fichier et
188 − 175 = **13** tests, soit exactement l'entrée `skepticism-protocol` réactivée — ses 13 tests sont
désormais **collectés puis skipés** en CI submodule autonome (`describe.skipIf` parent absent) et
**exécutés** partout où le parent est présent, y compris la CI parent qui checkoute le submod dans
`mcps/`. **Suite CI complète sur la même tête** : 784 fichiers passés + 4 skipés (788), 14 981 tests
passés + 45 skipés (15 029 collectés), **0 échec** — le delta vs la tête précédente (+1 fichier skipé,
+13 tests skipés, +13 collectés) est exactement `skepticism-protocol`.

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
**#2639 (2026-10-05, 10e réactivation) :** `compare-config.integration.test.ts` réactivé — les 3 rouges
partageaient **une seule cause racine, mal diagnostiquée par la tranche 6**. Ce n'était pas un comptage
attrapé par la sous-chaîne `manquante` : la fixture roster #833 (`remote-machine,test-machine`) datait de
l'ère où `checkRosterPartitionDrift()` référençait le **dashboard**. Le check prend désormais le
**registre vivant** (`.machine-registry.json`, écrit dans le shared path au runtime — ici `test-machine`
seul) et ne retombe sur le dashboard que s'il manque (`compare-config.ts` l.1978-1987) → mismatch de
**taille 2 vs 1** → CRITICAL, dépendant de l'état. Resserrer le filtre (`path.startsWith('env.')` +
`severity`) **n'aurait rien corrigé** : le diff de drift EST `env.*` + CRITICAL, donc *dans* le prédicat
proposé. Correctif réel = aligner la fixture roster sur la référence registre (1 ligne) ; le drift émet
alors le signal INFO « consistant » que les tests assertent déjà — rouge d'abord 3/39 puis **39/39**
mesurés sous config CI → **19 entrées**. **#2639 (2026-10-05, 11e réactivation) :**
`refresh-dashboard.integration.test.ts` réactivé — deuxième correction de diagnostic consécutive.
L'entrée était étiquetée « dépendance plateforme dure, shell vers `pwsh` » : **faux**. Mesure en
clone **standalone** (la condition CI : aucun `CLAUDE.md` ancêtre, donc aucun dépôt parent) :
**13/13 rouges**, et la commande fautive le dit elle-même —
`pwsh … "& '<submodule>/servers/roo-state-manager/scripts/roosync/generate-mcp-dashboard.ps1'"`,
c'est-à-dire `pwsh` **exécuté** sur un **chemin de script inexistant**. Le shell n'est pas le
problème, l'artefact du **dépôt parent** l'est (`findRooExtensionsRoot()` l.23-46 retombe sur
`process.cwd()`). Correctif = mocker la **seule** frontière extérieure (`child_process.exec`,
l.114-119) en reproduisant le **contrat du script** (création de l'outputDir, écriture de
`mcp-dashboard.md`, stdout `Fichier: <chemin>`) : plus de `pwsh`, plus de dépôt parent. Le fichier
passe de 13 à **16 tests** (3 ajoutés : construction de la commande, échec du shell emballé, stdout
sans marqueur) et les métriques sont désormais assertées **exactes** (avant : `expect.any(Number)`),
ce que la fixture rend possible — mutation `✅`→`❌` dans le prédicat des métriques tuée par
exactement 1 test. Mesuré : 13/13 rouges standalone avant, **16/16 verts** après → **18 entrées**.
**#2639 (2026-10-05, 12e réactivation) :** `skepticism-protocol.test.ts` réactivé — **la dernière
entrée PARENT_REPO**. Ses 13 tests validaient le format de la règle du parent via
`resolve(__dirname, 7×'..')` : en checkout submodule autonome, le chemin clampe à la racine du lecteur
(`D:\.claude\rules\…` mesuré) → ENOENT, **13/13 rouges** (mesuré). Correctif = **détection explicite
du parent** (remontée jusqu'au répertoire portant à la fois `CLAUDE.md` et `mcps/` — même walk que
`findRooExtensionsRoot`) + `describe.skipIf` quand il est absent. Choix assumé : pas de fixture (une
copie vendue dans le submod testerait la copie, pas la règle — tautologie). Les 13 tests **tournent**
là où les fichiers vivent (dev imbriqué et **CI parent**, qui checkoute le submod dans `mcps/` — le
garde-fou de format redevient automatique précisément là) et se **skipent proprement** en CI submodule
autonome, jamais un rouge d'environnement. Mesuré : 13/13 rouges standalone avant ; 13 skipés / 0 échec
standalone après (config CI) ; **13/13 verts** dans le checkout parent (config locale, même instrument
que le rouge d'abord) → **17 entrées**, effectif **8 fichiers / 175 tests**.
**#2639 (2026-10-05, 13e passe — hygiène + 3 réactivations) :** les **8 entrées no-op** retirées du
config CI (5 doublons du config unit — le merge `mergeConfig` **concatène** les excludes, la
re-liste n'excluait rien de plus ; 2 fichiers `tests/integration` hors `include` ; 1 doublon du glob
`**/_archives/**` du config unit). **3 réactivations dans la foulée** (retrait du config unit, le
vrai locus) : `parent-child-validation` (6 tests), `skeleton-cache-reconstruction` (6) et
`workspace-filtering-diagnosis` (3) — verdict mesuré sous `vitest.config.ci.ts` : **15/15 verts**,
l'exclusion datait d'avant les réécritures. `FileLockManager.simple` et `PresenceManager.integration`
restent exclues **au config unit** (raison #307 proper-lockfile/threads — documentée là) →
**9 entrées** CI déclarées. **Mesures** : suite CI complète sur la tête — **787 fichiers passés +
4 skipés (791), 14 996 tests passés + 45 skipés (15 044 collectés), 0 échec** (delta vs tête 12e :
+3 fichiers, +15 tests — exactement les 3 réactivations) ; drift-guard 4/4. **Note de lecture** : le
delta *effectif* (`--collect`, 8 fichiers / 175 tests) est **inchangé** — les 3 fichiers sont
désormais collectés **des deux côtés** (ils sortent de l'ensemble exclu, pas du delta unit-vs-CI) ;
c'est la suite exécutée, pas le delta, qui porte la preuve des réactivations.

---

## Les 9 entrées fichiers de test

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

### État-dépendant / opt-in — 1 entrée

Cette entrée **ne dépend pas de GDrive** : le libellé de section « APPDATA/GDRIVE » ne la décrivait
pas. Elle porte sa raison propre, **mesurée le 2026-10-04** (#2639, tranche 6) en levant son
exclusion et en exécutant le fichier **sous `vitest.config.ci.ts`** — la config qui fait autorité
(le verdict sous `vitest.config.ts` diffère et ne vaut pas).
*(`decision.integration`, `config.integration`, `baseline.test`, `compare-config.integration` puis
`refresh-dashboard.integration` ont quitté cette section le 2026-10-05 — 7e-11e réactivations #2639,
voir historique.)*

| Entrée | Tests | Raison mesurée |
|---|---|---|
| `src/tools/roosync/__tests__/dashboard-llm-live.integration.test.ts` | 0 (no-op) | Opt-in via `LLM_LIVE_INTEGRATION=1` (repro 502 #1578) — 0 test collecté sans la variable ; exclusion déclarative, **sans effet** sur le delta. |

**Correction de diagnostic (11e réactivation).** `refresh-dashboard.integration.test.ts` figurait
ici comme « **plateforme dure** … seule entrée dont le label "platform-dependent" était exact ».
**C'est faux, et mesuré faux** : `pwsh` n'est pas en cause — il s'exécute (Windows local *et*
runner ubuntu). Ce qui manque est le **script du dépôt parent**
(`scripts/roosync/generate-mcp-dashboard.ps1`). `findRooExtensionsRoot()`
(`refresh-dashboard.ts` l.23-46) remonte l'arbre à la recherche d'un `CLAUDE.md` ; dans un
checkout **submodule autonome** (la CI) il n'en trouve aucun, retombe sur `process.cwd()`
(= `servers/roo-state-manager`) et vise donc un script inexistant. Rouge d'abord mesuré en clone
standalone : **13/13** `Command failed: pwsh …\roo-state-manager\scripts\roosync\generate-mcp-dashboard.ps1`.
**Classe réelle = PARENT_REPO** (même famille que `skepticism-protocol`), pas plateforme —
la plateforme est un faux prédicat : un checkout Windows *standalone* échouerait à l'identique.

**Constat transversal.** Les 7 fichiers d'intégration roosync ne référencent **aucun** chemin Windows
ni GDrive en propre : la catégorie « APPDATA/GDRIVE » héritée du 2026-07-26 décrivait une dépendance
**indirecte** qui n'existe plus après les réécritures #564/#815. C'est elle qui avait aussi masqué le
caractère périmé de **7 exclusions** (les 5 SMOKE des tranches 3-5 et les 2 intégrations réactivées
ici) : le label de section a été renommé d'après les raisons **mesurées**, et non conservé par inertie.

### Inherited (doublons du config unit / hors include) — 0 entrée (13e passe, #2639)

*(Les 7 doublons no-op ont été retirés du config CI le 2026-10-05 : le merge **concatène** les
excludes du config unit, la re-liste n'excluait rien de plus. Les 2 fichiers `tests/integration`
restent hors `include` (jamais collectés, aucune entrée nécessaire). **3 des 5 fichiers exclues au
config unit ont été réactivées** — retrait du config unit aussi, verdict 15/15 verts sous config CI
(voir historique 13e passe). `FileLockManager.simple` et `PresenceManager.integration` restent
exclues au config unit, raison #307 proper-lockfile/threads documentée à cet endroit.)*

### ARCHIVES — 0 entrée fichier (13e passe, #2639)

*(L'entrée `BaselineService.ci-excluded.test.ts` était un doublon du glob `**/_archives/**` du
config unit — retirée ; le fichier reste couvert par le glob, superseded par la version
`src/services/__tests__` (#1143).)*

### PARENT_REPO — 0 entrée (dernière réactivée, #2639 12e)

*(`skepticism-protocol.test.ts` réactivé le 2026-10-05 : détection du parent par remontée
`CLAUDE.md`+`mcps/` + `skipIf` standalone — les 13 tests s'exécutent en dev imbriqué et en **CI
parent** (le submod y est checkouté dans `mcps/`, donc le parent est présent), se skipent en CI
submodule autonome. La famille PARENT_REPO n'a plus **aucune** entrée déclarée :
`refresh-dashboard` l'a quittée par mock de frontière shell (11e), `skepticism-protocol` par skip
conditionnel (12e).)*

### LIVE SERVICES — 1 entrée, effective (6 tests)

| Entrée | Tests | Raison |
|---|---|---|
| `src/tools/search/__tests__/search-live.integration.test.ts` | 6 | requiert Qdrant + service d'embeddings vivants |

### STRESS — 1 entrée, effective (10 tests)

| Entrée | Tests | Raison |
|---|---|---|
| `src/tools/roosync/__tests__/stress-large-inbox.test.ts` | 10 | seuils de timing dépendants du hardware (16 GB RAM, `--maxWorkers=1`) |

**Total déclaré : 6+0+1+0+0+0+1+1 = 9 · effectif : mesure 2026-10-05 post-#2639 13e (`--collect`) — 8 fichiers / 175 tests (inchangé, cf. note dans l'historique 13e)**

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

(Retirés du config legacy `vitest.config.ts` le 2026-10-05, repli #2639 — `vitest list` avant/après
identique, exclusion d'un fichier absent = no-op. Le bloc `ci:` mort du même config liste encore
2 autres ghosts — `PresenceManager.test.ts`, `file-lock-manager-integration.test.ts` — mais ce bloc
n'est jamais lu par vitest : clés top-level inconnues ignorées, nettoyable dans un grain futur.)

## Candidats à la réactivation

Exclusions **sans raison datée** — à re-auditer avant d'en ajouter de nouvelles :

1. **POWERSHELL (6)** — plateforme légitime (CI = ubuntu), mais rien n'empêcherait un job matrix
   Windows de les exécuter. Candidat « job dédié », pas réactivation simple.
2. **État-dépendant / opt-in (1)** — `dashboard-llm-live` est un no-op (opt-in
   `LLM_LIVE_INTEGRATION=1`) : exclusion déclarative sans effet sur le delta, ni à réactiver ni à
   retirer sans décision d'hygiène (cf. § Hygiène).
   (`decision.integration`, `config.integration`, `baseline.test`, `compare-config.integration`,
   `refresh-dashboard.integration` puis `skepticism-protocol` ont été réactivées le 2026-10-05 —
   7e-12e réactivations #2639. `refresh-dashboard` était classé « plateforme dure » :
   **diagnostic corrigé**, cf. section dédiée — sa vraie classe est PARENT_REPO, et le correctif est
   le mock de la frontière shell ; `skepticism-protocol` l'a suivie par skipIf conditionnel — la
   famille PARENT_REPO est vide.)
   **SMOKE est clos** : les 5 fichiers smoke ont été réactivés (2026-10-03/04, #2639), et plus aucune
   entrée de cette catégorie ne dépend réellement de GDrive.
3. **Inherited no-op (7)** — **clos le 2026-10-05 (13e passe)** : les 7 doublons retirés du config
   CI ; les 3 sans raison documentée (parent-child-validation, skeleton-cache-reconstruction,
   workspace-filtering-diagnosis) ont été **réactivées** (15/15 verts sous config CI), les 2 #307
   restent exclues au config unit avec leur raison, les 2 `tests/integration` restent hors `include`.
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
