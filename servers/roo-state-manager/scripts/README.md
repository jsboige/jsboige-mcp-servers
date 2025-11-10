# 📚 Scripts Consolidés roo-state-manager

## 🎯 Vue d'ensemble

Ce répertoire contient les scripts consolidés et paramétrables qui remplacent les multiples scripts existants dans le projet roo-state-manager. L'objectif est de simplifier la maintenance, réduire la duplication et fournir une interface unifiée pour toutes les opérations courantes.

### 📊 Réduction de complexité

| Scripts originaux | Scripts consolidés | Réduction |
|------------------|-------------------|------------|
| 60+ scripts | 6 scripts principaux | **90%** |
| 4 scripts de test | `roo-tests.ps1` | **75%** |
| 2 scripts de déploiement | `roo-deploy.ps1` | **50%** |
| 6+ scripts de diagnostic | `roo-diagnose.ps1` | **83%** |
| 3 scripts de cache | `roo-cache.ps1` | **67%** |

---

## 🚀 Scripts Principaux

### 1. 🧪 `roo-tests.ps1` - Tests Unifiés

Script principal pour l'exécution des tests, remplaçant :
- `run-tests.ps1`
- `run-tests-simple.ps1`
- `run-validation-tests.ps1`
- `diagnose-tests-with-logging.ps1`

#### 🎯 Utilisation de base

```powershell
# Commande SIMPLE ET MÉMORABLE pour les tests unitaires
.\roo-tests.ps1 -Type unit
```

#### 📋 Paramètres disponibles

| Paramètre | Valeurs | Description |
|-----------|----------|-------------|
| `-Type` | `unit`, `integration`, `e2e`, `detector`, `all` | Type de tests à exécuter |
| `-Output` | `console`, `json`, `markdown`, `all` | Format de sortie |
| `-Diagnostic` | - | Active le diagnostic système complet |
| `-Audit` | - | Génère un audit complet de l'arborescence |
| `-Verbose` | - | Active le logging verbeux |
| `-Config` | chemin | Fichier de configuration (défaut: `config/test-config.json`) |

#### 💡 Exemples pratiques

```powershell
# Tests unitaires avec sortie détaillée
.\roo-tests.ps1 -Type unit -Verbose

# Tous les tests avec rapports multiples
.\roo-tests.ps1 -Type all -Output all

# Diagnostic complet avant tests
.\roo-tests.ps1 -Diagnostic -Type unit

# Audit complet avec rapport markdown
.\roo-tests.ps1 -Audit -Report
```

---

### 2. 🚀 `roo-deploy.ps1` - Déploiement Unifié

Script pour le déploiement complet, remplaçant :
- `deploy.ps1`
- `deploy-simple.ps1`

#### 🎯 Utilisation de base

```powershell
# Installation complète
.\roo-deploy.ps1 -Deploy
```

#### 📋 Paramètres disponibles

| Paramètre | Description |
|-----------|-------------|
| `-Install` | Installe les dépendances npm |
| `-Build` | Compile le projet TypeScript |
| `-Test` | Lance les tests de validation |
| `-Configure` | Configure le serveur MCP |
| `-Deploy` | Installation complète (install + build + test) |
| `-SkipPrereqs` | Saute la vérification des prérequis |
| `-Verbose` | Active le logging verbeux |

#### 💡 Exemples pratiques

```powershell
# Déploiement complet
.\roo-deploy.ps1 -Deploy

# Étapes séparées
.\roo-deploy.ps1 -Install -Build -Test

# Tests uniquement
.\roo-deploy.ps1 -Test -Verbose

# Configuration MCP uniquement
.\roo-deploy.ps1 -Configure
```

---

### 3. 🔍 `roo-diagnose.ps1` - Diagnostic Unifié

Script pour le diagnostic complet, remplaçant :
- `diagnose-skeleton-cache.ps1`
- `diagnose-skeleton-cache.mjs`
- `audit-tests.ps1`
- `diagnose-tests-with-logging.ps1`

#### 🎯 Utilisation de base

```powershell
# Diagnostic complet du système
.\roo-diagnose.ps1 -Type system
```

#### 📋 Paramètres disponibles

| Paramètre | Valeurs | Description |
|-----------|----------|-------------|
| `-Type` | `cache`, `tests`, `environment`, `system`, `all` | Type de diagnostic |
| `-Output` | `console`, `json`, `markdown`, `all` | Format de sortie |
| `-Detailed` | - | Active le mode détaillé |
| `-Verbose` | - | Active le logging verbeux |

#### 💡 Exemples pratiques

```powershell
# Diagnostic complet
.\roo-diagnose.ps1

# Diagnostic du cache avec rapport
.\roo-diagnose.ps1 -Type cache -Output markdown

# Validation environnement
.\roo-diagnose.ps1 -Type environment -Verbose
```

---

### 4. 💾 `roo-cache.ps1` - Gestion Cache Unifiée

Script pour la gestion du cache skeleton, remplaçant :
- `build-cache-direct.mjs`
- `test-build-skeleton-cache-direct.ps1`
- `diagnose-skeleton-cache.ps1`

#### 🎯 Utilisation de base

```powershell
# Construction du cache
.\roo-cache.ps1 -Build
```

#### 📋 Paramètres disponibles

| Paramètre | Valeurs | Description |
|-----------|----------|-------------|
| `-Action` | `Build`, `Validate`, `Clean`, `Diagnose`, `Status` | Action à effectuer |
| `-Force` | - | Force la reconstruction complète |
| `-Output` | `console`, `json`, `markdown`, `all` | Format de sortie |
| `-Verbose` | - | Active le logging verbeux |

#### 💡 Exemples pratiques

```powershell
# Construire le cache
.\roo-cache.ps1 -Build

# Forcer la reconstruction
.\roo-cache.ps1 -Build -Force

# Valider le cache existant
.\roo-cache.ps1 -Validate -Verbose

# Nettoyer le cache
.\roo-cache.ps1 -Clean

# Diagnostic complet du cache
.\roo-cache.ps1 -Diagnose -Output markdown
```

---

## 📁 Structure des Fichiers

```
scripts/
├── 📁 consolidated/          # Scripts consolidés (NOUVEAU)
│   ├── roo-tests.ps1       # Tests unifiés
│   ├── roo-deploy.ps1      # Déploiement unifié
│   ├── roo-diagnose.ps1    # Diagnostic unifié
│   └── roo-cache.ps1       # Gestion cache unifiée
├── 📁 config/               # Fichiers de configuration
│   ├── test-config.json     # Configuration des tests
│   └── deploy-config.json   # Configuration déploiement
├── 📁 legacy/               # Scripts originaux archivés
│   └── [tous les scripts existants]
└── 📄 README.md            # Cette documentation
```

---

## 🎯 Commandes Essentielles

### 🧪 **COMMANDE SPÉCIFIQUE POUR LES TESTS UNITAIRES**

```powershell
# LA COMMANDE LA PLUS SIMPLE ET MÉMORABLE
.\roo-tests.ps1 -Type unit
```

### 🚀 **Workflow de Développement Complet**

```powershell
# 1. Nettoyer l'environnement
.\roo-cache.ps1 -Clean

# 2. Construire le cache
.\roo-cache.ps1 -Build

# 3. Lancer les tests unitaires
.\roo-tests.ps1 -Type unit -Verbose

# 4. Diagnostic si problèmes
.\roo-diagnose.ps1 -Type system
```

### 🔧 **Workflow de Déploiement**

```powershell
# Déploiement complet en une commande
.\roo-deploy.ps1 -Deploy

# Ou étape par étape
.\roo-deploy.ps1 -Install
.\roo-deploy.ps1 -Build
.\roo-deploy.ps1 -Test
```

---

## 📊 Fichiers de Configuration

### `config/test-config.json`

Configuration pour les types de tests, sorties et logging :

```json
{
  "testTypes": {
    "unit": {
      "pattern": "tests/unit/**/*.test.ts",
      "timeout": 30000,
      "description": "Tests unitaires isolés"
    },
    "integration": {
      "pattern": "tests/integration/**/*.test.ts",
      "timeout": 60000,
      "description": "Tests d'intégration système"
    }
  },
  "output": {
    "formats": ["console", "json", "markdown"],
    "directory": "./test-results"
  }
}
```

### `config/deploy-config.json`

Configuration pour les étapes de déploiement et prérequis :

```json
{
  "prerequisites": {
    "node": { "minVersion": "18.0.0", "required": true },
    "npm": { "minVersion": "8.0.0", "required": true }
  },
  "steps": {
    "install": {
      "command": "npm install",
      "description": "Installation des dépendances",
      "timeout": 300000
    }
  }
}
```

---

## 🔄 Migration depuis les Anciens Scripts

### Tableau de correspondance

| Ancien script | Nouveau script | Commande équivalente |
|---------------|----------------|---------------------|
| `run-tests.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1` |
| `run-tests-simple.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1 -Output console` |
| `deploy.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 -Deploy` |
| `deploy-simple.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 -Deploy` |
| `diagnose-skeleton-cache.ps1` | `roo-diagnose.ps1` | `.\roo-diagnose.ps1 -Type cache` |
| `build-cache-direct.mjs` | `roo-cache.ps1` | `.\roo-cache.ps1 -Build` |

### 🚨 Actions requises pour la migration

1. **Mettre à jour les scripts CI/CD** :
   ```bash
   # Ancien
   ./scripts/run-tests.ps1
   
   # Nouveau
   ./scripts/consolidated/roo-tests.ps1 -Type unit
   ```

2. **Mettre à jour la documentation locale** :
   - Remplacer les références aux anciens scripts
   - Ajouter les nouvelles commandes dans les README

3. **Former l'équipe** :
   - Partager cette documentation
   - Organiser une session de démonstration

---

## 🛠️ Dépannage et FAQ

### ❌ Problèmes courants

**Q: Les scripts ne se lancent pas avec l'erreur "fichier non trouvé"**
```powershell
# Solution : Vérifier le répertoire courant
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
```

**Q: Les tests échouent avec "module non trouvé"**
```powershell
# Solution : Installer les dépendances
.\roo-deploy.ps1 -Install
```

**Q: Le cache ne se construit pas**
```powershell
# Solution : Forcer la reconstruction
.\roo-cache.ps1 -Build -Force
```

### 🔧 Diagnostic rapide

```powershell
# Diagnostic complet du système
.\roo-diagnose.ps1 -Type system -Verbose

# Validation du cache
.\roo-cache.ps1 -Validate

# Test des prérequis
.\roo-deploy.ps1 -Install -SkipPrereqs
```

---

## 📈 Avantages de la Consolidation

### ✅ **Pour les développeurs**

1. **Commandes simplifiées** : Une seule commande à mémoriser
2. **Paramètres unifiés** : Mêmes options sur tous les scripts
3. **Logging cohérent** : Format de sortie standardisé
4. **Documentation centralisée** : Un seul fichier à consulter

### ✅ **Pour la maintenance**

1. **Réduction du code** : 90% de lignes de code en moins
2. **Moins de bugs** : Logique centralisée et testée
3. **Mises à jour facilitées** : Un seul fichier à modifier
4. **Tests automatisés** : Validation intégrée

### ✅ **Pour l'écosystème**

1. **Intégration continue** : Scripts compatibles CI/CD
2. **Monitoring** : Métriques et rapports standardisés
3. **Extensibilité** : Architecture modulaire et évolutive

---

## 🚀 Évolutions Futures

### 📋 Roadmap prévue

1. **Phase 1** : Stabilisation des scripts actuels
2. **Phase 2** : Ajout des scripts d'analyse et de workflow
3. **Phase 3** : Interface web et monitoring
4. **Phase 4** : Intelligence artificielle pour les diagnostics

### 🛠️ Contribuer

Pour proposer des améliorations :

1. Créer une issue dans le projet
2. Décrire le cas d'usage et le problème
3. Proposer une solution avec exemples
4. Soumettre une pull request avec tests

---

## 📞 Support et Assistance

### 📚 Ressources

- **Documentation principale** : Ce fichier README.md
- **Configuration** : Fichiers dans `config/`
- **Exemples** : Scripts dans `consolidated/`

### 🆘 Obtenir de l'aide

```powershell
# Aide détaillée pour chaque script
.\roo-tests.ps1 -Help
.\roo-deploy.ps1 -Help
.\roo-diagnose.ps1 -Help
.\roo-cache.ps1 -Help
```

### 🐛 Signaler un problème

1. Exécuter avec `-Verbose` pour obtenir des détails
2. Consulter les logs générés dans les répertoires de sortie
3. Utiliser le diagnostic système : `.\roo-diagnose.ps1 -Type system`
4. Créer une issue avec les logs complets

---

## 📜 Licence et Maintenance

Ce projet est maintenu par l'équipe roo-state-manager et suit les principes de :

- **Simplicité** : Interfaces claires et minimales
- **Robustesse** : Gestion d'erreurs complète
- **Documentation** : Auto-documentation intégrée
- **Évolutivité** : Architecture modulaire

---

**Dernière mise à jour** : 06/11/2025  
**Version** : 1.0.0  
**Statut** : Production ✅