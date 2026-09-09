# Claude Settings Harmonization — `~/.claude/settings.json` (#3545)

> Couverture collect/publish/apply/compare du picker Claude Code + primitive
> campagne d'harmonisation flotte avec suivi de confirmations. Implémenté pour
> l'issue roo-extensions#3545. **Canon réel non épinglé** : toutes les fonctions
> sont testées sur fixtures fictives ; aucun rollout réel n'a eu lieu.

## Le problème résolu

1. **La cible n'était pas couverte.** `~/.claude/settings.json`
   (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_{TIER}_MODEL`, suffixes `[1m]`,
   fenêtre de compaction) n'apparaissait dans aucune granularité — c'est
   pourtant le sujet de tous les mandats d'harmonisation (#543, #926, #3240).
2. **La comparaison fabriquait des diffs fantômes.** Un « published » sans la
   section rendait 80 `present_absent` identiques sur deux cibles différentes :
   la sortie *ressemblait* à une divergence massive mais ne mesurait rien.
3. **La campagne n'existait pas.** Harmoniser = N dispatchs + N confirmations
   + re-détection de drift, le tout en archéologie de DM.

## Surface

### `roosync_config` — target `claude-settings`

| Action | Comportement |
|---|---|
| `collect` | Lit le fichier local, produit un **snapshot masqué** `claude-settings/claude-settings.json` (état du fichier, projection harmonisation, digests des clés env sensibles, **noms** des autres clés top-level). |
| `publish` | Publie le snapshot dans `{shared}/configs/{machineId}/…` (workflow collect+publish atomique standard). |
| `apply` | **Uniquement** depuis un `claude-settings/canon.json` explicite (voir sécurité). Un snapshot de comparaison est **rejeté** comme payload d'apply. Jamais appliqué implicitement via apply-all. |

Chemin du fichier résolu : `CLAUDE_SETTINGS_PATH` (env) → `~/.claude/settings.json`.

### `roosync_compare_config` — granularity `claude-settings`

Compare source (live si machine locale, sinon dernier snapshot publié) vs
cible (snapshot publié, ou live si la cible est la machine locale).

**Garde de couverture** (plus de diffs fantômes) — selon l'état de chaque côté :

| État du côté | Signifié | Sortie |
|---|---|---|
| `no-snapshot` | aucun snapshot publié | 1 diff WARNING « non couvert », **zéro** diff de clé |
| `invalid` | fichier source illisible (snapshot ou live) | 1 diff CRITICAL, zéro diff de clé |
| stale dur (>30 j, `CLAUDE_SETTINGS_STALE_HARD_DAYS`) | baseline périmée | 1 diff WARNING « non couvert » |
| stale soft (7–30 j, `CLAUDE_SETTINGS_STALE_WARN_DAYS`) | baseline vieillissante | 1 diff INFO + diffs de clé émis (mesurés contre ce snapshot) |
| `missing` / `empty` observés | **vérité mesurée** (le fichier existe et est vide/absent) | 1 diff INFO d'observation + diffs de clé véridiques |

Les **exemptions des campagnes actives** (`harmonization/campaigns/*.json`
`status: "active"`) sont honorées, avec **provenance** : les chemins exemptés
d'une machine ne comptent pas comme drift, sauf s'ils sont requis par le canon
d'une autre campagne (conflit exposé, diff conservé). Secrets jamais exposés :
seuls les chemins allow-listés entrent dans le diff (les clés sensibles n'y
figurent pas), et les `*_BASE_URL` y sont redactées des credentials.

La granularité `settings` (Roo state.vscdb) reçoit la même garde : un côté
absent/illisible de la baseline rend un statut « non couvert » au lieu de
N diffs `present_absent` (fix du 80/80 mesuré le 08/09).

### `roosync_harmonization` — campagne

```
create   → canon {version, mode, keys} + fleet ["machine"|"machine:workspace"] [+ exceptions {machine: [chemins]}]
dispatch → DM par destinataire (idempotent, force=true pour renvoyer)
apply    → applique le canon au settings LOCAL uniquement (dry_run supporté)
confirm  → RELIT le settings local en live, atteste le hash observé (refusé sur campagne fermée)
remind   → relance les non-confirmés (cooldown 12 h par défaut, idempotent)
status   → par machine : confirmation + alignment (aligned/drifted/no-snapshot/…) en UN appel
list     → campagnes (actives par défaut)
close    → refusé tant que toute la flotte n'a pas confirmé (force+reason requis sinon)
```

ID de campagne : `hc-claude-settings-{version}` — **le canon est immuable** :
re-créer la même version est une erreur (`CANON_IMMUTABLE`) ; changer le canon
= bump de version = nouvelle campagne (les confirmations de l'ancienne
restent liées à son hash).

## Sécurité (décisions de conception)

- **Allow-list stricte** (`ALLOWED_KEY_PATHS`, `ClaudeSettingsService.ts`) :
  `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`,
  `env.ANTHROPIC_CUSTOM_MODEL_OPTION`, `env.ANTHROPIC_SMALL_FAST_MODEL`,
  `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
  `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `env.API_TIMEOUT_MS`, `env.MCP_TIMEOUT`,
  `env.MCP_TOOL_TIMEOUT`, `model`, `modelMap.{opus,sonnet,haiku,fable}`.
  Tout le reste (permissions, hooks, apiKeyHelper, clés sensibles) est hors
  périmètre : jamais appliqué, jamais publié en clair, jamais compté dans un diff.
- **Valeurs de canon validées** : scalaires uniquement ; patterns secrets
  rejetés (`sk-`, `ghp_`, hex-64, `BEGIN PRIVATE KEY`, `Bearer`, `token=…`) ;
  les `*_BASE_URL` doivent être http(s), sans credentials inline, sans query à
  paramètre suspect (fail-closed : `key`/`token`/`secret`/`signature`/
  `password`/`credential` **et** `auth`/`sig`/`api_key`/`apikey`/`x-api-key`/
  `access_key`/`access_token`/`private_key`/`session`/`nonce`/`bearer`).
  `modelMap.*` est couvert **par tier** (chemin point
  scalaire) — un objet `modelMap` opaque est rejeté (scalaires uniquement).
- **Redaction à la frontière d'observation** (`redactValue`) : une `*_BASE_URL`
  est scrubée (userinfo → `<credentials:sha256=…>`, valeur de query sensible →
  `<redacted:sha256=…>`) dans le snapshot ET l'affichage de compare — jamais le
  raw, y compris pour une URL malformée (digest complet). L'empreinte est
  **non réversible** (sha256, sens unique) mais **discriminante** : deux
  credentials DIFFÉRENTS sur le même host/path produisent deux marqueurs
  différents — compare_config voit la divergence (cohérent avec `confirm()`),
  la redaction ne fabrique NI conformité NI alignement. La redaction est
  **idempotente** et préserve le path/order d'origine (ne normalise pas
  `https://h` en `https://h/`). Le côté live local est redacté comme le
  snapshot : une machine comparée à son propre snapshot ne voit pas de faux
  diff. La détection des query sensibles se fait **sur le nom, par MOT ENTIER**
  (revue passe 3 + frontières lettre↔chiffre passe 4) : `auth`, `sig`,
  `api_key`, `x-api-key`, `access_token`, `secretKey`, `myAuthToken`, et les
  suffixés numériques `token2`/`key2`/`apikey2`/`sig2`/`auth0`… sont couverts
  (frontières : séparateurs non alphanumériques + camelCase + transitions
  lettre↔chiffre), tandis que `design`, `signal`, `author` — qui ne
  contiennent `sig`/`auth` que comme sous-chaîne — restent lisibles (suffixe
  numérique compris : `design2`, `signal1`, `author3`).
  `?auth=3f9b2c` (valeur courte qu'aucune heuristique de contenu ne détecte)
  est couverte par le NOM du paramètre.
- **Snapshot ≠ apply payload** : `apply` n'accepte que `canon.json` validé ;
  un snapshot est rejeté avec un message explicite.
- **ensure-present par défaut** : les choix existants de la machine (fenêtre,
  modèle, endpoint) sont préservés ; `enforce-value` écrase, sur demande
  explicite seulement. Les chemins exemptés de la machine sont skip.
- **Confirmation = preuve vivante** : la machine relit SON fichier et atteste
  le hash de sa projection restreinte au périmètre du canon (hors exemptions).
  Un `claimed_hash` fourni par l'appelant n'est **jamais** compté.
- **Apply défensif** : fail-closed sur fichier illisible, backup + relecture
  validée (restauration du backup si divergence), détection d'écriture
  concurrente (relecture pré-write), write atomique tmp+rename, UTF-8 sans
  BOM, dry-run sans aucun write ni backup.
- **Fail closed store** : campagne introuvable / racine shared absente =>
  erreur, jamais de mode dégradé.

## Concurrence — preuve participant immuable + mutations coordinator (défauts review #2/#3)

La conception d'écriture répond aux défauts relevés par la revue indépendante :

- **Preuve participant IMMUABLE (défaut #2).** Les confirmations et échecs ne
  sont plus un `read-modify-write` partagé dans le record de campagne : chaque
  événement est un fichier append-only à identifiant unique sous
  `{campaigns}/{id}/events/{machine}/{eventId}.json` (create exclusif `wx`,
  jamais réécrit). Deux confirmations simultanées — machines différentes OU
  sessions du même hôte — produisent deux événements disjoints ; aucune
  confirmation ne peut en effacer une autre.
- **Mutations coordinateur = propriétaire sauf (défaut #2), verrou RÉCUPÉRABLE
  À GAGNANT UNIQUE (revues passes 2+3).** `dispatch`, `remind`, `close` ne
  s'exécutent que si `createdBy === machineId` (sinon `NOT_OWNER`), sérialisées
  par un verrou exclusive-create local (`{campaigns}/{id}.lock`) portant
  `{owner, token, acquiredAt, expiresAt}`. **Politique de péremption
  explicite** (TTL `COORDINATOR_LOCK_TTL_MS`, 30 min) : un détenteur crashé
  (kill/OOM, jamais passé au `finally`) ne bloque plus indéfiniment. La
  **récupération est À GAGNANT UNIQUE** (revue passe 3) : le lock périmé est
  DÉTACHÉ par `rename` atomique vers une quarantaine
  `{id}.lock.stale-{tokenPérimé}` — un SEUL récupérateur gagne la course (les
  autres reçoivent ENOENT => refus `CONCURRENT_WRITE`), le gagnant VÉRIFIE le
  contenu détaché (un remplacement survenu dans la fenêtre est RESTAURÉ par
  `link` conditionnel, jamais supprimé) puis recrée le lock par `open 'wx'`
  (EEXIST => un tiers a pris la place => refus). Un unlink nu ou un
  tmp+rename laissaient l'entrelacement « le perdant supprime le lock frais
  du gagnant puis gagne à son tour » : deux détenteurs — entrelacement fermé
  par le rename-gate **pour la course simultanée testée**. Le **release ne
  supprime jamais le chemin vivant** (revue passe 3) : détachement vers une
  quarantaine à NOTRE token unique (`{id}.lock.rm-{token}`), vérification du
  détaché, suppression seulement si vérifié (fenêtre nulle : chemin unique
  par token) — un lock REMPLACÉ dans la fenêtre lecture→suppression est
  restauré par `link` conditionnel, jamais supprimé. Un lock frais => refus
  `CONCURRENT_WRITE`. **LIMITE EXPLICITE (revue passe 4)** : le protocole
  ferme la course simultanée testée sur un même hôte mais n'est **ni** un
  verrou distribué **ni** une garantie d'exclusion pour tous les
  interleavings imbriqués de récupération/remplacement — pendant la fenêtre
  de restauration d'un lock transitoirement détaché, le chemin vivant est
  libre et une tierce session peut l'acquérir (deux sessions actives,
  dégâts bornés aux DMs/bookkeeping, WARNING). **`fs.link` (restauration)
  n'a pas été exercé sur DriveFS** — tests sur FS local uniquement.
  **Portée RÉELLE du `rev`** (bornée,
  revue passe 3) : `save()` est un check-then-write NON atomique — deux
  writers partis du même `rev=N` peuvent tous deux écrire `rev=N+1` dans la
  fenêtre lecture→rename (last-writer-wins, perte possible) ; le `rev`
  DÉTECTE la divergence, il ne l'empêche pas — c'est le verrou même-hôte qui
  sérialise en pratique. Un exclusive-create sur DriveFS asynchrone n'est
  **pas** un verrou distribué : il sérialise les sessions du même hôte (FS
  local cohérent) ; la contention inter-hôte est prévenue par l'ownership.
  **Aucune promesse de single-writer distribué** — documentation explicite.
- **États disjoints + close gating sur preuve fraîche (défaut #3).** Le
  `status` dérive un état courant autoritaire (`state`) : `confirmed` exige
  preuve fraîche ET évidence courante alignée. Une confirmation historique ne
  compte plus si le fichier local est `missing`/`unreadable`/`drifted` ou si
  le snapshot distant est antérieur (`snapshot-stale`). Le `close` ordinaire
  est refusé sans ces états `confirmed` frais (force+reason pour forcer).
- **Exemptions avec provenance + conflits (défaut #5).** `loadActiveExceptions`
  retourne `{byMachine, conflicts}`. Un chemin exempté par une campagne mais
  requis (dans le canon) par une autre n'est **pas** une exemption effective :
  il est exposé (diff `claude-settings.exemption-conflict.*`) et le diff clé
  reste mesuré — plus de suppression silencieuse d'une exigence par une
  exemption d'une autre campagne.
- **Fallback comparateur Roo (défaut #4).** `loadPublishedSettingsEx` n'abandonne
  plus au premier fichier corrompu : un standalone illisible/corrompu est
  consigné (`rejected`) et la recherche continue vers les paquets versionnés.
  Si tous les candidats sont corrompus, un read-error est retourné (CRITICAL
  côté compare) — jamais une erreur de parse convertie silencieusement en
  absence, jamais un vieux fallback présenté comme état live.

## Compromis documentés (demandés par le mandat)

- **modelMap (défaut #6).** La forme *réelle* de la cartographie tier→modèle
  dans cette flotte est `env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`
  (+ `ANTHROPIC_CUSTOM_MODEL_OPTION`) — vérifié sur le settings réel de la
  machine coordinatrice (aucun objet `modelMap`/`modelMapping` n'y figure).
  L'implémentation couvre **les deux** représentations : les clés env
  manquantes (FABLE, CUSTOM_MODEL_OPTION, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`) ont
  été ajoutées à l'allow-list, ET un objet `modelMap` sous forme `{tier: modèle}`
  est couvert par tier (chemins `modelMap.{opus,sonnet,haiku,fable}`, bornés),
  sur la base du `modelMapping` des templates provider du dépôt. **Limitation
  assumée** : les métadonnées `_NAME`/`_DESCRIPTION` de chaque tier ne sont pas
  harmonisées (labels d'affichage, pas de routing) ; les tiers inconnus
  (`modelMap.dex`) sont hors périmètre (bornés). Un objet `modelMap` composite
  (non scalaire) est rejeté au canon.

## Limitations assumées

- **Pas de verrou distribué.** Les mutations coordinateur sont sérialisées entre
  sessions du même hôte (verrou exclusive-create, owner/token/TTL 30 min,
  récupération à gagnant unique pour la course simultanée testée, release sans
  suppression directe du chemin vivant) ; la contention inter-hôte est prévenue
  par l'ownership, non par un lock distribué — la garantie de single-writer
  distribué n'est **pas** promesse. **Limite explicite (revue passe 4)** : le
  protocole **n'est pas** une garantie d'exclusion pour tous les
  interleavings imbriqués de récupération/remplacement — pendant la fenêtre de
  restauration d'un lock transitoirement détaché, une tierce session peut
  acquérir le chemin libre (deux sessions actives, dégâts bornés aux
  DMs/bookkeeping, WARNING) ; `fs.link` (restauration) n'a pas été exercé sur
  DriveFS. **Portée réelle
  du `rev` (bornée, revue passe 3)** : check-then-write NON atomique — deux
  writers partis du même rev peuvent tous deux écrire rev+1 dans la fenêtre
  lecture→rename (last-writer-wins, une mise à jour peut être perdue) ; le
  `rev` DÉTECTE la divergence avant/après écriture, il ne l'empêche pas
  mécaniquement — le verrou même-hôte réduit en pratique le nombre de writers,
  mais cette propriété découle du verrou (best-effort, pas du `rev`), pas
  d'une impossibilité de double détention. Le compromis du TTL : une
  mutation qui durerait PLUS que le TTL verrait son lock récupéré par
  d'autres ; son `save` serait alors en concurrence de rev (détection
  best-effort, pas une garantie) — le TTL généreux (30 min vs des opérations
  de secondes) rend ce cas théorique. La preuve participant, elle, est
  immuable et n'a nul besoin de lock : des événements disjoints ne se perdent
  jamais.
- **Le distant n'est jamais écrit.** `apply`/`confirm` opèrent sur la machine
  locale ; les machines distantes appliquent leur canon via le DM de dispatch.
- **Drift distant = snapshot publié.** Le status distant compare au dernier
  snapshot publié de la machine : un snapshot antérieur à la confirmation
  rend `snapshot-stale` (live distant inconnu), un snapshot postérieur
  divergent rend `drifted` et invalide la confirmation affichée.
- **Un snapshot antérieur rend `snapshot-stale` (pas `confirmed`).** Une
  confirmation auto-attestée sans évidence fraîche récente ne suffit pas à
  fermer une campagne (défaut #3) : il faut un snapshot post-conformation
  conforme (machine distante) ou un live conforme (machine locale).
- **Dispatch vers soi-même** : refusé par MessageManager (anti-auto-message) —
  le coordinateur apply/confirm sa propre machine directement.
- **Pas de daemon/cron.** `remind` est conçu pour être appelé sur la cadence
  existante du coordinateur ; l'idempotence (cooldown) rend l'appel répétable
  sans spam. Les échecs d'envoi ne sont jamais marqués envoyés.
- **Canon scalaires par tier.** `modelMap.{opus,sonnet,haiku,fable}` sont des
  chemins scalaires (chaîne modèle) ; un objet `modelMap` composite est rejeté.
  Les métadonnées `_NAME`/`_DESCRIPTION` et les tiers inconnus (`modelMap.dex`)
  sont hors périmètre.

## Store partagé

```
{shared}/harmonization/campaigns/hc-claude-settings-{version}.json       (record + rev)
{shared}/harmonization/campaigns/{id}/events/{machine}/{eventId}.json    (événements immuables: confirm|failed)
{shared}/harmonization/campaigns/{id}.lock                               (verrou mutation coordinateur)
{shared}/configs/{machineId}/claude-settings/claude-settings.json        (snapshot standalone)
{shared}/configs/{machineId}/v{version}-{ts}/claude-settings/…          (paquets publish)
{shared}/configs/{machineId}/v{version}-{ts}/claude-settings/canon.json (apply payload explicite)
```

## Tests

- `src/services/__tests__/ClaudeSettingsService.test.ts` (57 tests) — états,
  projections, `projectSettingsSafe`/`redactValue` (redaction URL + idempotence,
  défaut #1), **discrimination non réversible** (userinfo/query différents =>
  marqueurs différents, revue passe 2), **fail-closed des query auth/sig/
  api-key à valeurs courtes** (revue passe 2), **matching par mot entier**
  (design/signal/author lisibles, camelCase couvert, revue passe 3 ;
  suffixes numériques `token2`/`key2`/… couverts sans rendre `design2`
  sensible — revue passe 4), masquage
  des secrets à la sérialisation, validation canon (positif + rejets, modelMap
  défaut #6), apply (préservation/dry-run/idempotence/fail-closed/concurrent/
  backup), localisateur de snapshot.
- `src/services/__tests__/HarmonizationCampaignService.test.ts` (32 tests) —
  cycle de vie, immuabilité, claimed-hash jamais compté, relances idempotentes,
  **concurrence** (événements immuables disjoints, verrou + ownership, défaut
  #2), **verrou récupérable** (frais refusé / périmé récupéré / l'ancien
  détenteur ne peut pas supprimer le lock du nouveau, revue passe 2),
  **récupération à gagnant unique** (2 acquisitions concurrentes du même lock
  périmé => exactement 1 succès + 1 CONCURRENT_WRITE ; récupération adverse :
  celui qui complète dans la fenêtre garde son lock, l'autre refuse ; release
  TOCTOU : un lock remplacé dans la fenêtre lecture→suppression n'est jamais
  supprimé — revue passe 3), **confirm refusé sur campagne fermée** (revue
  passe 2), **états disjoints** (confirm-then-drift/missing/unreadable,
  défaut #3), **exemptions avec provenance + conflits** (défaut #5), close
  gating, fail closed.
- `src/tools/roosync/__tests__/compare-claude-settings.test.ts` (20 tests) —
  garde de couverture (plus de fantômes), staleness soft/dur, diffs véridiques,
  exemptions + conflits (défaut #5), non-divulgation des credentials de
  BASE_URL (défaut #1), **deux userinfo différents sur le même host/path =>
  un diff produit** (revue passe 2, exigence explicite de la revue), modelMap
  par tier (défaut #6), detail=paths.
- `src/tools/roosync/__tests__/compare-config.test.ts` (63 tests) — + fallback
  Roo settings : standalone corrompu → paquet versionné ; tous candidats
  corrompus → read-error, jamais absence (défaut #4).
- `src/tools/roosync/__tests__/harmonization-tool.test.ts` — chemin public
  (fonction exportée telle que servie par le registry) + enregistrement
  statique (allToolDefinitions, TOOL_CAPABILITIES).

Le compte d'outils passe de 16 à 17 (`tests/unit/tools/roosync/fusions-1863.test.ts`,
registre mis à jour). Suite CI de référence : `npx vitest run --config vitest.config.ci.ts`
— 691 fichiers / 13609 tests / 0 échec (vérifié sur ce worktree).
