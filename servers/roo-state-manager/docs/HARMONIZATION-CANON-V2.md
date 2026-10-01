# Canon V2 — campagne d'harmonisation settings (harnais serré #3657)

Squelette de la campagne v2, demandé par la TASK settings du 29/09 (4e relance
user). Prérequis code : allow-list élargie aux clés harnais (cette PR). Le canon
v1 (hc-claude-settings-1.0.1, campagne #3544) ne couvrait que le picker (~10
clés) ; la dérive post-clôture (bascules `model`, tier ids expirés en 20 jours)
est restée invisible.

## Périmètre v2

- **Couvert (allow-list MCP)** : les 18 chemins v1 + 5 clés harnais
  `env.ENABLE_TOOL_SEARCH`, `disableBundledSkills`, `disableClaudeAiConnectors`,
  `disableRemoteControl`, `outputStyle`.
- **HORS périmètre MCP, volontairement** : `permissions.*` (deny ENSURE-list,
  `mode`), `hooks`, `apiKeyHelper`, secrets/endpoint (`<<preserve-local>>` du
  template #3924). Le déploiement des permissions est porté par
  `Deploy-GlobalConfig.ps1 -Target settings` (repo parent #3924) — le MCP
  harmonise les valeurs, le script porte la garde des pouvoirs. Séparation
  délibérée : aucun chemin `permissions.*` n'est allow-listé.

## Payload create (prêt à coller, coordonnateur)

Mode `enforce-value` : les tier ids et le harnais doivent être ÉGAUX au canon,
pas seulement présents (le défaut v1 `ensure-present` tolérait les bascules
locales — c'est exactement la dérive observée sur po-203).

```json
roosync_harmonization(action: "create", target_file: "claude-settings", fleet: [
  "myia-ai-01", "myia-po-2023", "myia-po-2024", "myia-po-2025",
  "myia-po-2026", "myia-po-2027", "myia-web1", "myia-web2"
], canon: {
  "version": "hc-claude-settings-2.0.0",
  "mode": "enforce-value",
  "keys": {
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5[1m]",
    "env.ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1",
    "env.ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5[1m]",
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001[1m]",
    "env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "95",
    "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW": "280000",
    "env.CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "env.API_TIMEOUT_MS": "600000",
    "env.MCP_TOOL_TIMEOUT": "900000",
    "env.ENABLE_TOOL_SEARCH": "true",
    "disableBundledSkills": true,
    "disableClaudeAiConnectors": true,
    "disableRemoteControl": true,
    "outputStyle": "Proactive",
    "model": "sonnet"
  }
})
```

Ajustements attendus avant create (arbitrage coordinateur) :
- `model` : **alias nu uniquement** (`"sonnet"`, jamais `sonnet[1m]`) — le
  suffixe `[1m]` n'est lu que sur les clés env `ANTHROPIC_DEFAULT_*_MODEL` ;
  sur la clé `model` de settings c'est un id inconnu qui casse le picker et le
  slider d'effort dès qu'un `ANTHROPIC_DEFAULT_SONNET_MODEL` est posé (incident
  B, 01/10 — arbitrage jsboige/claudish#291 c.5927642834 ; fix gabarit parent
  #3977). La forme fautive avait été collée ici depuis le canon v1.
- `model` : ai-01 a refusé les 12 SET de son dry-run (conflit fenêtre /
  context-window.md — sa machine garde un choix local ; utiliser
  `exceptions` par machine plutôt que d'amputer le canon).
- `env.ANTHROPIC_BASE_URL` : HORS canon (endpoint par machine, claudish vs
  direct) — exemption structurelle, pas une valeur flotte.
- Machines sans `permissions.mode: auto-approve` local (ai-01) : irrelevant
  pour le MCP (non couvert), le script #3924 en fait l'objet des exemptions
  documentées DoD.

## Routine drift-check + remind (coordinateur, cadence 5h)

La jambe remind existe (#3545 : appelée par le coordinateur, aucun daemon).
Sa mutité 65 h (#3544) = personne ne l'appelait. Routine à intégrer au tick
`/coordinate` tant que la campagne v2 n'est pas `allConfirmed` :

1. `roosync_harmonization(action: "status", campaign_id: "<v2>")` — lit
   l'état disjoint par machine (confirmed / drifted / no-snapshot / …).
2. Si des machines non-confirmées : `action: "remind"` (cooldown 12h intégré,
   `force` uniquement sur arbitrage). Le DM prescrit déjà la recette
   apply → confirm → publish.
3. Post-clôture (drift-check récurrent) : `status` à chaque tick sur la
   campagne fermée reste lisible via `action: "list"` + snapshot compare
   (`roosync_compare_config(granularity: "settings")`) — une machine re-dérive
   = réouvrir en nouvelle version de canon (canon immuable : bump, pas d'edit).

## Ordre de déploiement

1. Merge cette PR (allow-list v2) + bump pointeur parent.
2. Le coordinateur crée la campagne v2 (payload ci-dessus, exceptions posées).
3. `dispatch` → chaque machine `apply` (dry-run d'abord : `dry_run: true`) →
   `confirm` → `publish` (version = canon, APRÈS confirm).
4. Routine remind au tick coordinateur jusqu'à `allConfirmed`, puis `close`.
