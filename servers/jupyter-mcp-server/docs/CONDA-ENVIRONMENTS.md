# Gestion d'Environnement Conda

Le serveur MCP Jupyter fournit des outils intégrés pour gérer les environnements Conda, permettant de créer, vérifier et gérer les environnements Python directement depuis Roo.
## Setup Automatique (Recommandé)

### Outil `setup_jupyter_mcp_environment`

**Nouveau!** Un outil de configuration automatique qui installe/répare l'environnement MCP Jupyter sans nécessiter de paramètres complexes. Toute la configuration est intégrée.

**Avantages :**
- ✅ Configuration intégrée (pas besoin de mémoriser les paramètres)
- ✅ Gestion intelligente (crée, met à jour ou vérifie selon l'état actuel)
- ✅ Auto-détection des packages manquants
- ✅ Retour structuré et détaillé

**Paramètres (tous optionnels) :**
- `force` (défaut: false) : Si true, supprime et recrée l'environnement s'il existe
- `additional_packages` : Liste de packages supplémentaires à installer

**Configuration intégrée :**
```typescript
{
  name: "mcp-jupyter-py310",
  python_version: "3.10",
  required_packages: [
    "papermill",
    "jupyter",
    "ipykernel", 
    "ipython",
    "nbformat",
    "nbconvert"
  ]
}
```

**Exemple d'utilisation (le plus simple) :**
```typescript
// Sans aucun paramètre - la configuration est intégrée !
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "setup_jupyter_mcp_environment",
  arguments: {}
});

console.log(result);
// {
//   success: true,
//   action: "created" | "updated" | "verified",
//   environment: {
//     name: "mcp-jupyter-py310",
//     path: "C:\\Users\\...\\envs\\mcp-jupyter-py310",
//     python_version: "3.10"
//   },
//   packages: {
//     installed: ["papermill", "jupyter", ...],
//     already_present: [],
//     failed: []
//   },
//   message: "Environnement 'mcp-jupyter-py310' créé avec succès..."
// }
```

**Avec options avancées :**
```typescript
// Forcer la recréation complète
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "setup_jupyter_mcp_environment",
  arguments: {
    force: true
  }
});

// Ajouter des packages supplémentaires
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "setup_jupyter_mcp_environment",
  arguments: {
    additional_packages: ["pandas", "matplotlib"]
  }
});
```

**Comportement intelligent :**
1. **Si l'environnement n'existe pas** → Crée avec tous les packages requis
2. **Si l'environnement existe et `force=false`** → Vérifie et installe uniquement les packages manquants
3. **Si l'environnement existe et `force=true`** → Supprime et recrée complètement

---


## Outils disponibles

### 1. `list_conda_environments`

Liste tous les environnements Conda disponibles sur le système.

**Paramètres :** Aucun

**Exemple d'utilisation :**
```typescript
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "list_conda_environments",
  arguments: {}
});
```

**Résultat :**
```json
{
  "status": "success",
  "environments": [
    {
      "name": "base",
      "path": "C:\\Users\\username\\anaconda3",
      "isActive": true
    },
    {
      "name": "mcp-jupyter-py310",
      "path": "C:\\Users\\username\\anaconda3\\envs\\mcp-jupyter-py310",
      "isActive": false
    }
  ],
  "count": 2
}
```

### 2. `create_conda_environment`

Crée un nouvel environnement Conda avec la version Python et les packages spécifiés.

**Paramètres :**
- `name` (requis) : Nom de l'environnement à créer
- `python_version` (optionnel, défaut: "3.10") : Version de Python à installer
- `packages` (optionnel) : Liste de packages à installer lors de la création
- `force` (optionnel, défaut: false) : Si true, supprime et recrée l'environnement s'il existe déjà

**Exemple d'utilisation :**
```typescript
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "create_conda_environment",
  arguments: {
    name: "mcp-jupyter-py310",
    python_version: "3.10",
    packages: ["papermill", "jupyter", "ipykernel", "ipython"]
  }
});
```

**Résultat :**
```json
{
  "status": "success",
  "message": "Environnement 'mcp-jupyter-py310' créé avec succès",
  "name": "mcp-jupyter-py310",
  "python_version": "3.10",
  "packages": ["papermill", "jupyter", "ipykernel", "ipython"],
  "output": "...",
  "warnings": ""
}
```

### 3. `install_conda_packages`

Installe des packages dans un environnement Conda existant.

**Paramètres :**
- `env_name` (requis) : Nom de l'environnement cible
- `packages` (requis) : Liste des packages à installer
- `channel` (optionnel) : Canal Conda à utiliser (ex: "conda-forge")

**Exemple d'utilisation :**
```typescript
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "install_conda_packages",
  arguments: {
    env_name: "mcp-jupyter-py310",
    packages: ["pandas", "numpy", "matplotlib"],
    channel: "conda-forge"
  }
});
```

**Résultat :**
```json
{
  "status": "success",
  "message": "Packages installés avec succès dans l'environnement 'mcp-jupyter-py310'",
  "env_name": "mcp-jupyter-py310",
  "packages": ["pandas", "numpy", "matplotlib"],
  "channel": "conda-forge",
  "output": "...",
  "warnings": ""
}
```

### 4. `check_conda_environment`

Vérifie l'existence d'un environnement Conda et optionnellement la présence de packages spécifiques.

**Paramètres :**
- `env_name` (requis) : Nom de l'environnement à vérifier
- `required_packages` (optionnel) : Liste de packages dont on veut vérifier l'installation

**Exemple d'utilisation :**
```typescript
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "check_conda_environment",
  arguments: {
    env_name: "mcp-jupyter-py310",
    required_packages: ["papermill", "jupyter", "ipykernel"]
  }
});
```

**Résultat (environnement existant avec tous les packages) :**
```json
{
  "status": "success",
  "exists": true,
  "path": "C:\\Users\\username\\anaconda3\\envs\\mcp-jupyter-py310",
  "missingPackages": [],
  "installedPackages": ["papermill", "jupyter", "ipykernel"],
  "message": "L'environnement existe et tous les packages requis sont installés"
}
```

**Résultat (packages manquants) :**
```json
{
  "status": "success",
  "exists": true,
  "path": "C:\\Users\\username\\anaconda3\\envs\\mcp-jupyter-py310",
  "missingPackages": ["papermill"],
  "installedPackages": ["jupyter", "ipykernel"],
  "message": "L'environnement existe mais 1 package(s) manquent"
}
```

**Résultat (environnement inexistant) :**
```json
{
  "status": "success",
  "exists": false,
  "message": "L'environnement 'mcp-jupyter-py310' n'existe pas"
}
```

## Cas d'usage pratiques

### Workflow complet : Restaurer un environnement manquant

```typescript
// 1. Vérifier si l'environnement existe
const checkResult = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "check_conda_environment",
  arguments: {
    env_name: "mcp-jupyter-py310",
    required_packages: ["papermill", "jupyter", "ipykernel", "ipython"]
  }
});

if (!checkResult.exists) {
  // 2. Créer l'environnement s'il n'existe pas
  const createResult = await use_mcp_tool({
    server_name: "jupyter",
    tool_name: "create_conda_environment",
    arguments: {
      name: "mcp-jupyter-py310",
      python_version: "3.10",
      packages: ["papermill", "jupyter", "ipykernel", "ipython"]
    }
  });
  
  console.log("Environnement créé :", createResult);
} else if (checkResult.missingPackages && checkResult.missingPackages.length > 0) {
  // 3. Installer les packages manquants
  const installResult = await use_mcp_tool({
    server_name: "jupyter",
    tool_name: "install_conda_packages",
    arguments: {
      env_name: "mcp-jupyter-py310",
      packages: checkResult.missingPackages
    }
  });
  
  console.log("Packages installés :", installResult);
}

// 4. Lister tous les environnements pour confirmation
const listResult = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "list_conda_environments",
  arguments: {}
});

console.log("Environnements disponibles :", listResult);
```

### Créer un environnement de test

```typescript
// Créer un environnement de test avec des packages de base
const result = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "create_conda_environment",
  arguments: {
    name: "test-jupyter",
    python_version: "3.11",
    packages: ["jupyter", "ipykernel"]
  }
});

// Ajouter des packages supplémentaires
if (result.status === "success") {
  await use_mcp_tool({
    server_name: "jupyter",
    tool_name: "install_conda_packages",
    arguments: {
      env_name: "test-jupyter",
      packages: ["pandas", "matplotlib", "seaborn"],
      channel: "conda-forge"
    }
  });
}
```

### Audit des environnements

```typescript
// Lister tous les environnements
const envList = await use_mcp_tool({
  server_name: "jupyter",
  tool_name: "list_conda_environments",
  arguments: {}
});

// Vérifier chaque environnement pour des packages spécifiques
for (const env of envList.environments) {
  const check = await use_mcp_tool({
    server_name: "jupyter",
    tool_name: "check_conda_environment",
    arguments: {
      env_name: env.name,
      required_packages: ["jupyter", "ipykernel"]
    }
  });
  
  console.log(`${env.name}: ${check.message}`);
}
```

## Gestion des erreurs

### Conda non installé

Si Conda n'est pas installé ou n'est pas dans le PATH, tous les outils retourneront :

```json
{
  "status": "error",
  "message": "Conda n'est pas installé ou n'est pas accessible dans le PATH"
}
```

**Solution :** Installez Anaconda ou Miniconda et assurez-vous que `conda` est dans votre PATH.

### Environnement déjà existant

Si vous tentez de créer un environnement qui existe déjà sans `force=true` :

```json
{
  "status": "error",
  "message": "L'environnement 'nom-env' existe déjà. Utilisez force=true pour le recréer.",
  "existingPath": "C:\\Users\\username\\anaconda3\\envs\\nom-env"
}
```

**Solution :** Utilisez `force: true` dans les arguments ou choisissez un autre nom.

### Environnement inexistant (installation de packages)

Si vous tentez d'installer des packages dans un environnement qui n'existe pas :

```json
{
  "status": "error",
  "message": "L'environnement 'nom-env' n'existe pas. Créez-le d'abord avec create_conda_environment."
}
```

**Solution :** Créez l'environnement avec `create_conda_environment` avant d'installer des packages.

## Bonnes pratiques

1. **Toujours vérifier avant de créer** : Utilisez `check_conda_environment` avant `create_conda_environment` pour éviter les erreurs.

2. **Installation incrémentale** : Pour de gros environnements, créez d'abord l'environnement avec les packages de base, puis installez les packages supplémentaires avec `install_conda_packages`.

3. **Utiliser des canaux spécifiques** : Certains packages sont mieux maintenus sur `conda-forge`, utilisez le paramètre `channel` si nécessaire.

4. **Nommage cohérent** : Utilisez des noms d'environnement descriptifs qui incluent la version Python (ex: `projet-py310`, `datascience-py311`).

5. **Documentation des dépendances** : Après avoir créé un environnement, documentez les packages installés pour faciliter la reproduction.

## Intégration avec Docker

Ces outils sont particulièrement utiles lors de l'intégration Docker + MCP. Si un environnement Conda est manquant dans le conteneur, vous pouvez :

1. Le détecter avec `check_conda_environment`
2. Le créer automatiquement avec `create_conda_environment`
3. Vérifier sa création avec `list_conda_environments`
4. L'utiliser avec `start_jupyter_server` en passant le chemin de l'environnement

## Limitations

- Ces outils nécessitent que Conda soit installé et accessible dans le PATH
- La création d'environnements peut prendre plusieurs minutes selon le nombre de packages
- Les opérations Conda sont synchrones et peuvent bloquer le serveur pendant leur exécution
- Les buffers de sortie sont limités à 10MB pour éviter les problèmes de mémoire

## Prochaines étapes

- [Retour à la documentation principale](../README.md)
- [Configuration du serveur](CONFIGURATION.md)
- [Utilisation générale](USAGE.md)
- [Dépannage](TROUBLESHOOTING.md)