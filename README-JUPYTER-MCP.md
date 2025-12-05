# MCP Jupyter pour Roo

Ce document explique l'architecture, la configuration et l'utilisation du serveur MCP Jupyter pour Roo.

## Architecture du MCP Jupyter

Le MCP Jupyter est un serveur qui implémente le protocole Model Context Protocol (MCP) pour permettre à Roo d'interagir avec Jupyter Notebook. Il sert d'intermédiaire entre Roo et un serveur Jupyter, traduisant les requêtes MCP en appels API Jupyter et vice versa.

### Composants principaux

```
┌─────────┐     ┌───────────────┐     ┌─────────────────┐
│   Roo   │◄────┤  MCP Jupyter  │◄────┤ Serveur Jupyter │
└─────────┘     └───────────────┘     └─────────────────┘
                       │
                       ▼
                ┌─────────────┐
                │ config.json │
                └─────────────┘
```

1. **Serveur MCP Jupyter** (`servers/jupyter-mcp-server/`)
   - Implémente le protocole MCP pour communiquer avec Roo
   - Traduit les requêtes MCP en appels API Jupyter
   - Gère la connexion au serveur Jupyter
   - Gère la connexion et le cycle de vie du serveur Jupyter en tant que sous-processus.
   - Supporte le mode hors ligne pour fonctionner sans serveur Jupyter

2. **Services Jupyter** (`servers/jupyter-mcp-server/src/services/`)
   - `jupyter.ts` : Service principal pour la communication avec le serveur Jupyter
   - Gère l'authentification, les requêtes HTTP et la gestion des erreurs

3. **Outils MCP** (`servers/jupyter-mcp-server/src/tools/`)
   - `kernel.ts` : Outils pour gérer les kernels Jupyter (démarrage, arrêt, liste)
   - `notebook.ts` : Outils pour gérer les notebooks (création, lecture, écriture)
   - `execution.ts` : Outils pour exécuter du code dans les kernels

4. **Scripts de démarrage** (`scripts/mcp-starters/`)
   - Scripts pour démarrer le serveur MCP Jupyter dans différents modes
   - Versions pour Windows (.bat), Linux/macOS (.sh) et Node.js (.js)

## Modifications pour la connexion automatique

Le MCP Jupyter a été modifié pour résoudre le problème de connexion automatique au démarrage, qui pouvait entraîner des erreurs si aucun serveur Jupyter n'était disponible.

### Principales modifications

1. **Mode hors ligne**
   - Le serveur démarre par défaut en mode hors ligne
   - Aucune tentative de connexion n'est effectuée au démarrage
   - Les fonctionnalités ne nécessitant pas de connexion restent disponibles

2. **Détection dynamique**
   - Le serveur surveille les modifications du fichier de configuration
   - Passage automatique entre mode connecté et mode hors ligne sans redémarrage

3. **Gestion des erreurs améliorée**
   - Meilleure gestion des erreurs de connexion
   - Messages d'erreur plus clairs et plus informatifs
   - Dégradation gracieuse en cas d'échec de connexion

4. **Scripts dédiés**
   - Scripts spécifiques pour le mode hors ligne
   - Scripts pour VSCode/Roo avec détection automatique de l'environnement

## Configuration du MCP Jupyter

### Configuration de base

Le fichier `servers/jupyter-mcp-server/config.json` contient la configuration principale :

```json
{
  "jupyterServer": {
    "baseUrl": "http://localhost:8888",
    "token": "votre_token_ici"
  }
}
```

### Mode hors ligne

Pour activer le mode hors ligne, ajoutez `"offline": true` à la configuration :

```json
{
  "jupyterServer": {
    "baseUrl": "http://localhost:8888",
    "token": "votre_token_ici",
    "offline": true
  }
}
```

### Options de démarrage

Plusieurs options sont disponibles pour démarrer le MCP Jupyter :

1. **Ligne de commande**
   ```bash
   node servers/jupyter-mcp-server/dist/index.js --offline
   ```

2. **Variable d'environnement**
   ```bash
   JUPYTER_MCP_OFFLINE=true node servers/jupyter-mcp-server/dist/index.js
   ```

3. **Scripts de démarrage**
   ```bash
   # Windows
   scripts\mcp-starters\start-jupyter-mcp-offline.bat
   
   # Linux/macOS
   ./scripts/mcp-starters/start-jupyter-mcp-offline.sh
   
   # Node.js
   node scripts/mcp-starters/start-jupyter-mcp-offline.js
   ```

## Utilisation avec Roo

### Configuration de Roo

Pour utiliser le MCP Jupyter avec Roo, configurez le fichier `mcp_settings.json` :

```json
{
  "mcp_servers": [
    {
      "name": "jupyter",
      "command": "node servers/jupyter-mcp-server/dist/index.js",
      "cwd": "chemin/vers/votre/projet"
    }
  ]
}
```

### Outils MCP disponibles

Le MCP Jupyter fournit les outils suivants à Roo :

1. **Gestion des kernels**
   - `list_kernels` : Liste les kernels disponibles
   - `start_kernel` : Démarre un nouveau kernel
   - `restart_kernel` : Redémarre un kernel existant
   - `stop_kernel` : Arrête un kernel

2. **Gestion des notebooks**
   - `create_notebook` : Crée un nouveau notebook
   - `get_notebook_content` : Récupère le contenu d'un notebook
   - `write_notebook` : Écrit dans un notebook
   - `add_cell` : Ajoute une cellule à un notebook

3. **Exécution de code**
   - `execute_cell` : Exécute du code dans un kernel
   - `execute_notebook` : Exécute toutes les cellules d'un notebook

4. **Mode hors ligne**
   - `get_offline_status` : Vérifie si le mode hors ligne est activé
   - `set_offline_mode` : Active ou désactive le mode hors ligne

### Exemples d'utilisation avec Roo

```
<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>list_kernels</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>

<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>execute_cell</tool_name>
<arguments>
{
  "kernel_id": "kernel-id",
  "code": "print('Hello from Jupyter!')"
}
</arguments>
</use_mcp_tool>
```

## Tests et validation

### Scripts de test

Des scripts de test sont disponibles pour vérifier le bon fonctionnement du MCP Jupyter :

1. `tests/test-jupyter-server-start.js` : Démarre un serveur Jupyter local
2. `tests/test-jupyter-mcp-connect.js` : Teste la connexion au serveur Jupyter
3. `tests/test-jupyter-mcp-features.js` : Teste toutes les fonctionnalités
4. `tests/test-jupyter-mcp-offline.js` : Teste le mode hors ligne
5. `tests/test-jupyter-mcp-switch-offline.js` : Teste le passage entre les modes

### Automatisation des tests et commits

Le script `scripts/commit-jupyter-changes.js` automatise les tests et les commits :

```bash
node scripts/commit-jupyter-changes.js
```

Ce script :
- Vérifie que tous les tests sont réussis
- Effectue un commit des modifications
- Affiche un résumé des modifications

## Dépannage

Pour les problèmes courants et leurs solutions, consultez le document [jupyter-mcp-troubleshooting.md](./docs/jupyter-mcp-troubleshooting.md).

Pour plus d'informations sur le mode hors ligne, consultez [jupyter-mcp-offline-mode.md](./docs/jupyter-mcp-offline-mode.md).

Pour les tests de connexion, consultez [jupyter-mcp-connection-test.md](./docs/jupyter-mcp-connection-test.md).

## Conclusion

Le MCP Jupyter pour Roo offre une intégration fluide entre Roo et Jupyter Notebook, permettant d'exécuter du code Python et d'autres langages directement depuis Roo. Le mode hors ligne améliore la robustesse du système en évitant les erreurs de connexion au démarrage.