# sk-agent v2.0 - Guide de Déploiement Multi-Machine

**Version:** 2.0.2 (fix handshake MCP - stdout silence)
**Date:** 2026-02-17
**Machines cibles:** myia-ai-01, myia-po-2023/2024/2025/2026, myia-web1

---

## ⚠️ WARNING CRITIQUE - MCP stdout Protocol

**NEVER write anything to stdout in MCP wrappers/servers except MCP JSON.**

MCP stdio protocol requires:
- **stdout** = MCP JSON messages ONLY
- **stderr** = logs, debug, errors

If wrapper writes `Write-Host "Starting..."` to stdout:
- ❌ Claude Code tries to parse it as JSON
- ❌ **Handshake failure** : "non respect du handshake MCP"
- ❌ Tools never appear

**Fix applied (2026-02-17):**
- Removed all `Write-Host` from `run-sk-agent.ps1`
- Wrapper is now **100% silent** on stdout
- Errors go to stderr only: `[Console]::Error.WriteLine()`

**Commits:** f0e03f7 (submodule), 387a2ab4 (parent)

---

## Prérequis

1. **Python 3.13+** (miniconda3 recommandé)
2. **Dépendances installées** (semantic-kernel >= 1.39, mcp >= 1.7, etc.)
3. **Config `sk_agent_config.json`** avec clés API (z.ai, Qdrant, Embeddings)

---

## Installation Rapide

### Étape 1: Installer dépendances

```bash
cd d:/dev/roo-extensions/mcps/internal/servers/sk-agent
pip install -r requirements.txt
```

**OU** créer un venv local (recommandé pour isolation):

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### Étape 2: Configurer ~/.claude.json

**IMPORTANT:** Utiliser le **wrapper PowerShell** pour compatibilité multi-machine.

Ajouter dans `~/.claude.json` (section `mcpServers`):

```json
{
  "mcpServers": {
    "sk-agent": {
      "command": "powershell",
      "args": [
        "-ExecutionPolicy", "Bypass",
        "-NoProfile",
        "-File", "d:/dev/roo-extensions/mcps/internal/servers/sk-agent/run-sk-agent.ps1"
      ]
    }
  }
}
```

**Pourquoi le wrapper ?**
- Détecte automatiquement Python (venv > conda > system)
- Compatible toutes machines sans modification
- Évite les erreurs "python not found"

### Étape 3: Redémarrer VS Code

Fermer et rouvrir **complètement** VS Code pour charger le MCP.

### Étape 4: Vérifier chargement

Dans Claude Code, taper une commande qui liste les MCPs ou vérifier que les outils sk-agent apparaissent:
- `call_agent`
- `list_agents`
- `run_conversation`
- etc.

---

## Validation Post-Déploiement

### Tests recommandés

1. **list_agents** - Vérifier 11 agents (analyst, fast, researcher, etc.)
2. **call_agent(fast, "Bonjour")** - Test local rapide (glm-4.7-flash)
3. **call_agent(analyst, "Capitale de France?")** - Test cloud (glm-5 via z.ai)
4. **list_conversations** - Vérifier 4 conversations (deep-search, deep-think, etc.)

### Tests unitaires (optionnel)

```bash
cd d:/dev/roo-extensions/mcps/internal/servers/sk-agent
python -m pytest test_sk_agent.py test_config.py -v
```

Attendu: 160+ tests passed, 3 skipped

---

## Configuration sk_agent_config.json

**Fichier:** `mcps/internal/servers/sk-agent/sk_agent_config.json` (gitignored)

**Structure v2:**
- `config_version`: 2
- `models`: 4 modèles (glm-5, glm-4.6v, zwz-8b, glm-4.7-flash)
- `embeddings`: Qwen3-4B-AWQ @ embeddings.myia.io (dim 2560)
- `qdrant`: qdrant.myia.io:443 (API key)
- `agents`: 11 agents (analyst, vision-analyst, fast, researcher, etc.)
- `conversations`: 4 types (deep-search, deep-think, code-review, research-debate)

**Clés API nécessaires:**
- `ZAI_API_KEY` pour glm-5 et glm-4.6v (z.ai cloud)
- Qdrant API key pour mémoire vectorielle
- Embeddings API key pour Qwen3-4B-AWQ

---

## Troubleshooting

### MCP non visible dans Claude Code

1. **Vérifier le wrapper démarre** :
   ```powershell
   cd mcps/internal/servers/sk-agent
   .\run-sk-agent.ps1
   # Devrait afficher: "Starting sk-agent MCP server v2.0"
   ```

2. **Vérifier Python détecté** :
   - Le wrapper affiche quel Python est utilisé (venv, conda, ou system)
   - Si "Python not found" → installer miniconda3 ou Python 3.13+

3. **Vérifier config .claude.json** :
   - Chemin vers `run-sk-agent.ps1` correct (absolu)
   - Section `mcpServers` bien formatée (JSON valide)

4. **Redémarrer VS Code complètement** (fermer toutes fenêtres)

### Erreur "module not found"

Dépendances manquantes. Installer:
```bash
pip install semantic-kernel[mcp] mcp openai Pillow httpx qdrant-client
```

### Erreur clé API

Vérifier `sk_agent_config.json` contient les clés API valides pour z.ai, Qdrant, Embeddings.

---

## Historique

- **v2.0.1** (2026-02-16): Ajout wrapper PowerShell robuste (fix #482)
- **v2.0.0** (2026-02-14): Architecture agent-centric, 11 agents, 4 conversations

---

## Support

- **Issue #482**: MCP non chargé - Résolu avec wrapper
- **Issue #475**: Guide déploiement original (command: python - problématique)
- **Tests**: `test_sk_agent_functional.py` (35 tests avec vrais LLMs)
