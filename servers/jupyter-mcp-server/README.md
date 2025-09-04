# Jupyter MCP Server

Ce serveur MCP fournit une interface pour interagir avec des serveurs Jupyter.

## Tools

### `start_jupyter_server`

Démarre un serveur Jupyter Lab en tant que processus enfant détaché.

**Paramètres:**

*   `envPath` (string, requis): Le chemin complet vers l'exécutable `jupyter-lab.exe` dans l'environnement souhaité (par exemple, un environnement Conda).

**Retourne:**

*   `pid` (number): L'ID du processus du serveur Jupyter démarré.
*   `status` (string): 'started' si le serveur a démarré avec succès, 'error' sinon.
*   `message` (string, optionnel): Un message d'erreur en cas d'échec.

**Exemple d'utilisation:**

```json
{
  "tool": "start_jupyter_server",
  "arguments": {
    "envPath": "C:\\Users\\jsboi\\.conda\\envs\\mcp-jupyter\\Scripts\\jupyter-lab.exe"
  }
}

## Note de Compatibilité

Pour fonctionner correctement en tant que MCP au sein de l'environnement Roo, ce projet **doit** être compilé en **CommonJS**. L'environnement d'exécution de Roo ne supporte pas nativement les modules ES (`"type": "module"` dans `package.json`).

Pour ce faire, assurez-vous que votre `tsconfig.json` contient les options suivantes avant d'exécuter `npm run build`:

```json
{
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    // ... autres options
  }
}
```