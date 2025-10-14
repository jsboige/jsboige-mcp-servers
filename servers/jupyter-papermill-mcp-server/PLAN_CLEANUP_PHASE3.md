# 📋 PLAN DE NETTOYAGE - PRÉPARATION PHASE 3
**Date :** 2025-10-08  
**Objectif :** Organiser 42 fichiers désordonnés à la racine du serveur MCP Jupyter-Papermill

---

## 📊 GROUNDING COMPLET

### Fichiers actuels à la racine (42 fichiers)

#### 📚 Documentation/Rapports (17 fichiers)
| Fichier | Taille | Dernière modification |
|---------|--------|----------------------|
| ARCHITECTURE.md | 6.8 KB | 21/09/2025 |
| BACKUP_UNIQUE_TOOLS.md | 1.8 KB | 23/09/2025 |
| CHANGELOG_CONSOLIDATION_PHASE1A.md | 7.6 KB | 08/10/2025 |
| CHANGELOG_CONSOLIDATION_PHASE1B.md | 15.5 KB | 08/10/2025 |
| CHANGELOG_CONSOLIDATION_PHASE2.md | 15.2 KB | 08/10/2025 |
| CONDA_ENVIRONMENT_SETUP.md | 6.2 KB | 21/09/2025 |
| CONSOLIDATION_MAPPING.md | 2.8 KB | 23/09/2025 |
| performance_report.md | 0.8 KB | 21/09/2025 |
| RAPPORT_ARCHITECTURE_CONSOLIDATION.md | 20.6 KB | 08/10/2025 |
| RAPPORT_CONSOLIDATION_FINALE.md | 6.1 KB | 23/09/2025 |
| RAPPORT_MISSION_PHASE2_TRIPLE_GROUNDING.md | 19.2 KB | 08/10/2025 |
| RAPPORT_VALIDATION_FINALE.md | 6.8 KB | 24/09/2025 |
| RAPPORT_VALIDATION_FINALE_JUPYTER_PAPERMILL_CONSOLIDEE.md | 8.9 KB | 23/09/2025 |
| SPECIFICATIONS_API_CONSOLIDEE.md | 39.7 KB | 08/10/2025 |
| VALIDATION_COMPLETE_31_OUTILS.md | 4.3 KB | 24/09/2025 |
| VALIDATION_PRATIQUE.md | 0 KB | 08/10/2025 ⚠️ |
| validation_report_20250923_231059.txt | 0 KB | 23/09/2025 ⚠️ |

#### 📓 Notebooks de test (9 fichiers)
| Fichier | Taille | Dernière modification |
|---------|--------|----------------------|
| conversation_executor_complete.ipynb | 14.4 KB | 07/10/2025 |
| diagnostic_java_env.ipynb | 4.7 KB | 07/10/2025 |
| temp_notebook_runner.ipynb | 18.6 KB | 26/09/2025 |
| test_consolidation_validation.ipynb | 0.5 KB | 25/09/2025 |
| test_sddd_mission_complete.ipynb | 0.5 KB | 24/09/2025 |
| test_sddd_mission_complete_executed.ipynb | 1.7 KB | 24/09/2025 |
| test_sddd_mission_complete_executed_20250923_221027.ipynb | 1.7 KB | 24/09/2025 |
| test_sddd_mission_complete_parameterized.ipynb | 2.4 KB | 24/09/2025 |
| test_solution_a_validation.ipynb | 1.7 KB | 25/09/2025 |

#### 🐍 Scripts Python de test (9 fichiers)
| Fichier | Taille | Dernière modification |
|---------|--------|----------------------|
| debug_execute_cell.py | 3.3 KB | 24/09/2025 |
| diagnose_mcp_issue.py | 3.9 KB | 24/09/2025 |
| fix_unicode_crisis.py | 4.2 KB | 24/09/2025 |
| test_consolidation.py | 1.0 KB | 24/09/2025 |
| test_fix_chemins.py | 5.5 KB | 08/10/2025 |
| test_mcp_protocol.py | 3.2 KB | 24/09/2025 |
| test_reconsolidation_sddd.py | 6.2 KB | 24/09/2025 |
| test_simple_reconsolidation.py | 3.8 KB | 24/09/2025 |
| test_validation_finale.py | 6.2 KB | 24/09/2025 |

#### 🛠️ Scripts batch/PowerShell (3 fichiers)
| Fichier | Taille | Dernière modification |
|---------|--------|----------------------|
| run_validation.ps1 | 1.0 KB | 24/09/2025 |
| start_jupyter_mcp.bat | 0.7 KB | 21/09/2025 |
| start_jupyter_mcp_portable.bat | 1.5 KB | 21/09/2025 |

#### ✅ Fichiers à conserver à la racine (6 fichiers)
- .gitignore
- pyproject.toml
- pytest.ini
- README.md
- requirements-test.txt

---

## 🎯 STRUCTURE CIBLE

```
mcps/internal/servers/jupyter-papermill-mcp-server/
├── .gitignore
├── pyproject.toml
├── pytest.ini
├── README.md
├── requirements-test.txt
│
├── docs/
│   ├── INDEX.md (nouveau)
│   │
│   ├── consolidation/
│   │   ├── phase1a/
│   │   │   └── 01_CHANGELOG_CONSOLIDATION_PHASE1A.md
│   │   │
│   │   ├── phase1b/
│   │   │   └── 02_CHANGELOG_CONSOLIDATION_PHASE1B.md
│   │   │
│   │   ├── phase2/
│   │   │   ├── 03_CHANGELOG_CONSOLIDATION_PHASE2.md
│   │   │   └── 04_RAPPORT_MISSION_PHASE2_TRIPLE_GROUNDING.md
│   │   │
│   │   ├── specifications/
│   │   │   ├── ARCHITECTURE.md
│   │   │   ├── SPECIFICATIONS_API_CONSOLIDEE.md
│   │   │   ├── CONSOLIDATION_MAPPING.md
│   │   │   └── BACKUP_UNIQUE_TOOLS.md
│   │   │
│   │   └── validation/
│   │       ├── RAPPORT_VALIDATION_FINALE.md
│   │       ├── RAPPORT_VALIDATION_FINALE_JUPYTER_PAPERMILL_CONSOLIDEE.md
│   │       ├── RAPPORT_CONSOLIDATION_FINALE.md
│   │       ├── RAPPORT_ARCHITECTURE_CONSOLIDATION.md
│   │       ├── VALIDATION_COMPLETE_31_OUTILS.md
│   │       ├── VALIDATION_PRATIQUE.md
│   │       ├── validation_report_20250923_231059.txt
│   │       └── performance_report.md
│   │
│   └── setup/
│       └── CONDA_ENVIRONMENT_SETUP.md
│
├── tests/
│   ├── notebooks/
│   │   ├── test_sddd_mission_complete.ipynb
│   │   ├── test_sddd_mission_complete_executed.ipynb
│   │   ├── test_sddd_mission_complete_executed_20250923_221027.ipynb
│   │   ├── test_sddd_mission_complete_parameterized.ipynb
│   │   ├── test_consolidation_validation.ipynb
│   │   ├── test_solution_a_validation.ipynb
│   │   ├── conversation_executor_complete.ipynb
│   │   ├── diagnostic_java_env.ipynb
│   │   └── temp_notebook_runner.ipynb
│   │
│   └── integration/
│       ├── test_consolidation.py
│       ├── test_validation_finale.py
│       ├── test_reconsolidation_sddd.py
│       ├── test_simple_reconsolidation.py
│       ├── test_mcp_protocol.py
│       ├── test_fix_chemins.py
│       ├── debug_execute_cell.py
│       ├── diagnose_mcp_issue.py
│       └── fix_unicode_crisis.py
│
└── scripts/
    ├── start-jupyter-server.sh (renommé de start_jupyter_mcp.bat)
    └── run-validation.sh (renommé de run_validation.ps1)
```

---

## 📝 PLAN D'EXÉCUTION DÉTAILLÉ

### Phase 1 : Création de la structure ✅
```powershell
# Créer tous les répertoires nécessaires
New-Item -ItemType Directory -Force -Path "docs/consolidation/phase1a"
New-Item -ItemType Directory -Force -Path "docs/consolidation/phase1b"
New-Item -ItemType Directory -Force -Path "docs/consolidation/phase2"
New-Item -ItemType Directory -Force -Path "docs/consolidation/specifications"
New-Item -ItemType Directory -Force -Path "docs/consolidation/validation"
New-Item -ItemType Directory -Force -Path "docs/setup"
New-Item -ItemType Directory -Force -Path "tests/notebooks"
New-Item -ItemType Directory -Force -Path "tests/integration"
New-Item -ItemType Directory -Force -Path "scripts"
```

### Phase 2 : Déplacer la documentation (17 fichiers)

#### Phase 1a (1 fichier)
```powershell
Move-Item "CHANGELOG_CONSOLIDATION_PHASE1A.md" "docs/consolidation/phase1a/01_CHANGELOG_CONSOLIDATION_PHASE1A.md"
```

#### Phase 1b (1 fichier)
```powershell
Move-Item "CHANGELOG_CONSOLIDATION_PHASE1B.md" "docs/consolidation/phase1b/02_CHANGELOG_CONSOLIDATION_PHASE1B.md"
```

#### Phase 2 (2 fichiers)
```powershell
Move-Item "CHANGELOG_CONSOLIDATION_PHASE2.md" "docs/consolidation/phase2/03_CHANGELOG_CONSOLIDATION_PHASE2.md"
Move-Item "RAPPORT_MISSION_PHASE2_TRIPLE_GROUNDING.md" "docs/consolidation/phase2/04_RAPPORT_MISSION_PHASE2_TRIPLE_GROUNDING.md"
```

#### Specifications (4 fichiers)
```powershell
Move-Item "ARCHITECTURE.md" "docs/consolidation/specifications/"
Move-Item "SPECIFICATIONS_API_CONSOLIDEE.md" "docs/consolidation/specifications/"
Move-Item "CONSOLIDATION_MAPPING.md" "docs/consolidation/specifications/"
Move-Item "BACKUP_UNIQUE_TOOLS.md" "docs/consolidation/specifications/"
```

#### Validation (8 fichiers)
```powershell
Move-Item "RAPPORT_VALIDATION_FINALE.md" "docs/consolidation/validation/"
Move-Item "RAPPORT_VALIDATION_FINALE_JUPYTER_PAPERMILL_CONSOLIDEE.md" "docs/consolidation/validation/"
Move-Item "RAPPORT_CONSOLIDATION_FINALE.md" "docs/consolidation/validation/"
Move-Item "RAPPORT_ARCHITECTURE_CONSOLIDATION.md" "docs/consolidation/validation/"
Move-Item "VALIDATION_COMPLETE_31_OUTILS.md" "docs/consolidation/validation/"
Move-Item "VALIDATION_PRATIQUE.md" "docs/consolidation/validation/"
Move-Item "validation_report_20250923_231059.txt" "docs/consolidation/validation/"
Move-Item "performance_report.md" "docs/consolidation/validation/"
```

#### Setup (1 fichier)
```powershell
Move-Item "CONDA_ENVIRONMENT_SETUP.md" "docs/setup/"
```

### Phase 3 : Déplacer les notebooks (9 fichiers)
```powershell
Move-Item "test_sddd_mission_complete.ipynb" "tests/notebooks/"
Move-Item "test_sddd_mission_complete_executed.ipynb" "tests/notebooks/"
Move-Item "test_sddd_mission_complete_executed_20250923_221027.ipynb" "tests/notebooks/"
Move-Item "test_sddd_mission_complete_parameterized.ipynb" "tests/notebooks/"
Move-Item "test_consolidation_validation.ipynb" "tests/notebooks/"
Move-Item "test_solution_a_validation.ipynb" "tests/notebooks/"
Move-Item "conversation_executor_complete.ipynb" "tests/notebooks/"
Move-Item "diagnostic_java_env.ipynb" "tests/notebooks/"
Move-Item "temp_notebook_runner.ipynb" "tests/notebooks/"
```

### Phase 4 : Déplacer les scripts Python (9 fichiers)
```powershell
Move-Item "test_consolidation.py" "tests/integration/"
Move-Item "test_validation_finale.py" "tests/integration/"
Move-Item "test_reconsolidation_sddd.py" "tests/integration/"
Move-Item "test_simple_reconsolidation.py" "tests/integration/"
Move-Item "test_mcp_protocol.py" "tests/integration/"
Move-Item "test_fix_chemins.py" "tests/integration/"
Move-Item "debug_execute_cell.py" "tests/integration/"
Move-Item "diagnose_mcp_issue.py" "tests/integration/"
Move-Item "fix_unicode_crisis.py" "tests/integration/"
```

### Phase 5 : Traiter les scripts (3 fichiers)
```powershell
# Conserver run_validation.ps1 dans scripts/
Move-Item "run_validation.ps1" "scripts/"

# Scripts .bat obsolètes - À analyser avant suppression
# start_jupyter_mcp.bat
# start_jupyter_mcp_portable.bat
```

---

## ⚠️ POINTS D'ATTENTION

### Fichiers vides à traiter
- `VALIDATION_PRATIQUE.md` (0 bytes) → Conserver pour documentation future
- `validation_report_20250923_231059.txt` (0 bytes) → Conserver pour traçabilité

### Scripts batch
- **start_jupyter_mcp.bat** → Vérifier si utilisé avant suppression
- **start_jupyter_mcp_portable.bat** → Vérifier si utilisé avant suppression

### Validation post-déplacement
1. Vérifier que les imports relatifs dans les tests fonctionnent toujours
2. Vérifier que pytest trouve les tests dans `tests/integration/`
3. Vérifier que les notebooks s'ouvrent correctement
4. Mettre à jour README.md si des chemins y sont référencés

---

## 📊 STATISTIQUES

- **Total fichiers à déplacer :** 38 fichiers
- **Répertoires à créer :** 9 répertoires
- **Fichiers conservés à la racine :** 6 fichiers
- **Fichiers à analyser (scripts .bat) :** 2 fichiers

**Espace disque concerné :** ~262 KB de fichiers

---

## ✅ VALIDATION FINALE

Commandes à exécuter après cleanup :
```powershell
# Vérifier la nouvelle structure
tree /F docs tests scripts

# Vérifier que pytest fonctionne
pytest tests/integration/ -v

# Vérifier que les notebooks sont accessibles
ls tests/notebooks/*.ipynb

# Vérifier que rien n'est cassé
git status
```

---

**Statut :** 📋 Plan validé, prêt pour exécution  
**Prochaine étape :** Créer la structure de répertoires