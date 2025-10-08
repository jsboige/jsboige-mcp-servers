
# Configuration de l'Environnement Conda pour le Serveur MCP Jupyter

Ce document fournit les instructions complètes pour configurer l'environnement Conda requis par le `jupyter-papermill-mcp-server`. Il est basé sur les conclusions des rapports SDDD (Solution-Driven Development / Semantic-Documentation-Driven-Design) qui ont identifié une architecture stable et performante.

## 1. Prérequis Environnement Conda Obligatoires

Pour garantir le fonctionnement stable et performant du serveur, les composants suivants sont requis. Le non-respect de cette configuration est la source la plus probable d'erreurs, notamment avec le kernel .NET.

- **Environnement Conda Spécifique :**
  - **Nom :** `mcp-jupyter-py310`
  - **Version de Python :** `3.10.x`

- **Dépendances Système :**
  - **SDK .NET :** Le SDK .NET (actuellement .NET 9.0) doit être installé au niveau du système et accessible. C'est un prérequis pour le kernel .NET Interactive.

- **Kernels Jupyter :**
  - **Python 3 :** Installé par défaut avec `ipykernel`.
  - **.NET Interactive :** Pour l'exécution de notebooks C#, F#, et PowerShell.

- **Packages Python Principaux :**
  - `papermill` : Pour l'exécution et la paramétrisation des notebooks.
  - `jupyter` et son écosystème (`ipykernel`, `nbformat`, `jupyter_client`, etc.).

---

## 2. Instructions d'Installation Step-by-Step

Suivez ces étapes pour créer un environnement propre et fonctionnel.

### Étape 1 : Créer l'environnement Conda

Ouvrez un terminal et exécutez la commande suivante pour créer l'environnement avec la version de Python requise :

```bash
conda create -n mcp-jupyter-py310 python=3.10
```

### Étape 2 : Activer l'environnement

Activez le nouvel environnement pour y installer les packages :

```bash
conda activate mcp-jupyter-py310
```

### Étape 3 : Installer les packages Python

Installez Papermill et l'écosystème Jupyter :

```bash
pip install papermill "jupyter-client>=8.0.0" "jupyter-core>=5.0.0" ipykernel nbformat
```

### Étape 4 : Installer le Kernel .NET Interactive

Le kernel .NET Interactive s'installe via Conda depuis le channel `conda-forge` pour une intégration optimale :

```bash
conda install -c conda-forge dotnet-interactive
```
Cette commande gère l'installation et l'enregistrement du kernel auprès de Jupyter.

### Étape 5 : Validation de l'Installation

Une fois l'installation terminée, utilisez les commandes de diagnostic de la section 4 pour valider que tous les composants sont correctement configurés.

---

## 3. Résolution des Problèmes Courants

### Erreur : "Value cannot be null" ou échecs NuGet avec le kernel .NET

- **Cause Racine :** C'est l'erreur la plus critique identifiée durant les investigations SDDD. Elle est presque toujours causée par une tentative de sur-ingénierie consistant à manipuler manuellement les variables d'environnement (`PACKAGEMANAGEMENT_HOME`, `DOTNET_ROOT`, etc.) dans le but d'isoler l'exécution. Cette pratique entre en conflit direct avec la manière dont le kernel .NET gère ses propres dépendances et son cache NuGet.

- **Solution :** **NE PAS** manipuler ces variables d'environnement. L'architecture "Solution A" (voir section 5) est conçue pour déléguer entièrement la gestion de l'environnement à Papermill et Jupyter. Assurez-vous que le SDK .NET est correctement installé au niveau système et que l'environnement Conda est propre.

### Problème : Timeouts ou Performance Lente

- **Cause Racine :** Les anciennes versions du serveur MCP utilisaient un sous-processus (`conda run...`) pour encapsuler les appels Papermill. Cette approche ajoutait un surcoût considérable, provoquant des timeouts même sur des notebooks simples.

- **Solution :** Ce problème est résolu par l'architecture "Solution A" qui utilise un appel direct à l'API `papermill.execute_notebook`. Si vous rencontrez des lenteurs, assurez-vous d'utiliser la dernière version du serveur MCP et que votre environnement n'est pas corrompu.

---

## 4. Commandes de Diagnostic

### Validation de l'environnement Conda

Vérifiez que l'environnement `mcp-jupyter-py310` existe :

```bash
conda info --envs
```
*Vous devriez voir `mcp-jupyter-py310` dans la liste.*

### Validation des Kernels Jupyter

Listez les kernels que Jupyter peut utiliser. Assurez-vous que `python3` et les kernels `.net-*` apparaissent :

```bash
jupyter kernelspec list
```
*Sortie attendue (les chemins peuvent varier) :*
```
Available kernels:
  .net-csharp        C:\Users\...\AppData\Roaming\jupyter\kernels\.net-csharp
  .net-fsharp        C:\Users\...\AppData\Roaming\jupyter\kernels\.net-fsharp
  .net-powershell    C:\Users\...\AppData\Roaming\jupyter\kernels\.net-powershell
  python3            C:\Users\...\.conda\envs\mcp-jupyter-py310\share\jupyter\kernels\python3
```

### Validation de Papermill

Vérifiez que Papermill est bien installé dans l'environnement actif :

```bash
conda activate mcp-jupyter-py310
python -c "import papermill; print(f'Papermill version: {papermill.__version__}')"
```

---

## 5. Architecture Recommandée : La "Solution A"

L'ensemble de cette configuration repose sur le succès de l'architecture "Solution A", qui est devenue la norme après de multiples investigations.

- **Principe Fond
- **Principe :** Le serveur MCP appelle directement l'API Python `papermill.execute_notebook`. Il n'y a pas de sous-processus, pas de `conda run`, et pas de manipulation manuelle des variables d'environnement.

- **Confiance en l'écosystème :** Cette architecture fait confiance à Papermill et Jupyter pour gérer la découverte et l'exécution des kernels. Si l'environnement Conda est correctement configuré (comme décrit ci-dessus), Papermill trouvera et utilisera le bon kernel (.NET ou Python) sans intervention.

- **Pourquoi ça fonctionne :** En évitant la complexité, on élimine les sources de conflits. Le kernel .NET peut gérer son propre cache NuGet et ses dépendances comme il a été conçu pour le faire, résultant en une exécution stable et performante.

Ce document doit servir de référence unique pour la configuration. Toute déviation de ces instructions est susceptible de réintroduire des instabilités.