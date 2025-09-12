# Jupyter Papermill MCP Server

Une implémentation Python du serveur MCP pour Jupyter, remplaçant la version Node.js existante avec Papermill comme moteur d'exécution principal.

## Architecture

Ce serveur utilise une architecture modulaire basée sur :

- **Papermill** : Exécution robuste des notebooks
- **jupyter_client** : Gestion fine des kernels et sessions
- **FastMCP** : Framework MCP Python avec support asyncio
- **nbformat** : Manipulation des fichiers notebook

## Structure du projet

```
papermill_mcp/
├── main.py              # Point d'entrée serveur FastMCP
├── core/                # Logique d'exécution centrale
│   ├── papermill_executor.py
│   └── jupyter_manager.py
├── services/            # Couche logique métier
│   ├── notebook_service.py
│   └── kernel_service.py
├── tools/               # Outils MCP exposés
│   ├── notebook_tools.py
│   ├── kernel_tools.py
│   └── execution_tools.py
├── utils/               # Utilitaires
│   └── file_utils.py
└── config.py           # Configuration
```

## Installation

```bash
pip install -e .
```

## Utilisation

```bash
python -m papermill_mcp.main
```

## Parité fonctionnelle

Ce serveur fournit 17 outils identiques à la version Node.js :

**Tier 1: Opérations filesystem**
- create_notebook, read_notebook, update_notebook, list_notebooks

**Tier 2: Découverte & exécution simple**
- list_kernels, execute_notebook

**Tier 3: Gestion basique des kernels**
- start_kernel, stop_kernel, kernel_status, get_kernel_info

**Tier 4: Exécution interactive**
- execute_code, execute_cell

**Tier 5: Gestion des sessions**
- list_sessions, create_session, delete_session, get_session_info, restart_kernel

## Documentation

Voir [ARCHITECTURE.md](./ARCHITECTURE.md) pour les détails complets de conception.