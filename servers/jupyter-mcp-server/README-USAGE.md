# Utilisation du serveur MCP Jupyter

Ce document explique comment utiliser les scripts pour démarrer le serveur Jupyter et le client MCP Jupyter de manière découplée.

## Architecture découplée

L'architecture a été modifiée pour découpler le serveur Jupyter du client MCP Jupyter:

1. Le serveur Jupyter est démarré séparément et fonctionne de manière autonome
2. Le client MCP Jupyter se connecte au serveur Jupyter existant
3. La configuration de connexion est stockée dans un fichier `config.json`

## Démarrage manuel recommandé

Pour éviter tout démarrage automatique non désiré, nous recommandons d'utiliser le script de démarrage manuel :

```
scripts/mcp-starters/start-jupyter-manual.bat
```

Ce script vous offre trois options :
1. Démarrer uniquement le serveur Jupyter
2. Démarrer uniquement le client MCP Jupyter
3. Démarrer les deux composants

## Scripts individuels disponibles

### `start-jupyter-server.bat`

Ce script démarre uniquement un serveur Jupyter pour les tests:

```
scripts/mcp-starters/start-jupyter-server.bat
```

- Vérifie si Jupyter est installé
- Démarre un serveur Jupyter Notebook sans navigateur
- Affiche l'URL d'accès au serveur Jupyter

### `start-jupyter-mcp-client.bat`

Ce script démarre uniquement le client MCP Jupyter:

```
scripts/mcp-starters/start-jupyter-mcp-client.bat
```

- Vérifie si le serveur MCP Jupyter est compilé
- Crée un fichier de configuration par défaut s'il n'existe pas
- Démarre le client MCP Jupyter qui se connecte au serveur Jupyter existant

## Configuration

Le client MCP Jupyter utilise un fichier de configuration `config.json` situé dans le répertoire `servers/jupyter-mcp-server/` pour se connecter au serveur Jupyter:

```json
{
  "jupyterServer": {
    "baseUrl": "http://localhost:8888",
    "token": "votre_token_ici"
  }
}
```

- `baseUrl`: URL du serveur Jupyter (par défaut: `http://localhost:8888`)
- `token`: Token d'authentification du serveur Jupyter (vide par défaut)

Pour obtenir le token, consultez la sortie du serveur Jupyter lors de son démarrage ou accédez à `http://localhost:8888` dans votre navigateur.

## Configuration VSCode/Roo

Pour éviter que le serveur MCP Jupyter ne démarre automatiquement avec VSCode, nous avons désactivé le serveur dans la configuration :

```json
"jupyter": {
  ...
  "disabled": true
}
```

Si vous souhaitez réactiver le démarrage automatique, modifiez le fichier `mcp_settings.json` et changez `"disabled": true` en `"disabled": false`.

## Utilisation typique

1. Exécutez le script de démarrage manuel :
   ```
   scripts/mcp-starters/start-jupyter-manual.bat
   ```

2. Choisissez l'option 3 pour démarrer à la fois le serveur Jupyter et le client MCP

3. Le client MCP Jupyter est maintenant disponible pour Roo

## Notes

- Le serveur Jupyter doit être démarré avant le client MCP Jupyter
- Si le serveur Jupyter utilise un token, vous devez le spécifier dans le fichier de configuration
- Le client MCP Jupyter ne tentera pas de démarrer son propre serveur Jupyter
- Pour éviter les problèmes de démarrage automatique, gardez le serveur désactivé dans la configuration VSCode et utilisez le script manuel