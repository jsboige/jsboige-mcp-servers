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
- **`read_cells`** 🆕 - **Outil consolidé** pour lire des cellules (remplace `read_cell`, `read_cells_range`, `list_notebook_cells`)
  - Mode `single` : Lire une cellule spécifique
  - Mode `range` : Lire une plage de cellules
  - Mode `list` : Lister les cellules avec preview
  - Mode `all` : Récupérer toutes les cellules complètes
- **`inspect_notebook`** 🆕 - **Outil consolidé** pour l'inspection et la validation (remplace `get_notebook_metadata`, `inspect_notebook_outputs`, `validate_notebook`)
  - Mode `metadata` : Métadonnées du notebook (kernel, language, auteur)
  - Mode `outputs` : Analyse des sorties de toutes les cellules code
  - Mode `validate` : Validation nbformat + rapport de problèmes
  - Mode `full` : Combinaison de metadata + outputs + validate

##### 🔄 Outils Dépréciés (Compatibilité Maintenue)
- `read_cell` ⚠️ DEPRECATED - Utiliser `read_cells(mode="single")` à la place
- `read_cells_range` ⚠️ DEPRECATED - Utiliser `read_cells(mode="range")` à la place
- `list_notebook_cells` ⚠️ DEPRECATED - Utiliser `read_cells(mode="list")` à la place
- `get_notebook_metadata` ⚠️ DEPRECATED - Utiliser `inspect_notebook(mode="metadata")` à la place
- `inspect_notebook_outputs` ⚠️ DEPRECATED - Utiliser `inspect_notebook(mode="outputs")` à la place
- `validate_notebook` ⚠️ DEPRECATED - Utiliser `inspect_notebook(mode="validate")` à la place

#### ⚙️ Outils Kernel
- `list_kernels` - Lister les kernels disponibles et actifs
- `start_kernel` - Démarrer un nouveau kernel
- `stop_kernel` - Arrêter un kernel actif
- `interrupt_kernel` - Interrompre l'exécution d'un kernel
- `restart_kernel` - Redémarrer un kernel
- **`execute_on_kernel`** 🆕 - **Outil consolidé** pour l'exécution sur kernel (remplace `execute_cell`, `execute_notebook`, `execute_notebook_cell`)
  - Mode `code` : Exécuter du code Python brut
  - Mode `notebook` : Exécuter toutes les cellules d'un notebook
  - Mode `notebook_cell` : Exécuter une cellule spécifique d'un notebook

##### 🔄 Outils Kernel Dépréciés (Compatibilité Maintenue)
- `execute_cell` ⚠️ DEPRECATED - Utiliser `execute_on_kernel(mode="code")` à la place
- `execute_notebook` ⚠️ DEPRECATED - Utiliser `execute_on_kernel(mode="notebook")` à la place
- `execute_notebook_cell` ⚠️ DEPRECATED - Utiliser `execute_on_kernel(mode="notebook_cell")` à la place

#### 🛠️ Outils d'Exécution Papermill
- **`execute_notebook`** 🆕 - **Outil consolidé** pour l'exécution Papermill (remplace `execute_notebook_papermill`, `parameterize_notebook`, `execute_notebook_solution_a`, `execute_notebook_sync`, `start_notebook_async`)
  - Mode `sync` : Exécution synchrone bloquante avec résultat immédiat
  - Mode `async` : Exécution asynchrone non-bloquante avec job_id
  - Report modes : `minimal`, `summary`, `full`
  - Auto-génération output_path avec timestamp
  - Injection de paramètres flexible

##### 🔄 Outils Papermill Dépréciés (Compatibilité Maintenue)
- `execute_notebook_papermill` ⚠️ DEPRECATED - Utiliser `execute_notebook(mode="sync")` à la place
- `parameterize_notebook` ⚠️ DEPRECATED - Utiliser `execute_notebook(parameters=..., mode="sync")` à la place
- `execute_notebook_solution_a` ⚠️ DEPRECATED - Utiliser `execute_notebook(mode="sync")` à la place
- `execute_notebook_sync` ⚠️ DEPRECATED - Utiliser `execute_notebook(mode="sync")` à la place
- `start_notebook_async` ⚠️ DEPRECATED - Utiliser `execute_notebook(mode="async")` à la place
#### 📊 Outils de Gestion Async
- **`manage_async_job`** 🆕 - **Outil consolidé** pour la gestion des jobs asynchrones (remplace `get_execution_status_async`, `get_job_logs`, `cancel_job`, `list_jobs`, `cleanup_jobs`)
  - Action `status` : Obtenir le statut complet d'un job avec progress tracking
  - Action `logs` : Récupérer les logs d'un job avec pagination (tail optionnel)
  - Action `cancel` : Annuler un job en cours d'exécution
  - Action `list` : Lister tous les jobs avec filtrage par statut
  - Action `cleanup` : Nettoyer les jobs terminés avec filtre temporel

##### 🔄 Outils Async Dépréciés (Compatibilité Maintenue)
- `get_execution_status_async` ⚠️ DEPRECATED - Utiliser `manage_async_job(action="status")` à la place
- `get_job_logs` ⚠️ DEPRECATED - Utiliser `manage_async_job(action="logs")` à la place
- `cancel_job` ⚠️ DEPRECATED - Utiliser `manage_async_job(action="cancel")` à la place
- `list_jobs` ⚠️ DEPRECATED - Utiliser `manage_async_job(action="list")` à la place
- `cleanup_jobs` ⚠️ DEPRECATED - Utiliser `manage_async_job(action="cleanup")` à la place


#### 🗂️ Outils Utilitaires
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
    
    # 🆕 Utiliser read_cells pour lire les cellules
    # Mode single : lire une cellule spécifique
    cell_result = await client.call_tool(
        "read_cells",
        path="example.ipynb",
        mode="single",
        index=0
    )
    
    # Mode list : lister toutes les cellules avec preview
    list_result = await client.call_tool(
        "read_cells",
        path="example.ipynb",
        mode="list",
        include_preview=True,
        preview_length=100
    )
    
    # Mode range : lire une plage de cellules
    range_result = await client.call_tool(
        "read_cells",
        path="example.ipynb",
        mode="range",
        start_index=0,
        end_index=2
    )
    
    # Mode all : récupérer toutes les cellules complètes
    all_result = await client.call_tool(
        "read_cells",
        path="example.ipynb",
        mode="all"
    )
    
    # Démarrer un kernel et exécuter
    kernel_result = await client.call_tool("start_kernel", kernel_name="python3")
    kernel_id = kernel_result["kernel_id"]
    
    # 🆕 Utiliser execute_on_kernel pour l'exécution
    # Mode code : exécuter du code Python brut
    code_result = await client.call_tool(
        "execute_on_kernel",
        kernel_id=kernel_id,
        mode="code",
        code="x = 5\nprint(x * 2)",
        timeout=60
    )
    
    # Mode notebook : exécuter toutes les cellules d'un notebook
    notebook_result = await client.call_tool(
        "execute_on_kernel",
        kernel_id=kernel_id,
        mode="notebook",
        path="example.ipynb",
        timeout=120
    )
    
    # Mode notebook_cell : exécuter une cellule spécifique
    cell_result = await client.call_tool(
        "execute_on_kernel",
        kernel_id=kernel_id,
        mode="notebook_cell",
        path="example.ipynb",
        cell_index=0,
        timeout=60
    )
    
    # 🆕 Utiliser execute_notebook pour l'exécution Papermill
    # Mode sync : exécution bloquante avec résultat immédiat
    sync_result = await client.call_tool(
        "execute_notebook",
        input_path="analysis.ipynb",
        output_path="analysis_output.ipynb",
        parameters={"date": "2025-01-08", "threshold": 0.95},
        mode="sync",
        report_mode="summary",
        timeout=300
    )
    
    # Mode async : exécution non-bloquante avec job_id
    async_result = await client.call_tool(
        "execute_notebook",
        input_path="long_analysis.ipynb",
        mode="async",
        parameters={"dataset": "large"}
    )
    job_id = async_result["job_id"]
    # Suivi via manage_async_job (Phase 4)
```

### Exemples Détaillés : execute_on_kernel

#### Mode "code" - Exécution Code Python Brut
```python
# Exécuter du code Python simple
result = await client.call_tool(
    "execute_on_kernel",
    kernel_id="kernel_123",
    mode="code",
    code="print('Hello from Jupyter!')",
    timeout=30
)

# Résultat
{
    "kernel_id": "kernel_123",
    "mode": "code",
    "execution_count": 1,
    "outputs": [
        {
            "output_type": "stream",
            "text": "Hello from Jupyter!\n"
        }
    ],
    "status": "ok",
    "execution_time": 0.05,
    "success": True
}
```

#### Mode "notebook" - Exécution Notebook Complet
```python
# Exécuter toutes les cellules d'un notebook
result = await client.call_tool(
    "execute_on_kernel",
    kernel_id="kernel_123",
    mode="notebook",
    path="analysis.ipynb",
    timeout=300
)

# Résultat
{
    "kernel_id": "kernel_123",
    "mode": "notebook",
    "path": "analysis.ipynb",
    "cells_executed": 10,
    "cells_succeeded": 9,
    "cells_failed": 1,
    "execution_time": 45.2,
    "results": [
        {
            "cell_index": 0,
            "cell_type": "code",
            "execution_count": 1,
            "status": "ok",
            "outputs": [...]
        }
    ],
    "success": False
}
```

#### Mode "notebook_cell" - Exécution Cellule Spécifique
```python
# Exécuter uniquement la cellule 5 d'un notebook
result = await client.call_tool(
    "execute_on_kernel",
    kernel_id="kernel_123",
    mode="notebook_cell",
    path="analysis.ipynb",
    cell_index=5,
    timeout=60
### Exemples Détaillés : execute_notebook (Papermill)

#### Mode "sync" - Exécution Synchrone avec Résultat Immédiat
```python
# Exécution synchrone basique
result = await client.call_tool(
    "execute_notebook",
    input_path="analysis.ipynb",
    mode="sync",
    timeout=300
)

# Résultat
{
    "status": "success",
    "mode": "sync",
    "input_path": "analysis.ipynb",
    "output_path": "analysis_output_20250108_213000.ipynb",
    "execution_time": 45.2,
    "cells_executed": 10,
    "cells_succeeded": 10,
    "cells_failed": 0,
    "parameters_injected": {},
    "kernel_name": "python3",
    "report": {
        "mode": "summary",
        "success_rate": 1.0
    }
}
```

#### Mode "sync" avec Paramètres - Injection de Paramètres
```python
# Exécution avec injection de paramètres
result = await client.call_tool(
    "execute_notebook",
    input_path="analysis.ipynb",
    output_path="output/analysis_2025.ipynb",
    parameters={
        "date": "2025-01-08",
        "threshold": 0.95,
        "iterations": 1000
    },
    mode="sync",
    report_mode="full",
    timeout=600
)

# Résultat avec report détaillé
{
    "status": "success",
    "mode": "sync",
    "parameters_injected": {
        "date": "2025-01-08",
        "threshold": 0.95,
        "iterations": 1000
    },
    "report": {
        "mode": "full",
        "cells_details": [
            {
                "index": 0,
                "execution_count": 1,
                "source": "# Parameters cell",
                "outputs": []
            },
            {
                "index": 1,
                "execution_count": 2,
                "source": "print(f'Date: {date}')",
                "outputs": [
                    {"output_type": "stream", "text": "Date: 2025-01-08\n"}
                ]
            }
        ]
    }
}
```

#### Mode "async" - Exécution Asynchrone Non-Bloquante
```python
# Lancer exécution asynchrone pour notebooks longs (>5min)
result = await client.call_tool(
    "execute_notebook",
    input_path="heavy_computation.ipynb",
    parameters={"dataset_size": 1000000},
    mode="async",
    timeout=3600
)

# Résultat immédiat avec job_id
{
    "status": "submitted",
    "mode": "async",
    "job_id": "job_abc123",
    "input_path": "heavy_computation.ipynb",
    "output_path": "heavy_computation_output_20250108_213000.ipynb",
    "parameters_injected": {"dataset_size": 1000000},
    "kernel_name": "python3",
    "submitted_at": "2025-01-08T21:30:00Z",
    "estimated_duration": 60.0,
    "message": "Job submitted successfully. Use manage_async_job(job_id='job_abc123') to check status."
}

# Suivi du job (Phase 4 - manage_async_job)
# status_result = await client.call_tool("manage_async_job", job_id="job_abc123", action="status")
```

#### Report Modes - Niveaux de Détail
```python
# Report minimal : status uniquement (rapide)
result = await client.call_tool(
    "execute_notebook",
    input_path="quick_analysis.ipynb",
    mode="sync",
    report_mode="minimal"
)
# report = {"mode": "minimal", "success": True, "cells_executed": 5}

# Report summary : statistiques + erreurs (défaut, équilibré)
result = await client.call_tool(
    "execute_notebook",
    input_path="analysis.ipynb",
    mode="sync",
    report_mode="summary"
)
# report = {"mode": "summary", "cells_executed": 10, "success_rate": 0.9, "errors": [...]}

# Report full : détails complets (détaillé)
result = await client.call_tool(
    "execute_notebook",
    input_path="detailed_analysis.ipynb",
    mode="sync",
    report_mode="full"
)
# report = {"mode": "full", "cells_details": [...], "timings": [...]}
```

)

# Résultat
{
    "kernel_id": "kernel_123",
    "mode": "notebook_cell",
    "path": "analysis.ipynb",
    "cell_index": 5,
    "cell_type": "code",
    "execution_count": 1,
    "outputs": [...],
    "status": "ok",
    "execution_time": 1.2,
    "success": True
}
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

Ce projet est sous licence MIT. Voir le fichier [LICENSE](../../LICENSE) pour plus de détails.

## 🙏 Remerciements

- **Papermill** pour l'exécution robuste des notebooks
- **FastMCP** pour le framework MCP Python
- **Jupyter** pour l'écosystème notebook
- **CoursIA** pour le support et les spécifications

---

*Ce serveur MCP Python remplace complètement le serveur Node.js existant tout en offrant des fonctionnalités supplémentaires et une architecture plus moderne.*