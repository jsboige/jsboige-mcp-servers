# Jupyter Papermill MCP Server

Un serveur MCP (Model Context Protocol) Python pour les opérations Jupyter Notebook utilisant Papermill. Ce projet est un remplacement complet du serveur Node.js existant, offrant une parité fonctionnelle complète avec une architecture moderne basée sur Python.

## 🚀 Fonctionnalités

### 17+ Outils MCP Disponibles

#### 📓 Outils Notebook
- `read_notebook` - Lire un notebook Jupyter depuis un fichier
- `write_notebook` - Écrire un notebook Jupyter dans un fichier
- `create_notebook` - Créer un nouveau notebook vide
- `add_cell` - Ajouter une cellule à un notebook
- `remove_cell` - Supprimer une cellule d'un notebook
- `update_cell` - Modifier une cellule d'un notebook

#### ⚙️ Outils Kernel
- `list_kernels` - Lister les kernels disponibles et actifs
- `start_kernel` - Démarrer un nouveau kernel
- `stop_kernel` - Arrêter un kernel actif
- `interrupt_kernel` - Interrompre l'exécution d'un kernel
- `restart_kernel` - Redémarrer un kernel
- `execute_cell` - Exécuter du code dans un kernel spécifique
- `execute_notebook` - Exécuter toutes les cellules de code d'un notebook
- `execute_notebook_cell` - Exécuter une cellule spécifique d'un notebook

#### 🛠️ Outils d'Exécution Avancés
- `execute_notebook_papermill` - Exécuter un notebook avec Papermill (paramètres injectés)
- `list_notebook_files` - Lister les fichiers notebook dans un répertoire
- `get_notebook_info` - Récupérer les métadonnées détaillées d'un notebook
- `get_kernel_status` - Récupérer le statut détaillé d'un kernel
- `cleanup_all_kernels` - Nettoyer tous les kernels actifs
- `start_jupyter_server` - Démarrer un serveur Jupyter Lab
- `stop_jupyter_server` - Arrêter le serveur Jupyter géré par le MCP
- `debug_list_runtime_dir` - Lister les fichiers du répertoire runtime Jupyter (debug)

## 🏗️ Architecture

Le projet suit une architecture modulaire en couches :

```
jupyter-papermill-mcp-server/
├── papermill_mcp/
│   ├── main.py              # Point d'entrée principal
│   ├── config.py            # Gestion de la configuration
│   ├── core/                # Modules de base
│   │   ├── papermill_executor.py   # Exécution Papermill
│   │   └── jupyter_manager.py      # Gestion des kernels
│   ├── services/            # Couche de logique métier
│   │   ├── notebook_service.py     # Service notebook
│   │   └── kernel_service.py       # Service kernel
│   ├── tools/               # Interface MCP
│   │   ├── notebook_tools.py       # Outils notebook
│   │   ├── kernel_tools.py         # Outils kernel
│   │   └── execution_tools.py      # Outils d'exécution
│   └── utils/               # Utilitaires
│       └── file_utils.py           # Utilitaires fichiers
├── tests/                   # Tests
├── pyproject.toml          # Configuration du projet
├── README.md               # Documentation
└── ARCHITECTURE.md         # Documentation architecture
```

### Couches Architecturales

1. **Tools Layer** - Interface MCP avec FastMCP
2. **Services Layer** - Logique métier et orchestration
3. **Core Layer** - Interaction avec les systèmes externes (Papermill, Jupyter)
4. **Utils Layer** - Fonctions utilitaires partagées

## 📦 Installation

### Prérequis

- Python 3.8+
- Jupyter Lab/Notebook installé
- Un environnement virtuel (recommandé)

### Installation via pip

```bash
# Cloner le repository
git clone https://github.com/coursia/jupyter-papermill-mcp-server
cd jupyter-papermill-mcp-server

# Créer un environnement virtuel
python -m venv venv
source venv/bin/activate  # Linux/Mac
# ou
venv\Scripts\activate  # Windows

# Installer le package et ses dépendances
pip install -e .

# Installation avec toutes les dépendances optionnelles
pip install -e ".[all]"
```

### Installation pour le développement

```bash
# Installer avec les dépendances de développement
pip install -e ".[dev]"

# Installer les hooks pre-commit
pre-commit install
```

## 🚀 Utilisation

### Démarrage du serveur MCP

```bash
# Via le script d'entrée
jupyter-papermill-mcp

# Ou directement avec Python
python -m papermill_mcp.main
```

### Configuration

Le serveur peut être configuré via :

1. **Arguments en ligne de commande**
2. **Variables d'environnement** (prefixées par `JUPYTER_MCP_`)
3. **Fichier de configuration JSON** (`config.json`)

#### Exemple de configuration

```json
{
    "jupyter_timeout": 300,
    "execution_timeout": 60.0,
    "continue_on_error": false,
    "output_directory": "./outputs",
    "log_level": "INFO",
    "max_kernels": 10
}
```

#### Variables d'environnement

```bash
export JUPYTER_MCP_EXECUTION_TIMEOUT=120
export JUPYTER_MCP_LOG_LEVEL=DEBUG
export JUPYTER_MCP_MAX_KERNELS=5
```

### Utilisation avec un client MCP

```python
# Exemple d'utilisation avec un client MCP
from mcp import Client

async def main():
    client = Client()
    
    # Créer un notebook
    result = await client.call_tool(
        "create_notebook",
        path="example.ipynb",
        kernel="python3"
    )
    
    # Ajouter une cellule de code
    await client.call_tool(
        "add_cell",
        path="example.ipynb",
        cell_type="code",
        source="print('Hello, World!')"
    )
    
    # Démarrer un kernel et exécuter
    kernel_result = await client.call_tool("start_kernel", kernel_name="python3")
    kernel_id = kernel_result["kernel_id"]
    
    # Exécuter le notebook
    await client.call_tool(
        "execute_notebook",
        path="example.ipynb",
        kernel_id=kernel_id
    )
```

## 🔧 Configuration Avancée

### Stratégie Hybride

Le serveur utilise une stratégie hybride combinant :

- **Papermill** pour l'exécution complète de notebooks avec injection de paramètres
- **jupyter_client** pour la gestion directe des kernels et l'exécution interactive

### Gestion des Erreurs

```python
# Configuration de la gestion d'erreurs
{
    "continue_on_error": false,  # Arrêter sur la première erreur
    "error_output_type": "full", # Type de sortie d'erreur
    "max_error_output": 1000     # Limite de caractères pour les erreurs
}
```

### Performance

```python
# Optimisations de performance
{
    "max_kernels": 10,           # Nombre maximum de kernels simultanés
    "kernel_idle_timeout": 3600, # Timeout d'inactivité des kernels (secondes)
    "cleanup_interval": 300      # Intervalle de nettoyage automatique
}
```

## 🧪 Tests

### Exécution des tests

```bash
# Tests unitaires
pytest tests/unit/

# Tests d'intégration
pytest tests/integration/

# Tests avec couverture
pytest --cov=papermill_mcp --cov-report=html

# Tests marqués spécifiquement
pytest -m "not slow"  # Exclure les tests lents
pytest -m "kernel"    # Tests nécessitant un kernel réel
```

### Types de tests

- **Tests unitaires** - Tests des composants individuels
- **Tests d'intégration** - Tests de l'interaction entre composants
- **Tests kernel** - Tests avec de vrais kernels Jupyter
- **Tests de performance** - Benchmarks et tests de charge

## 🛠️ Développement

### Structure du développement

```bash
# Formater le code
black papermill_mcp/
isort papermill_mcp/

# Vérifier le code
flake8 papermill_mcp/
mypy papermill_mcp/

# Lancer tous les checks
pre-commit run --all-files
```

### Ajout de nouveaux outils

1. Créer la fonction dans le module `tools/` approprié
2. Enregistrer l'outil avec `@app.tool()`
3. Ajouter les tests correspondants
4. Mettre à jour la documentation

### Architecture des services

```python
# Exemple d'ajout d'un nouveau service
class NewService:
    def __init__(self, config: MCPConfig):
        self.config = config
    
    async def new_operation(self, param: str) -> Dict[str, Any]:
        # Logique métier
        pass
```

## 📊 Monitoring et Debugging

### Logs

Le serveur utilise un logging structuré :

```python
import logging
logger = logging.getLogger(__name__)

# Les logs incluent
logger.info("Operation completed", extra={
    "operation": "execute_notebook",
    "path": "notebook.ipynb",
    "duration": 12.5
})
```

### Métriques

Avec l'option `monitoring` installée :

```python
# Métriques Prometheus disponibles
- notebook_executions_total
- kernel_starts_total  
- execution_duration_seconds
- active_kernels_gauge
```

## 🚦 Statut du Projet

- ✅ **Architecture** - Conception complète
- ✅ **Implémentation** - 17+ outils MCP implémentés
- ✅ **Configuration** - Système de configuration flexible
- ✅ **Documentation** - Documentation complète
- 🔄 **Tests** - Tests en cours d'implémentation
- 📋 **Déploiement** - À venir

### Compatibilité

| Fonctionnalité | Node.js Server | Python Server | Status |
|---------------|----------------|---------------|--------|
| Gestion notebooks | ✅ | ✅ | ✅ Parité complète |
| Gestion kernels | ✅ | ✅ | ✅ Parité complète |
| Exécution Papermill | ❌ | ✅ | ✅ Amélioration |
| Injection paramètres | ❌ | ✅ | ✅ Nouvelle fonctionnalité |
| Serveur Jupyter | ✅ | ✅ | ✅ Parité complète |
| Gestion erreurs | ✅ | ✅ | ✅ Améliorée |

## 🤝 Contribution

1. Fork le projet
2. Créer une branche feature (`git checkout -b feature/nouvelle-fonctionnalite`)
3. Commit les changements (`git commit -am 'Ajout nouvelle fonctionnalité'`)
4. Push vers la branche (`git push origin feature/nouvelle-fonctionnalite`)
5. Créer une Pull Request

## 📄 License

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 🙏 Remerciements

- **Papermill** pour l'exécution robuste des notebooks
- **FastMCP** pour le framework MCP Python
- **Jupyter** pour l'écosystème notebook
- **CoursIA** pour le support et les spécifications

---

*Ce serveur MCP Python remplace complètement le serveur Node.js existant tout en offrant des fonctionnalités supplémentaires et une architecture plus moderne.*