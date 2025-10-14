# Jupyter MCP Server

Ce serveur MCP fournit une interface complète pour interagir avec des serveurs Jupyter et gérer les environnements Conda.

## Fonctionnalités

- 📓 Gestion de notebooks Jupyter (lecture, écriture, exécution)
- 🔧 Gestion de kernels (démarrage, arrêt, interruption, redémarrage)
- ⚙️ Exécution de cellules et de notebooks complets
- 🖥️ Gestion du serveur Jupyter Lab
- 🐍 **Nouveau** : Gestion complète des environnements Conda

## Installation

Voir [INSTALLATION.md](docs/INSTALLATION.md) pour les instructions détaillées d'installation.

## Outils disponibles

### Gestion de notebooks

- `read_notebook` - Lire un notebook Jupyter
- `write_notebook` - Écrire un notebook Jupyter
- `create_notebook` - Créer un nouveau notebook vide
- `add_cell` - Ajouter une cellule à un notebook
- `remove_cell` - Supprimer une cellule d'un notebook
- `update_cell` - Modifier une cellule d'un notebook

### Gestion de kernels

- `list_kernels` - Lister les kernels disponibles et actifs
- `start_kernel` - Démarrer un nouveau kernel
- `stop_kernel` - Arrêter un kernel actif
- `interrupt_kernel` - Interrompre l'exécution d'un kernel
- `restart_kernel` - Redémarrer un kernel

### Exécution

- `execute_cell` - Exécuter du code dans un kernel spécifique
- `execute_notebook` - Exécuter toutes les cellules de code d'un notebook
- `execute_notebook_cell` - Exécuter une cellule spécifique d'un notebook

### Gestion du serveur

- `start_jupyter_server` - Démarrer un serveur Jupyter Lab
- `stop_jupyter_server` - Arrêter le serveur Jupyter
- `debug_list_runtime_dir` - Lister les fichiers du répertoire runtime Jupyter

### 🆕 Gestion des environnements Conda

- `list_conda_environments` - Liste tous les environnements Conda disponibles
- `create_conda_environment` - Crée un nouvel environnement Conda
- `install_conda_packages` - Installe des packages dans un environnement existant
- `check_conda_environment` - Vérifie l'existence d'un environnement et ses packages

**Documentation complète** : [CONDA-ENVIRONMENTS.md](docs/CONDA-ENVIRONMENTS.md)

### Setup automatique de l'environnement (Recommandé)

Le moyen le plus simple de configurer l'environnement MCP Jupyter :

```typescript
// Configuration automatique - aucun paramètre requis !
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "setup_jupyter_mcp_environment",
  arguments: {}
});

// L'environnement mcp-jupyter-py310 est créé/vérifié automatiquement
// avec tous les packages requis (papermill, jupyter, ipykernel, etc.)
```


## Exemple d'utilisation rapide

### Restaurer un environnement Conda manquant

```typescript
// 1. Vérifier si l'environnement existe
const check = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "check_conda_environment",
  arguments: {
    env_name: "mcp-jupyter-py310",
    required_packages: ["papermill", "jupyter", "ipykernel"]
  }
});

// 2. Créer l'environnement s'il n'existe pas
if (!check.exists) {
  await use_mcp_tool({
    server_name: "jupyter",
    tool_name: "create_conda_environment",
    arguments: {
      name: "mcp-jupyter-py310",
      python_version: "3.10",
      packages: ["papermill", "jupyter", "ipykernel", "ipython"]
    }
  });
}
```

### Démarrer un serveur Jupyter

```typescript
await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "start_jupyter_server",
  arguments: {
    envPath: "C:\\Users\\username\\.conda\\envs\\mcp-jupyter-py310\\Scripts\\jupyter-lab.exe"
  }
});
```

## Documentation

- [Installation](docs/INSTALLATION.md) - Guide d'installation complet
- [Configuration](docs/CONFIGURATION.md) - Options de configuration
- [Utilisation](docs/USAGE.md) - Exemples d'utilisation détaillés
- [Gestion Conda](docs/CONDA-ENVIRONMENTS.md) - Guide des outils Conda
- [Dépannage](docs/TROUBLESHOOTING.md) - Résolution de problèmes courants

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