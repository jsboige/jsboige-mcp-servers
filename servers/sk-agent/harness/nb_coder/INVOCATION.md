<!-- Canonical home is sk-agent: new harness fixes belong here, not in vllm. -->
<!-- Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1. -->
# nb_coder — invocation à la demande (#4832)

**Un seul contrat d'invocation** pour les trois workflows du harnais nb_coder.
Tout appelant — siège schedulé (po-2028, ai-01:vllm), agent MCP quelconque,
shell humain — passe par la même enveloppe et les mêmes presets : **un seul état**.

| Étape | Preset `call_agent` | Fonction plugin | Script sous-jacent |
|---|---|---|---|
| **spec** (prémâchage d'issue) | `nb-coder-spec` | `nb_coder_spec` | `issue_from_finding.py` |
| **code** (production) | `nb-coder-code` | `nb_coder_code` | `nb_coder_driver.py` (stages 0-5) |
| **audit** (vérification indépendante) | `nb-coder-audit` | `nb_coder_audit` | `nb_coder_verify.py` |

L'entrée canonique de tout : `nb_coder_invoke.py --step <spec|code|audit> --params '<JSON>'`
(les presets et l'outil MCP ne font que l'appeler). Il valide les paramètres contre
un **ensemble fermé** par étape, exécute le script, et rend **une seule ligne JSON** :

```json
{"step":"code","ok":true,"verdict":"built-executed-ok","exit":0,"issue":26997,
 "notebook":"MyIA.AI.Notebooks/Physique/X.ipynb","pr":27123,
 "pr_url":"https://github.com/jsboige/CoursIA/pull/27123",
 "trace":"D:/vllm/.tmp/nbcoder/issue-26997.json","seconds":412.3,
 "command":["...","nb_coder_driver.py","--issue","26997","..."],"tail":"..."}
```

`ok` résume le verdict ; `pr_url` n'existe qu'après un `--max-stage 5` livré.
Une valeur `refused:*` = la demande était mal formée ou un garde a refusé
(claim tenu par une autre lane, capacité, wiring) — **on ne relance pas** : on
rend l'enveloppe, l'arbitrage appartient à l'appelant.

## 1. Invocation par un agent MCP (la voie prescrite)

Tout client MCP du sk-agent **du siège qui porte le harnais** :

```
nb_coder_workflow(step="code", issue=26997,
                  notebook="MyIA.AI.Notebooks/Physique/X.ipynb",
                  params='{"repo":"D:/CoursIA","lane":"myia-ai-01:nb-coder","max_stage":2}',
                  timeout=3600)
```

Ou, depuis un tour de modèle (`call_agent`, preset par étape) :

```
call_agent(agent="nb-coder-code",
           prompt="issue 26997, notebook MyIA.AI.Notebooks/Physique/X.ipynb, repo D:/CoursIA, max_stage 2")
```

L'opérateur rend l'enveloppe telle quelle — verdict et URL de PR viennent du
harnais, jamais du modèle. Les presets vivent dans
`nb_coder_seat_entries.example.json` (même fichier que les variants constructeurs
`notebook-coder-*`) : **le schedulé et l'à-la-demande partagent exactement ces
entrées — il n'existe pas de second état.**

**Sièges sans harnais** (pas de checkout CoursIA / venv / clés) : l'outil rend
l'erreur typée `nb_coder_harness_unresolved` — jamais de run dégradé, jamais de
fallback silencieux. Invoquer depuis un siège porteur (ai-01, po-2028) ou
provisionner le siège (voir §4).

**Asymétrie de garde, voulue** (tranchage po-2028/po-2027, review ms#1820) :
les fonctions kernel `nb_coder_*` n'apparaissent que sur les agents qui
déclarent `parameters.nb_coder_tools` **et** la capacité `shell` ; l'outil
serveur `nb_coder_workflow`, lui, n'a **aucune garde** — tout client MCP du
siège porteur peut l'invoquer jusqu'à `max_stage 5`. C'est le mandat (#4832,
user 18/11 : workflows « librement invocables à la demande par tous les agents
munis du MCP sk-agent »). Le gate `shell` ne protège pas l'accès au harnais :
il protège la **liste de fonctions du modèle** (un agent sans capacité
d'exécution ne voit jamais les fonctions kernel) ; les credentials restent
côté serveur (`NBCODER_*`), et les gardes qui comptent — claims, ensembles
fermés, refus typés — vivent dans le harnais lui-même, identiques pour les
deux voies.

## 2. Paramètres (ensembles fermés)

Une clé hors ensemble = refus `refused:unknown ... param(s)`. Types : `int`,
`bool`, `str`. Jamais de secret dans les params — **les clés passent par
l'environnement** (`NBCODER_GH_APP_ID`, `NBCODER_GH_KEY`, `NBCODER_LANE`, …),
hérité tel quel.

### spec — brouillon d'issue depuis un finding d'audit (déterministe, 0 token)

| clé | requis | sens |
|---|---|---|
| `record` | ✔ | chemin du JSON d'enregistrement nb_audit |
| `notebook` | ✔ | chemin du carnet, relatif au dépôt |
| `ref` | ✔ | SHA que l'audit a lue |
| `out` | — | fichier de sortie du brouillon (défaut : stdout) |

Sortie : `verdict=draft-produced`, `draft_chars`, `draft` (chemin si `out`).
Le brouillon doit être **relu par la lane** avant création de l'issue (garde
qualité anti-faux-positifs, pilote 09-22).

### code — production issue → carnet → PR

| clé | requis | sens |
|---|---|---|
| `issue` | ✔ (int) | numéro de l'issue CoursIA |
| `notebook` | ✔ | carnet cible, relatif au dépôt (ou cible de création avec `source_nb`) |
| `repo` | ✔* | chemin du checkout CoursIA (*ou `NBCODER_REPO` env) |
| `source_nb` | — | mode création : jumeau Python source du carnet |
| `lane` | —* | identité de claim `<machine>:nb-coder` (*exigée avec `claim`) |
| `claim` | — (bool) | poste le `[CLAIMED]` sur l'issue |
| `max_stage` | — (int 0-5) | 0 claim+issue · 1 plan · 2 build/exec (défaut) · 3 gates · 4 verify · 5 PR |
| `agent` | — | preset constructeur (défaut `notebook-auditor` ; variants `-luna/-minimax/-haiku`) |
| `verifier_agent` | — | preset vérificateur (défaut `critic` — modèle DIFFÉRENT du constructeur) |
| `write_mode` | — | `json` (défaut, 1 écriture harnais) · `mcp` (outils papermill, aléa) |
| `exec_mode` | — | `auto` (défaut) · `all` · `plan` |
| `gate_mode` | — | `warn` (défaut) · `block` · `off` (capacité gérée côté serveur) |
| `grain_tier` | — | `SM` · `LARGE` |
| `out_dir` / `worktree` / `fresh_worktree` | — | scratch du run |
| `conventions` / `intention` | — | règles maison / texte de claim |
| `timeout` / `max_tokens` / `verify_timeout` / `repair_rounds` | — (int) | budgets |
| `pr_base` / `pr_repo` / `pr_branch` / `allow_foreign_origin` | — | gardes GitHub |

Verdicts `ok` : `built-executed-ok`, `gates-ok`, `stage0-only`, `stage1-only`,
`verify-approved`, `pr-created`. Sous `max_stage 5` le run est **sec** : ni
branche, ni commit, ni push, ni PR.

### audit — vérification indépendante (producteur ≠ vérificateur)

| clé | requis | sens |
|---|---|---|
| `issue` | ✔ (int) | numéro de l'issue |
| `source_nb` | ✔ | carnet d'origine (origin/main) |
| `built_nb` | ✔ | livrable produit par le harnais |
| `facts` | — | trace JSON du constructeur (contre-vérification des claims) |
| `agent` | — | preset vérificateur (défaut `critic`) |
| `out_dir` / `timeout` / `max_tokens` | — | scratch / budgets |

Verdicts : `approve` (ok=true) · `reject` · `error:*` avec
`instrument_error=true` — **une erreur d'instrument n'est JAMAIS un rejet**.

## 3. Exemple bout-en-bout

```bash
# 1. spec — brouillon depuis le finding d'audit (relire avant création !)
d:/roo-extensions/mcps/internal/servers/sk-agent/venv/Scripts/python.exe \
  harness/nb_coder/nb_coder_invoke.py --step spec \
  --params '{"record":"D:/records/nb-26997.json","notebook":"MyIA.AI.Notebooks/Physique/X.ipynb","ref":"abc1234"}'

# 2. après création de l'issue (n° 26997), code — dry d'abord
... nb_coder_invoke.py --step code --params '{"issue":26997,
  "notebook":"MyIA.AI.Notebooks/Physique/X.ipynb","repo":"D:/CoursIA",
  "lane":"myia-ai-01:nb-coder","max_stage":2}'

# 3. livraison — max_stage 5 + claim
... nb_coder_invoke.py --step code --params '{"issue":26997,
  "notebook":"MyIA.AI.Notebooks/Physique/X.ipynb","repo":"D:/CoursIA",
  "lane":"myia-ai-01:nb-coder","max_stage":5,"claim":true}'
# → enveloppe : verdict=pr-created, pr=27123, pr_url=https://github.com/jsboige/CoursIA/pull/27123
```

Le même chemin par MCP depuis n'importe quel agent du siège :
`nb_coder_workflow(step="code", issue=26997, params='{...}')`.

## 4. Prérequis du siège porteur

- checkout **roo-extensions** avec sous-module `mcps/internal` peuplé (le home
  canonique `servers/sk-agent/harness/nb_coder/` en découle) ;
- le **venv sk-agent** (porte `mcp`, `semantic_kernel`) ;
- un **checkout CoursIA** (`repo`, entrée du run — jamais une liaison du harnais) ;
- **`gh`** authentifié pour claim/PR (stages 0 et 5) — REST uniquement ;
- le MCP **jupyter-papermill** installé (`NBCODER_PM_PY` / `NBCODER_PM_CWD`,
  défaut : layout sibling) ;
- clés GitHub App dans l'**environnement** : `NBCODER_GH_APP_ID`, `NBCODER_GH_KEY`
  — jamais dans les params, jamais dans les corps ;
- `NBCODER_LANE` ou le param `lane` : le refus sans identité est voulu (F1/vllm#438).

Variables de wiring (`NBCODER_SK_DIR/SK_PY/SK_CONFIG`, `NBCODER_GATE`,
`NBCODER_ENGINE_METRICS`, `NBCODER_KERNEL_MAP`, `SK_AGENT_NB_CODER_HOME`) :
résolution sibling par défaut, surchargeables — détail dans `harness/README.md`.

## 5. Schedulé vs à-la-demande — un seul état

- **po-2028 (MiniMax), ai-01:vllm (swift)** : le planificateur
  (`nb_coder_scheduler.py`, file JSONL de grains) appelle **les mêmes scripts
  sous le même wrapper** ; les presets constructeurs (`notebook-coder-*`)
  sont ceux du même fichier d'entrées.
- **À la demande** : l'outil MCP `nb_coder_workflow` / les presets
  `nb-coder-{spec,code,audit}` appellent le même `nb_coder_invoke.py`.
- Divergence interdite : toute nouvelle option du driver se fraie un chemin par
  l'ensemble fermé ci-dessus AVANT d'être utilisée ailleurs ; les tests
  (`test_nb_coder_invoke.py`, `test_nb_coder_plugin.py`,
  `test_nb_coder_entries.py`) pinne le contrat.

Produit par #4832 (mandat user 18/11). Product-owner du filon : CoursIA.

## 6. Témoin fenêtre 262 144 (#4816 critère 3)

`nb_coder_window_replay.py` n'est PAS une voie d'invocation : c'est
l'instrument de preuve du critère 3 de roo-extensions#4816. Il rejoue la
morphologie CoursIA#27027 (un tour, des rounds `update_cell` multi-Ko) sur
la VRAIE machinerie de tour (connecteur SK OpenAI sur HTTP réel, filtre de
tour réel, condenseur réel) contre un moteur local qui applique le contrat
de l'incident (262 144 jetons, 400 `context_length_exceeded`).

- `--mode both` : rouge (condensation absente → le tour meurt sur le 400
  réel, à l'échelle de l'incident ~1,0 M car.) puis vert (contrat
  condensation des entrées de siège → tour complet, sous fenêtre) ;
- `--live-probe --base-url … --api-key-env … --model …` : UNE requête
  volontairement hors-fenêtre contre un moteur réel, pour pincer le
  contrat modelé contre le vrai (jamais en test).

Le verdict JSON (`replay_report`) est la pièce jointe de l'issue ; les
assertions vivent dans `test_nb_coder_window_replay.py` (CI).
