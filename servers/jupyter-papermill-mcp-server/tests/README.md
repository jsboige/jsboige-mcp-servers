# Tests SDDD pour le serveur MCP Jupyter-Papermill

Cette structure de tests suit la **stratégie SDDD (Software Development Driven Design)** avec 3 niveaux de tests progressifs.

## 🏗️ Structure des tests

```
tests/
├── notebooks/                     # Notebooks de test minimaux
│   ├── test_python_success.ipynb  # Simple print("hello")
│   ├── test_python_failure.ipynb  # Code Python qui échoue volontairement
│   ├── test_dotnet_success.ipynb  # Simple Console.WriteLine("hello");
│   └── test_dotnet_failure_nuget.ipynb  # Test #r "nuget:..." pour reproduire l'erreur
├── test_unit/                     # Tests niveau 1 (avec mocks)
│   ├── __init__.py
│   └── test_executor_logic.py     # Tests unitaires avec mocks
├── test_integration/              # Tests niveau 2 (avec Papermill réel)
│   ├── __init__.py
│   └── test_papermill_execution.py  # Tests d'intégration Papermill
└── test_e2e/                      # Tests niveau 3 (serveur complet)
    ├── __init__.py
    ├── conftest.py                # Fixtures pytest pour serveur
    └── test_mcp_server_flow.py    # Tests End-to-End protocol MCP
```

## 🚀 Installation des dépendances de test

```bash
pip install -r requirements-test.txt
```

## 📋 Exécution des tests

### Tests par niveau SDDD

```bash
# Niveau 1 : Tests unitaires uniquement (rapides, avec mocks)
pytest -m unit

# Niveau 2 : Tests d'intégration (avec Papermill réel)
pytest -m integration

# Niveau 3 : Tests End-to-End (serveur MCP complet)
pytest -m e2e
```

### Tests par fonctionnalité

```bash
# Tous les tests
pytest

# Tests spécifiques
pytest tests/test_unit/
pytest tests/test_integration/
pytest tests/test_e2e/

# Tests avec couverture de code
pytest --cov=papermill_mcp --cov-report=html

# Tests parallèles (plus rapides)
pytest -n auto
```

### Tests avec filtres avancés

```bash
# Exclure les tests lents
pytest -m "not slow"

# Tests nécessitant des kernels spécifiques
pytest -m requires_kernels

# Tests .NET uniquement (si kernel disponible)
pytest -m requires_dotnet

# Tests avec sortie détaillée
pytest -v --tb=long
```

## 📊 Niveaux de tests SDDD

### Niveau 1 : Tests unitaires (`test_unit/`)
- **Objectif** : Valider la logique métier isolée
- **Outils** : Mocks, pas de dépendances externes
- **Exécution** : Très rapide (< 5s)
- **Couverture** : Classes `PapermillExecutor`, `ExecutionMetrics`, etc.

```bash
pytest tests/test_unit/ -v
```

### Niveau 2 : Tests d'intégration (`test_integration/`)
- **Objectif** : Valider l'intégration avec Papermill réel
- **Outils** : API Papermill directe sur notebooks de test
- **Exécution** : Modéré (10-30s)
- **Couverture** : Exécution réelle de notebooks, gestion d'erreurs

```bash
pytest tests/test_integration/ -v
```

### Niveau 3 : Tests End-to-End (`test_e2e/`)
- **Objectif** : Valider le protocole MCP complet
- **Outils** : Serveur MCP réel, communication JSON-RPC
- **Exécution** : Plus lent (30-60s)
- **Couverture** : Flux complet client-serveur, protocole MCP

```bash
pytest tests/test_e2e/ -v
```

## 🧪 Notebooks de test

### `test_python_success.ipynb`
```python
print("Hello from Python test!")
```
- **Usage** : Valider l'exécution Python basique
- **Résultat attendu** : Succès avec sortie texte

### `test_python_failure.ipynb`
```python
raise ValueError("Test error")
```
- **Usage** : Tester la gestion d'erreurs Python
- **Résultat attendu** : Échec avec PapermillExecutionError

### `test_dotnet_success.ipynb`
```csharp
Console.WriteLine("Hello from .NET!");
```
- **Usage** : Valider l'exécution .NET Interactive
- **Résultat attendu** : Succès avec sortie texte (si kernel disponible)

### `test_dotnet_failure_nuget.ipynb`
```csharp
#r "nuget:Newtonsoft.Json"
using Newtonsoft.Json;
Console.WriteLine("Testing NuGet package load");
```
- **Usage** : Reproduire le problème NuGet identifié
- **Résultat attendu** : Peut échouer selon configuration

## 🔧 Configuration pytest

Le fichier `pytest.ini` configure :
- Marqueurs personnalisés (`unit`, `integration`, `e2e`)
- Timeouts pour éviter les blocages
- Gestion des logs et rapports
- Support asyncio pour les tests asynchrones

## 📈 Rapports et métriques

### Rapport de couverture HTML
```bash
pytest --cov=papermill_mcp --cov-report=html
# Ouvre htmlcov/index.html
```

### Rapport JSON pour CI/CD
```bash
pytest --json-report --json-report-file=test-results.json
```

### Rapport JUnit pour intégration
```bash
pytest --junitxml=junit.xml
```

## 🐛 Debug et développement

### Debug d'un test spécifique
```bash
pytest tests/test_unit/test_executor_logic.py::TestPapermillExecutor::test_executor_initialization -v -s
```

### Profiling des performances
```bash
pytest --benchmark-only
```

### Tests avec pdb
```bash
pytest --pdb
```

## ⚡ Tests rapides pour le développement

```bash
# Tests unitaires uniquement (très rapide)
pytest -m unit --maxfail=1

# Skip tests lents pendant le développement
pytest -m "not slow and not e2e"

# Tests avec arrêt au premier échec
pytest -x
```

## 🚨 Prérequis système

### Kernels Jupyter requis
```bash
# Vérifier les kernels disponibles
jupyter kernelspec list

# Installation Python kernel (généralement déjà présent)
python -m ipykernel install --user

# Installation .NET Interactive (optionnel)
dotnet tool install -g Microsoft.dotnet-interactive
dotnet interactive jupyter install
```

### Variables d'environnement
```bash
# Optionnel - Configuration du serveur pour tests
export MCP_JUPYTER_OUTPUT_DIR="/tmp/mcp-test-outputs"
export MCP_JUPYTER_TIMEOUT="300"
```

## 📋 Checklist de validation

- [ ] `pytest -m unit` : Tous les tests unitaires passent
- [ ] `pytest -m integration` : Tests d'intégration Papermill réussissent
- [ ] `pytest -m e2e` : Tests E2E avec serveur MCP fonctionnent
- [ ] Couverture de code > 80% sur les modules critiques
- [ ] Tests .NET passent si kernel disponible
- [ ] Aucun leak de ressources ou processus zombie
- [ ] Temps d'exécution acceptable (< 2min pour tout)

## 🔄 Intégration CI/CD

Exemple de workflow GitHub Actions :
```yaml
- name: Run SDDD tests
  run: |
    pytest -m unit --cov=papermill_mcp
    pytest -m integration
    pytest -m "e2e and not slow"