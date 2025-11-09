# 📚 Guide d'Utilisation des Scripts Consolidés RooSync v2.1

## 🎯 Vue d'Ensemble

Les scripts consolidés RooSync v2.1 fournissent une interface unifiée pour toutes les opérations de développement, de test et de déploiement. Ils remplacent les multiples scripts disparates par une architecture cohérente et extensible.

## 🚀 Démarrage Rapide

### Installation et Configuration

1. **Assurez-vous d'être dans le bon répertoire** :
```powershell
cd mcps/internal/servers/roo-state-manager
```

2. **Vérifiez la configuration** :
```powershell
# Vérifier les fichiers de configuration
Get-Content scripts/config/test-config.json
Get-Content scripts/config/deploy-config.json
```

3. **Testez l'installation** :
```powershell
.\roo-tests.ps1 -Version
```

## 📋 Scripts Disponibles

### 1. roo-tests.ps1 - Tests Unifiés

**Fonctionnalités principales** :
- Exécution des tests unitaires, d'intégration et E2E
- Gestion de la couverture de code
- Parallélisation des tests pour performance
- Rapports détaillés au format JSON/HTML

**Commandes de base** :
```powershell
# Tests unitaires uniquement
.\roo-tests.ps1 test unit

# Tests d'intégration
.\roo-tests.ps1 test integration

# Tests E2E
.\roo-tests.ps1 test e2e

# Tous les tests
.\roo-tests.ps1 test all

# Tests avec couverture
.\roo-tests.ps1 test coverage

# Tests rapides (mode développement)
.\roo-tests.ps1 test unit -Fast
```

**Options avancées** :
```powershell
# Tests avec sortie détaillée
.\roo-tests.ps1 test all -Verbose -Output json

# Tests avec filtrage par catégorie
.\roo-tests.ps1 test unit -Category "BaselineService"

# Tests avec timeout personnalisé
.\roo-tests.ps1 test all -Timeout 600
```

### 2. roo-deploy.ps1 - Déploiement Automatisé

**Fonctionnalités principales** :
- Déploiement avec validation automatique
- Création de points de restauration
- Rollback instantané en cas d'échec
- Support multi-environnements

**Commandes de base** :
```powershell
# Déploiement en production
.\roo-deploy.ps1 deploy -Environment production

# Déploiement avec backup
.\roo-deploy.ps1 deploy -Environment production -Backup

# Déploiement en mode simulation
.\roo-deploy.ps1 deploy -Environment staging -DryRun

# Rollback vers version précédente
.\roo-deploy.ps1 rollback -Version previous
```

**Options avancées** :
```powershell
# Déploiement avec validation complète
.\roo-deploy.ps1 deploy -Environment production -Validate -Backup

# Déploiement vers environnement spécifique
.\roo-deploy.ps1 deploy -Environment development -Config custom

# Création de point de restauration
.\roo-deploy.ps1 create-restore-point -Name "pre-deployment-$(Get-Date -Format 'yyyyMMdd-HHmm')"
```

### 3. roo-diagnose.ps1 - Diagnostic Système

**Fonctionnalités principales** :
- Analyse complète de l'état du système
- Diagnostic de performance
- Validation de configuration
- Export des rapports en multiple formats

**Commandes de base** :
```powershell
# Diagnostic système complet
.\roo-diagnose.ps1 diagnose system

# Diagnostic de performance
.\roo-diagnose.ps1 diagnose performance

# Diagnostic de configuration
.\roo-diagnose.ps1 diagnose config

# Diagnostic complet (tous les types)
.\roo-diagnose.ps1 diagnose all
```

**Options avancées** :
```powershell
# Diagnostic avec export JSON
.\roo-diagnose.ps1 diagnose all -Export json -Output "./diagnostic-report.json"

# Diagnostic avec analyse approfondie
.\roo-diagnose.ps1 diagnose system -Deep -Verbose

# Diagnostic avec filtrage par composant
.\roo-diagnose.ps1 diagnose performance -Component "BaselineService"
```

### 4. roo-cache.ps1 - Gestion Optimisée des Caches

**Fonctionnalités principales** :
- Construction intelligente des caches
- Nettoyage automatique
- Optimisation des performances
- Gestion de l'espace disque

**Commandes de base** :
```powershell
# Construction du cache
.\roo-cache.ps1 build

# Nettoyage du cache
.\roo-cache.ps1 clean

# Optimisation du cache
.\roo-cache.ps1 optimize

# Statistiques du cache
.\roo-cache.ps1 stats
```

**Options avancées** :
```powershell
# Reconstruction complète du cache
.\roo-cache.ps1 build -Force

# Nettoyage avec seuil personnalisé
.\roo-cache.ps1 clean -Threshold 500MB

# Optimisation agressive
.\roo-cache.ps1 optimize -Aggressive -Compress

# Statistiques détaillées
.\roo-cache.ps1 stats -Detailed -Export json
```

## ⚙️ Configuration

### Fichiers de Configuration

Les scripts utilisent des fichiers de configuration JSON situés dans `scripts/config/` :

#### test-config.json
```json
{
  "timeout": 300,
  "parallel": true,
  "coverage": {
    "enabled": true,
    "threshold": 80,
    "formats": ["html", "json"]
  },
  "categories": {
    "unit": {
      "pattern": "*.test.ts",
      "timeout": 30
    },
    "integration": {
      "pattern": "*.integration.test.ts",
      "timeout": 120
    },
    "e2e": {
      "pattern": "*.e2e.test.ts",
      "timeout": 300
    }
  }
}
```

#### deploy-config.json
```json
{
  "environments": {
    "development": {
      "backup": false,
      "validation": "basic",
      "rollback_enabled": true
    },
    "staging": {
      "backup": true,
      "validation": "full",
      "rollback_enabled": true
    },
    "production": {
      "backup": true,
      "validation": "full",
      "rollback_enabled": true,
      "approval_required": true
    }
  },
  "backup": {
    "retention_days": 30,
    "compression": true,
    "location": "./backups/"
  }
}
```

### Variables d'Environnement

Les scripts respectent les variables d'environnement suivantes :

```powershell
# Niveau de verbosité (default: Info)
$env:ROO_LOG_LEVEL = "Debug|Info|Warn|Error"

# Timeout par défaut pour les opérations (default: 300s)
$env:ROO_TIMEOUT = "600"

# Répertoire de travail (default: répertoire courant)
$env:ROO_WORK_DIR = "/path/to/roo-state-manager"

# Mode parallèle (default: true)
$env:ROO_PARALLEL = "true|false"
```

## 🔧 Dépannage

### Problèmes Courants

#### 1. Erreur de Permissions

**Symptôme** : "Access denied" lors de l'exécution des scripts

**Solution** :
```powershell
# Exécuter en tant qu'administrateur
Start-Process PowerShell -Verb RunAs

# Ou vérifier les permissions du répertoire
icacls . /grant "${env:USERNAME}:(OI)(CI)F"
```

#### 2. Timeout des Tests

**Symptôme** : Les tests se terminent par timeout

**Solution** :
```powershell
# Augmenter le timeout
.\roo-tests.ps1 test all -Timeout 600

# Ou exécuter en mode séquentiel
.\roo-tests.ps1 test all -Parallel:$false
```

#### 3. Échec de Déploiement

**Symptôme** : Le déploiement échoue lors de la validation

**Solution** :
```powershell
# Mode simulation pour diagnostiquer
.\roo-deploy.ps1 deploy -DryRun -Verbose

# Rollback automatique
.\roo-deploy.ps1 rollback -Last

# Validation manuelle
.\roo-deploy.ps1 validate -Environment production
```

### Logs et Debug

#### Activation du Mode Debug

```powershell
# Activer les logs détaillés
$env:ROO_LOG_LEVEL = "Debug"

# Exécuter avec logs
.\roo-tests.ps1 test all -Verbose
```

#### Emplacement des Logs

Les scripts génèrent des logs dans `logs/` avec la structure suivante :

```
logs/
├── roo-tests/
│   ├── test-results-20251106-154500.json
│   └── coverage-20251106-154500/
├── roo-deploy/
│   ├── deploy-20251106-154500.log
│   └── rollback-20251106-154500.log
├── roo-diagnose/
│   └── diagnostic-20251106-154500.json
└── roo-cache/
    └── cache-operations-20251106-154500.log
```

## 🚀 Bonnes Pratiques

### Développement

1. **Tests rapides pendant développement** :
```powershell
# Exécuter seulement les tests unitaires pertinents
.\roo-tests.ps1 test unit -Category "CurrentFeature" -Fast
```

2. **Validation avant commit** :
```powershell
# Validation complète
.\roo-tests.ps1 test all -Coverage
.\roo-diagnose.ps1 diagnose config
```

### Déploiement

1. **Déploiement sécurisé** :
```powershell
# Toujours avec backup et validation
.\roo-deploy.ps1 deploy -Environment production -Backup -Validate
```

2. **Vérification post-déploiement** :
```powershell
# Diagnostic complet après déploiement
.\roo-diagnose.ps1 diagnose all -Deep
```

### Maintenance

1. **Nettoyage régulier** :
```powershell
# Nettoyage hebdomadaire des caches
.\roo-cache.ps1 clean -Threshold 1GB

# Optimisation mensuelle
.\roo-cache.ps1 optimize -Aggressive
```

2. **Monitoring** :
```powershell
# Statistiques régulières
.\roo-cache.ps1 stats -Detailed
.\roo-diagnose.ps1 diagnose performance
```

## 📈 Performance et Métriques

### Temps d'Exécution Typiques

| Opération | Temps Moyen | Temps Optimal | Recommandation |
|-----------|--------------|---------------|-----------------|
| Tests unitaires | 15-30s | <20s | Mode parallèle |
| Tests complets | 2-5 min | <3 min | Coverage ciblée |
| Déploiement | 1-2 min | <90s | Validation préalable |
| Diagnostic système | 30-60s | <45s | Cache activé |
| Cache build | 1-3 min | <2 min | Mode différentiel |

### Optimisations

1. **Parallélisation** : Active par défaut pour les tests
2. **Cache intelligent** : Évite les opérations redondantes
3. **Compression** : Réduit l'espace de stockage des logs
4. **Indexation** : Accès rapide aux résultats précédents

## 🔄 Mises à Jour

### Mise à jour des Scripts

```powershell
# Vérifier la version actuelle
.\roo-tests.ps1 -Version

# Mettre à jour (si disponible)
git pull origin main
npm install
```

### Migration depuis Anciens Scripts

Les scripts consolidés remplacent les anciens scripts disparates :

| Ancien Script | Nouveau Script Équivalent | Commande de Migration |
|--------------|-------------------------|---------------------|
| `run-tests.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1 test all` |
| `deploy.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 deploy` |
| `diagnose.ps1` | `roo-diagnose.ps1` | `.\roo-diagnose.ps1 diagnose all` |
| `cache-manager.ps1` | `roo-cache.ps1` | `.\roo-cache.ps1 build` |

---

**Guide d'Utilisation des Scripts Consolidés RooSync v2.1**  
*Version : 1.0*  
*Date : 2025-11-06*  
*Statut : ✅ Opérationnel*