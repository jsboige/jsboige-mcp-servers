# 📖 Guide de Migration - API MCP Jupyter-Papermill Consolidée

**Version** : 2.0 (Post-Consolidation)  
**Date** : 10 Octobre 2025  
**Public** : Utilisateurs et Développeurs

---

## 🎯 Pourquoi Migrer ?

### Ancienne API (Avant Consolidation)

```python
# ❌ 23+ outils fragmentés à découvrir
await read_cell(...)
await read_cells_range(...)
await list_notebook_cells(...)
await get_notebook_metadata(...)
await inspect_notebook_outputs(...)
await validate_notebook(...)
await execute_cell(...)
await execute_notebook(...)
# ... et 15 autres outils
```

**Problèmes** :
- 😵 Trop d'outils à mémoriser
- 🔀 Patterns incohérents
- 📚 Documentation fragmentée
- 🐛 Maintenance difficile

---

### Nouvelle API (Après Consolidation)

```python
# ✅ 6 outils unifiés et cohérents
await read_cells(mode="...")
await inspect_notebook(mode="...")
await execute_on_kernel(mode="...")
await execute_notebook(mode="...")
await manage_async_job(action="...")
await manage_kernel(action="...")
```

**Avantages** :
- ✨ **API simplifiée de 74%** (6 outils vs 23)
- 🎯 **Découverte intuitive** (mode/action explicites)
- 📖 **Documentation centralisée**
- 🛡️ **Backward compatible à 100%** (code legacy fonctionne)

---

## ⏱️ Timeline Migration

### Phase 1 : Période de Transition (6 mois)

**Statut Actuel** : ✅ **Vous êtes ici !**

- ✅ Nouvelle API disponible
- ✅ Anciens outils fonctionnent (wrappers)
- ⚠️ Warnings logged pour inciter migration
- 📖 Documentation complète disponible

**Action Recommandée** : **Migrer progressivement**

---

### Phase 2 : Dépréciation Soft (6-12 mois)

- ⚠️ Warnings plus explicites
- 📊 Métriques usage trackées
- 📣 Communications régulières
- 🆘 Support migration disponible

**Action Recommandée** : **Finaliser migration**

---

### Phase 3 : Dépréciation Hard (12+ mois)

- 🚫 Suppression wrappers deprecated
- ✅ Nouvelle API uniquement
- 📚 Documentation legacy archivée

**Action Requise** : **Migration obligatoire**

---

## 🗺️ Guide de Migration par Outil

### 1️⃣ Migration `read_cells` (Lecture Notebooks)

#### Remplace 3 Outils

- ❌ `read_cell` → ✅ `read_cells(mode="single")`
- ❌ `read_cells_range` → ✅ `read_cells(mode="range")`
- ❌ `list_notebook_cells` → ✅ `read_cells(mode="list")`

---

#### Exemple 1 : Lecture d'une Cellule Unique

**AVANT** (deprecated) :
```python
# Lire la cellule 5
result = await read_cell(path="notebook.ipynb", index=5)
print(result["content"])
```

**APRÈS** (recommandé) :
```python
# Lire la cellule 5
result = await read_cells(
    path="notebook.ipynb", 
    mode="single",      # ✨ Nouveau : mode explicite
    index=5
)
print(result["cells"][0]["source"])  # ✨ Format structuré
```

---

#### Exemple 2 : Lecture d'une Plage de Cellules

**AVANT** (deprecated) :
```python
# Lire cellules 10 à 20
result = await read_cells_range(
    path="notebook.ipynb",
    start_index=10,
    end_index=20
)
for cell in result["cells"]:
    print(cell["source"])
```

**APRÈS** (recommandé) :
```python
# Lire cellules 10 à 20
result = await read_cells(
    path="notebook.ipynb",
    mode="range",       # ✨ Mode explicite
    start_index=10,
    end_index=20
)
for cell in result["cells"]:
    print(cell["source"])
```

---

#### Exemple 3 : Lister Toutes les Cellules (avec Preview)

**AVANT** (deprecated) :
```python
# Lister avec preview
result = await list_notebook_cells(path="notebook.ipynb")
for cell_preview in result["cells"]:
    print(f"Cell {cell_preview['index']}: {cell_preview['preview']}")
```

**APRÈS** (recommandé) :
```python
# Lister avec preview
result = await read_cells(
    path="notebook.ipynb",
    mode="list",                # ✨ Mode liste
    include_preview=True,       # ✨ Configurable
    preview_length=100          # ✨ Longueur preview
)
for cell in result["cells"]:
    print(f"Cell {cell['index']}: {cell['preview']}")
```

---

#### Exemple 4 : Lire TOUTES les Cellules Complètes

**NOUVEAU** (pas d'équivalent avant) :
```python
# Lire toutes les cellules sans troncature
result = await read_cells(
    path="notebook.ipynb",
    mode="all"  # ✨ Nouveau mode : tout le contenu
)
# Toutes les cellules avec contenu complet
full_cells = result["cells"]
```

---

### 2️⃣ Migration `inspect_notebook` (Inspection Notebooks)

#### Remplace 3 Outils

- ❌ `get_notebook_metadata` → ✅ `inspect_notebook(mode="metadata")`
- ❌ `inspect_notebook_outputs` → ✅ `inspect_notebook(mode="outputs")`
- ❌ `validate_notebook` → ✅ `inspect_notebook(mode="validate")`

---

#### Exemple 1 : Récupérer Métadonnées

**AVANT** (deprecated) :
```python
# Métadonnées notebook
metadata = await get_notebook_metadata(path="notebook.ipynb")
print(f"Kernel: {metadata['kernel_name']}")
print(f"Language: {metadata['language']}")
```

**APRÈS** (recommandé) :
```python
# Métadonnées notebook
result = await inspect_notebook(
    path="notebook.ipynb",
    mode="metadata"  # ✨ Mode explicite
)
print(f"Kernel: {result['metadata']['kernel_name']}")
print(f"Language: {result['metadata']['language']}")
```

---

#### Exemple 2 : Inspecter Outputs des Cellules

**AVANT** (deprecated) :
```python
# Outputs des cellules
outputs = await inspect_notebook_outputs(path="notebook.ipynb")
for cell_output in outputs["outputs"]:
    if cell_output["has_errors"]:
        print(f"Cell {cell_output['index']} has errors")
```

**APRÈS** (recommandé) :
```python
# Outputs des cellules
result = await inspect_notebook(
    path="notebook.ipynb",
    mode="outputs"  # ✨ Mode outputs
)
for cell_output in result["outputs"]:
    if cell_output["has_errors"]:
        print(f"Cell {cell_output['index']} has errors")
```

---

#### Exemple 3 : Valider Structure Notebook

**AVANT** (deprecated) :
```python
# Validation notebook
validation = await validate_notebook(path="notebook.ipynb")
if not validation["valid"]:
    print(f"Errors: {validation['errors']}")
```

**APRÈS** (recommandé) :
```python
# Validation notebook
result = await inspect_notebook(
    path="notebook.ipynb",
    mode="validate"  # ✨ Mode validation
)
if not result["valid"]:
    print(f"Errors: {result['errors']}")
```

---

#### Exemple 4 : Inspection Complète (NOUVEAU !)

**NOUVEAU** (pas d'équivalent avant) :
```python
# Inspection complète : metadata + outputs + validation
result = await inspect_notebook(
    path="notebook.ipynb",
    mode="full"  # ✨ Mode complet
)
# Accès à tout :
print(result["metadata"])   # Métadonnées
print(result["outputs"])    # Outputs
print(result["validation"]) # Validation
```

---

### 3️⃣ Migration `execute_on_kernel` (Exécution sur Kernel)

#### Remplace 3 Outils

- ❌ `execute_cell` → ✅ `execute_on_kernel(mode="code")`
- ❌ `execute_notebook` (in-kernel) → ✅ `execute_on_kernel(mode="notebook")`
- ❌ `execute_notebook_cell` → ✅ `execute_on_kernel(mode="notebook_cell")`

---

#### Exemple 1 : Exécuter Code Python Brut

**AVANT** (deprecated) :
```python
# Exécuter code sur kernel
result = await execute_cell(
    kernel_id="abc123",
    code="print('Hello World')"
)
print(result["outputs"])
```

**APRÈS** (recommandé) :
```python
# Exécuter code sur kernel
result = await execute_on_kernel(
    kernel_id="abc123",
    mode="code",              # ✨ Mode code
    code="print('Hello World')",
    timeout=60                # ✨ Timeout configurable
)
print(result["outputs"])
```

---

#### Exemple 2 : Exécuter Toutes Cellules d'un Notebook

**AVANT** (deprecated) :
```python
# Exécuter notebook complet sur kernel
result = await execute_notebook(
    path="notebook.ipynb",
    kernel_id="abc123"
)
print(f"Cells executed: {result['cells_executed']}")
```

**APRÈS** (recommandé) :
```python
# Exécuter notebook complet sur kernel
result = await execute_on_kernel(
    kernel_id="abc123",
    mode="notebook",       # ✨ Mode notebook
    path="notebook.ipynb",
    timeout=60
)
print(f"Cells executed: {result['cells_executed']}")
```

---

#### Exemple 3 : Exécuter une Cellule Spécifique

**AVANT** (deprecated) :
```python
# Exécuter cellule 5 du notebook
result = await execute_notebook_cell(
    path="notebook.ipynb",
    cell_index=5,
    kernel_id="abc123"
)
print(result["output"])
```

**APRÈS** (recommandé) :
```python
# Exécuter cellule 5 du notebook
result = await execute_on_kernel(
    kernel_id="abc123",
    mode="notebook_cell",  # ✨ Mode cellule spécifique
    path="notebook.ipynb",
    cell_index=5,
    timeout=60
)
print(result["outputs"])
```

---

### 4️⃣ Migration `execute_notebook` (Exécution Papermill)

#### Remplace 5 Outils

- ❌ `execute_notebook_papermill` → ✅ `execute_notebook(mode="sync")`
- ❌ `parameterize_notebook` → ✅ `execute_notebook(..., parameters=...)`
- ❌ `execute_notebook_solution_a` → ✅ `execute_notebook(mode="sync")`
- ❌ `execute_notebook_sync` → ✅ `execute_notebook(mode="sync")`
- ❌ `start_notebook_async` → ✅ `execute_notebook(mode="async")`

---

#### Exemple 1 : Exécution Synchrone Simple

**AVANT** (deprecated) :
```python
# Exécution Papermill synchrone
result = await execute_notebook_papermill(
    input_path="input.ipynb",
    output_path="output.ipynb"
)
print("Execution completed")
```

**APRÈS** (recommandé) :
```python
# Exécution Papermill synchrone
result = await execute_notebook(
    notebook_path="input.ipynb",  # ✨ Nom cohérent
    mode="sync",                  # ✨ Mode explicite
    output_path="output.ipynb",
    timeout_seconds=300           # ✨ Timeout configurable
)
print("Execution completed")
```

---

#### Exemple 2 : Exécution avec Paramètres

**AVANT** (deprecated) :
```python
# Injection paramètres
result = await parameterize_notebook(
    input_path="input.ipynb",
    parameters={"epochs": 10, "lr": 0.001},
    output_path="output.ipynb"
)
```

**APRÈS** (recommandé) :
```python
# Injection paramètres
result = await execute_notebook(
    notebook_path="input.ipynb",
    mode="sync",
    parameters={"epochs": 10, "lr": 0.001},  # ✨ Paramètres intégrés
    output_path="output.ipynb",
    timeout_seconds=300
)
```

---

#### Exemple 3 : Exécution Asynchrone (Background)

**AVANT** (deprecated) :
```python
# Lancer exécution background
result = await start_notebook_async(
    input_path="long_notebook.ipynb",
    output_path="output.ipynb"
)
job_id = result["job_id"]
print(f"Job started: {job_id}")
```

**APRÈS** (recommandé) :
```python
# Lancer exécution background
result = await execute_notebook(
    notebook_path="long_notebook.ipynb",
    mode="async",              # ✨ Mode async explicite
    output_path="output.ipynb",
    timeout_seconds=3600       # ✨ Timeout adaptatif
)
job_id = result["job_id"]
print(f"Job started: {job_id}")
```

---

### 5️⃣ Migration `manage_async_job` (Gestion Jobs Async)

#### Remplace 5 Outils

- ❌ `get_execution_status_async` → ✅ `manage_async_job(action="status")`
- ❌ `get_job_logs` → ✅ `manage_async_job(action="logs")`
- ❌ `cancel_job` → ✅ `manage_async_job(action="cancel")`
- ❌ `list_jobs` → ✅ `manage_async_job(action="list")`
- ❌ `cleanup_jobs` → ✅ `manage_async_job(action="cleanup")`

---

#### Exemple 1 : Obtenir Statut d'un Job

**AVANT** (deprecated) :
```python
# Statut job
status = await get_execution_status_async(
    job_id="job123",
    include_logs=False
)
print(f"Status: {status['status']}")
print(f"Progress: {status['progress']['percent']}%")
```

**APRÈS** (recommandé) :
```python
# Statut job
result = await manage_async_job(
    action="status",       # ✨ Action explicite
    job_id="job123",
    include_logs=False
)
print(f"Status: {result['status']}")
print(f"Progress: {result['progress']['percent']}%")
```

---

#### Exemple 2 : Récupérer Logs d'un Job

**AVANT** (deprecated) :
```python
# Logs job
logs = await get_job_logs(
    job_id="job123",
    tail=100  # Dernières 100 lignes
)
for log_line in logs["logs"]:
    print(log_line)
```

**APRÈS** (recommandé) :
```python
# Logs job
result = await manage_async_job(
    action="logs",       # ✨ Action logs
    job_id="job123",
    log_tail=100         # ✨ Nom cohérent
)
for log_line in result["logs"]:
    print(log_line)
```

---

#### Exemple 3 : Annuler un Job

**AVANT** (deprecated) :
```python
# Annuler job
result = await cancel_job(job_id="job123")
print(f"Cancelled: {result['message']}")
```

**APRÈS** (recommandé) :
```python
# Annuler job
result = await manage_async_job(
    action="cancel",   # ✨ Action cancel
    job_id="job123"
)
print(f"Cancelled: {result['message']}")
```

---

#### Exemple 4 : Lister Tous les Jobs

**AVANT** (deprecated) :
```python
# Liste jobs
jobs = await list_jobs(filter_status="running")
for job in jobs["jobs"]:
    print(f"{job['job_id']}: {job['status']}")
```

**APRÈS** (recommandé) :
```python
# Liste jobs
result = await manage_async_job(
    action="list",           # ✨ Action list
    filter_status="running"  # ✨ Filtrage optionnel
)
for job in result["jobs"]:
    print(f"{job['job_id']}: {job['status']}")
```

---

#### Exemple 5 : Nettoyer Jobs Terminés

**AVANT** (deprecated) :
```python
# Cleanup jobs anciens
result = await cleanup_jobs(older_than_hours=24)
print(f"Removed {result['jobs_removed']} jobs")
```

**APRÈS** (recommandé) :
```python
# Cleanup jobs anciens
result = await manage_async_job(
    action="cleanup",         # ✨ Action cleanup
    cleanup_older_than=24     # ✨ Nom cohérent
)
print(f"Removed {result['jobs_removed']} jobs")
```

---

### 6️⃣ Migration `manage_kernel` (Gestion Kernels)

#### Remplace 4 Outils

- ❌ `start_kernel` → ✅ `manage_kernel(action="start")`
- ❌ `stop_kernel` → ✅ `manage_kernel(action="stop")`
- ❌ `interrupt_kernel` → ✅ `manage_kernel(action="interrupt")`
- ❌ `restart_kernel` → ✅ `manage_kernel(action="restart")`

---

#### Exemple 1 : Démarrer un Kernel

**AVANT** (deprecated) :
```python
# Démarrer kernel Python
result = await start_kernel(
    kernel_name="python3",
    working_dir="/path/to/project"
)
kernel_id = result["kernel_id"]
print(f"Kernel started: {kernel_id}")
```

**APRÈS** (recommandé) :
```python
# Démarrer kernel Python
result = await manage_kernel(
    action="start",          # ✨ Action explicite
    kernel_name="python3",
    working_dir="/path/to/project"
)
kernel_id = result["kernel_id"]
print(f"Kernel started: {kernel_id}")
```

---

#### Exemple 2 : Arrêter un Kernel

**AVANT** (deprecated) :
```python
# Arrêter kernel
result = await stop_kernel(kernel_id="abc123")
print(f"Kernel stopped: {result['message']}")
```

**APRÈS** (recommandé) :
```python
# Arrêter kernel
result = await manage_kernel(
    action="stop",      # ✨ Action stop
    kernel_id="abc123"
)
print(f"Kernel stopped: {result['message']}")
```

---

#### Exemple 3 : Interrompre un Kernel (SIGINT)

**AVANT** (deprecated) :
```python
# Interrompre kernel (execution infinie)
result = await interrupt_kernel(kernel_id="abc123")
print("Kernel interrupted")
```

**APRÈS** (recommandé) :
```python
# Interrompre kernel (execution infinie)
result = await manage_kernel(
    action="interrupt",  # ✨ Action interrupt
    kernel_id="abc123"
)
print("Kernel interrupted")
```

---

#### Exemple 4 : Redémarrer un Kernel

**AVANT** (deprecated) :
```python
# Redémarrer kernel
result = await restart_kernel(kernel_id="abc123")
new_kernel_id = result["kernel_id"]  # ⚠️ NOUVEAU ID !
print(f"Kernel restarted with new ID: {new_kernel_id}")
```

**APRÈS** (recommandé) :
```python
# Redémarrer kernel
result = await manage_kernel(
    action="restart",    # ✨ Action restart
    kernel_id="abc123"
)
old_id = result["old_kernel_id"]  # ✨ Ancien ID préservé
new_id = result["kernel_id"]      # ✨ Nouveau ID
print(f"Kernel restarted: {old_id} → {new_id}")
```

**⚠️ ATTENTION** : `restart` génère un **NOUVEAU kernel_id** !

---

## 🔧 Migration Assistée

### Script de Migration Automatique (Expérimental)

Nous préparons un script pour faciliter la migration automatique :

```python
# migrate_to_consolidated_api.py (à venir)
from papermill_mcp.migration import auto_migrate

# Analyse votre code
auto_migrate.scan_codebase("./src")

# Génère rapport de migration
report = auto_migrate.generate_report()

# Applique corrections (mode dry-run par défaut)
auto_migrate.apply_fixes(dry_run=True)
```

**Status** : 🚧 En développement

---

## 📋 Checklist Migration

### Avant de Commencer

- [ ] Lire ce guide complet
- [ ] Consulter [RAPPORT_FINAL_CONSOLIDATION_MCP_JUPYTER.md](RAPPORT_FINAL_CONSOLIDATION_MCP_JUPYTER.md)
- [ ] Identifier les outils utilisés dans votre code
- [ ] Planifier migration progressive (par module/feature)

### Pendant la Migration

- [ ] Migrer un outil à la fois
- [ ] Tester chaque migration (tests unitaires)
- [ ] Valider backward compatibility (anciens appels fonctionnent)
- [ ] Documenter changements (changelog projet)

### Après Migration

- [ ] Tests d'intégration complets
- [ ] Revue de code (peer review)
- [ ] Déploiement progressif (staging → prod)
- [ ] Monitoring (logs warnings deprecated)

---

## ❓ FAQ (Questions Fréquentes)

### Q1 : Mon code legacy va-t-il continuer de fonctionner ?

**R** : ✅ **OUI, à 100% !** Tous les anciens outils sont wrappés et fonctionnent exactement comme avant. Seuls des warnings sont loggés pour vous inciter à migrer.

---

### Q2 : Quand les anciens outils seront-ils supprimés ?

**R** : ⏱️ **Pas avant 12 mois minimum.** Vous avez largement le temps de migrer progressivement.

**Timeline** :
- **0-6 mois** : Période transition (warnings soft)
- **6-12 mois** : Dépréciation soft (warnings explicites)
- **12+ mois** : Dépréciation hard (suppression wrappers)

---

### Q3 : Dois-je tout migrer d'un coup ?

**R** : ❌ **NON !** Migrez **progressivement** :
1. Commencez par un module isolé
2. Testez thoroughly
3. Migrez module suivant
4. Répétez jusqu'à migration complète

---

### Q4 : Quels sont les bénéfices concrets de la migration ?

**R** : 🎯 **Multiples avantages** :
- ✨ API 74% plus simple (découvrabilité)
- 📖 Documentation centralisée et claire
- 🛡️ Type-safety avec `Literal` types
- 🚀 Futures fonctionnalités (nouvelle API uniquement)
- 🧹 Code plus maintenable

---

### Q5 : Que faire si je rencontre un problème ?

**R** : 🆘 **Support disponible** :
1. Consulter [README.md](README.md) (exemples)
2. Lire [RAPPORT_FINAL_CONSOLIDATION_MCP_JUPYTER.md](RAPPORT_FINAL_CONSOLIDATION_MCP_JUPYTER.md) (détails techniques)
3. Ouvrir une issue GitHub
4. Contacter l'équipe support

---

### Q6 : Les performances sont-elles impactées ?

**R** : ✅ **ZÉRO impact !** Les wrappers deprecated appellent directement les nouveaux outils. C'est transparent au niveau performance.

---

### Q7 : Puis-je mélanger ancien et nouveau code ?

**R** : ✅ **OUI !** Vous pouvez utiliser anciens et nouveaux outils côte-à-côte pendant la migration. Pas de conflit.

---

### Q8 : Comment savoir si j'utilise des outils deprecated ?

**R** : 📊 **Plusieurs méthodes** :
1. Chercher warnings dans vos logs
2. Utiliser linter/analyzer (à venir)
3. Audit manuel (grep deprecated tools)

---

### Q9 : Y a-t-il des breaking changes ?

**R** : ❌ **AUCUN breaking change !** L'architecture consolidée garantit 100% backward compatibility via wrappers.

**Exception** : Si vous supprimez manuellement un wrapper deprecated, alors oui, votre code cassera. Mais ce n'est pas recommandé durant la période de transition.

---

### Q10 : Comment contribuer à l'amélioration de la nouvelle API ?

**R** : 💡 **Feedback bienvenu !**
1. Ouvrir issues GitHub (suggestions/bugs)
2. Proposer pull requests (améliorations)
3. Partager retours d'expérience
4. Participer aux discussions

---

## 📚 Ressources Complémentaires

### Documentation Technique

- [README.md](README.md) - Guide utilisateur principal
- [RAPPORT_FINAL_CONSOLIDATION_MCP_JUPYTER.md](RAPPORT_FINAL_CONSOLIDATION_MCP_JUPYTER.md) - Rapport final complet
- [CHANGELOG_CONSOLIDATION_PHASE*.md](.) - Détails par phase
- [SPECIFICATIONS_API_CONSOLIDEE.md](docs/consolidation/specifications/SPECIFICATIONS_API_CONSOLIDEE.md) - Spécifications API

### Tests et Exemples

- `tests/test_*_consolidation.py` - Tests unitaires (133 tests)
- `examples/` - Exemples d'utilisation (à venir)

### Support

- **Issues GitHub** : Pour rapporter bugs/questions
- **Documentation** : Inline docstrings dans le code
- **Community** : Forums et discussions

---

## 🎓 Conclusion

La migration vers l'API consolidée est un investissement qui :
- ✅ Simplifie votre code (-74% outils)
- ✅ Améliore maintenabilité
- ✅ Garantit futur-proof (nouvelle API supportée long-terme)
- ✅ Se fait progressivement (12 mois de transition)

**Commencez dès aujourd'hui !** 🚀

---

**Date** : 10 Octobre 2025  
**Version** : 2.0 (Post-Consolidation)  
**Auteur** : Équipe MCP Jupyter-Papermill  
**Méthodologie** : SDDD (Semantic-Documentation-Driven-Design)

---

*Fin du Guide de Migration - Bonne migration !* 🎯