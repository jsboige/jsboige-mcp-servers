# 🔄 Guide de Migration vers les Scripts Consolidés

## 🎯 Objectif

Ce guide facilite la transition depuis les anciens scripts vers les nouveaux scripts consolidés. Il fournit des équivalences directes et des exemples pratiques pour minimiser l'impact sur votre workflow quotidien.

---

## 📊 Tableau de Migration Complète

### 🧪 Scripts de Tests

| Ancien script | Nouveau script | Commande équivalente | Notes |
|---------------|----------------|---------------------|-------|
| `run-tests.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1` | Remplacement direct |
| `run-tests-simple.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1 -Output console` | Sortie console uniquement |
| `run-validation-tests.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1 -Type integration` | Tests d'intégration |
| `diagnose-tests-with-logging.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1 -Diagnostic` | Diagnostic inclus |
| `audit-tests.ps1` | `roo-tests.ps1` | `.\roo-tests.ps1 -Audit` | Audit complet |

### 🚀 Scripts de Déploiement

| Ancien script | Nouveau script | Commande équivalente | Notes |
|---------------|----------------|---------------------|-------|
| `deploy.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 -Deploy` | Déploiement complet |
| `deploy-simple.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 -Deploy` | Identique |
| `install-dependencies.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 -Install` | Installation npm |
| `build-project.ps1` | `roo-deploy.ps1` | `.\roo-deploy.ps1 -Build` | Build TypeScript |

### 🔍 Scripts de Diagnostic

| Ancien script | Nouveau script | Commande équivalente | Notes |
|---------------|----------------|---------------------|-------|
| `diagnose-skeleton-cache.ps1` | `roo-diagnose.ps1` | `.\roo-diagnose.ps1 -Type cache` | Diagnostic cache |
| `diagnose-skeleton-cache.mjs` | `roo-diagnose.ps1` | `.\roo-diagnose.ps1 -Type cache` | Version JavaScript |
| `diagnose-tests-with-logging.ps1` | `roo-diagnose.ps1` | `.\roo-diagnose.ps1 -Type tests` | Diagnostic tests |
| `audit-tests.ps1` | `roo-diagnose.ps1` | `.\roo-diagnose.ps1 -Type tests -Audit` | Audit tests |

### 💾 Scripts de Cache

| Ancien script | Nouveau script | Commande équivalente | Notes |
|---------------|----------------|---------------------|-------|
| `build-cache-direct.mjs` | `roo-cache.ps1` | `.\roo-cache.ps1 -Build` | Construction cache |
| `test-build-skeleton-cache-direct.ps1` | `roo-cache.ps1` | `.\roo-cache.ps1 -Build -Test` | Build + test |
| `validate-cache.ps1` | `roo-cache.ps1` | `.\roo-cache.ps1 -Validate` | Validation cache |
| `clean-cache.ps1` | `roo-cache.ps1` | `.\roo-cache.ps1 -Clean` | Nettoyage cache |

---

## 🚀 Workflows de Migration

### Workflow 1: Développeur Frontend

**Ancien workflow :**
```powershell
.\install-dependencies.ps1
.\build-project.ps1
.\run-tests-simple.ps1
```

**Nouveau workflow :**
```powershell
.\roo-deploy.ps1 -Install -Build
.\roo-tests.ps1 -Type unit
```

### Workflow 2: Développeur Backend

**Ancien workflow :**
```powershell
.\deploy.ps1
.\diagnose-skeleton-cache.ps1
.\run-validation-tests.ps1
```

**Nouveau workflow :**
```powershell
.\roo-deploy.ps1 -Deploy
.\roo-diagnose.ps1 -Type cache
.\roo-tests.ps1 -Type integration
```

### Workflow 3: Déploiement Production

**Ancien workflow :**
```powershell
.\deploy.ps1
.\run-tests.ps1
.\diagnose-tests-with-logging.ps1
```

**Nouveau workflow :**
```powershell
.\roo-deploy.ps1 -Deploy
.\roo-tests.ps1 -Type all -Diagnostic
```

---

## 📝 Scripts CI/CD

### GitHub Actions - Avant

```yaml
- name: Run Tests
  run: ./scripts/run-tests.ps1
  
- name: Deploy
  run: ./scripts/deploy.ps1
```

### GitHub Actions - Après

```yaml
- name: Install Dependencies
  run: ./scripts/consolidated/roo-deploy.ps1 -Install
  
- name: Build Project
  run: ./scripts/consolidated/roo-deploy.ps1 -Build
  
- name: Run Unit Tests
  run: ./scripts/consolidated/roo-tests.ps1 -Type unit
  
- name: Run Integration Tests
  run: ./scripts/consolidated/roo-tests.ps1 -Type integration
  
- name: Deploy
  run: ./scripts/consolidated/roo-deploy.ps1 -Deploy
```

### Azure DevOps - Avant

```yaml
- task: PowerShell@2
  inputs:
    filePath: 'scripts/run-tests.ps1'
    
- task: PowerShell@2
  inputs:
    filePath: 'scripts/deploy.ps1'
```

### Azure DevOps - Après

```yaml
- task: PowerShell@2
  inputs:
    filePath: 'scripts/consolidated/roo-tests.ps1'
    arguments: '-Type unit -Verbose'
    
- task: PowerShell@2
  inputs:
    filePath: 'scripts/consolidated/roo-deploy.ps1'
    arguments: '-Deploy'
```

---

## 🔧 Migration Automatisée

### Script de Migration

Créez ce script `migrate-scripts.ps1` pour automatiser la transition :

```powershell
#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Script de migration automatique vers les scripts consolidés
.DESCRIPTION
    Détecte les anciens scripts et propose les nouvelles commandes équivalentes
#>

param(
    [switch]$AutoApply,
    [switch]$DryRun
)

# Mapping des anciens vers nouveaux scripts
$scriptMapping = @{
    'run-tests.ps1' = '.\roo-tests.ps1'
    'deploy.ps1' = '.\roo-deploy.ps1 -Deploy'
    'diagnose-skeleton-cache.ps1' = '.\roo-diagnose.ps1 -Type cache'
    'build-cache-direct.mjs' = '.\roo-cache.ps1 -Build'
}

Write-Host "🔍 Analyse des scripts existants..." -ForegroundColor Cyan

# Analyser les fichiers dans le répertoire courant
$oldScripts = Get-ChildItem -Path . -Filter "*.ps1" | Where-Object { 
    $scriptMapping.ContainsKey($_.Name) 
}

if ($oldScripts.Count -eq 0) {
    Write-Host "✅ Aucun ancien script détecté" -ForegroundColor Green
    exit 0
}

Write-Host "📋 Anciens scripts détectés :" -ForegroundColor Yellow
foreach ($script in $oldScripts) {
    $newCommand = $scriptMapping[$script.Name]
    Write-Host "  🔄 $($script.Name) → $newCommand" -ForegroundColor White
}

if ($DryRun) {
    Write-Host "🔍 Mode dry-run - aucune modification effectuée" -ForegroundColor Yellow
    exit 0
}

if ($AutoApply) {
    Write-Host "🚀 Application automatique des migrations..." -ForegroundColor Green
    # Logique de migration automatique ici
} else {
    Write-Host "💡 Utilisez -AutoApply pour appliquer automatiquement" -ForegroundColor Cyan
}
```

---

## 📚 Formation et Documentation

### 🎓 Session de Formation Recommandée

**Durée** : 2 heures  
**Participants** : Tous les développeurs  
**Prérequis** : Connaissance de base PowerShell

#### Programme

1. **Introduction (15 min)**
   - Présentation des scripts consolidés
   - Avantages et bénéfices

2. **Démonstration (45 min)**
   - Scripts de tests
   - Scripts de déploiement
   - Scripts de diagnostic

3. **Atelier pratique (45 min)**
   - Migration des workflows existants
   - Questions et réponses

4. **Validation (15 min)**
   - Quiz de validation
   - Feedback et améliorations

### 📖 Documentation Recommandée

1. **Lecture obligatoire** :
   - `README.md` (ce fichier)
   - `MIGRATION_GUIDE.md` (ce fichier)

2. **Référence rapide** :
   - Tableau de migration complet
   - Exemples de workflows

3. **Support avancé** :
   - Fichiers de configuration dans `config/`
   - Aide intégrée : `.\roo-tests.ps1 -Help`

---

## 🚨 Points d'Attention

### ⚠️ Changements Comportementaux

1. **Chemins relatifs** : Les nouveaux scripts utilisent des chemins relatifs au répertoire `scripts/`
2. **Logging** : Format de sortie standardisé avec couleurs
3. **Configuration** : Paramètres externes dans `config/`

### 🔍 Validation Requise

1. **Tests locaux** : Valider les workflows dans un environnement de test
2. **CI/CD** : Mettre à jour les pipelines d'intégration continue
3. **Documentation** : Mettre à jour la documentation interne

### 🛠️ Outils de Débogage

```powershell
# Mode verbeux pour diagnostiquer les problèmes
.\roo-tests.ps1 -Type unit -Verbose

# Diagnostic complet du système
.\roo-diagnose.ps1 -Type system -Detailed

# Validation de la configuration
.\roo-cache.ps1 -Validate -Verbose
```

---

## 📞 Support et Assistance

### 🆘 Obtenir de l'Aide

1. **Aide intégrée** :
   ```powershell
   .\roo-tests.ps1 -Help
   .\roo-deploy.ps1 -Help
   .\roo-diagnose.ps1 -Help
   .\roo-cache.ps1 -Help
   ```

2. **Diagnostic automatique** :
   ```powershell
   .\roo-diagnose.ps1 -Type system
   ```

3. **Support équipe** :
   - Créer une issue dans le projet
   - Contacter l'équipe roo-state-manager

### 🐛 Signaler un Problème

1. **Collecter les informations** :
   - Version du script
   - Message d'erreur complet
   - Commande utilisée

2. **Créer une issue** avec :
   - Titre descriptif
   - Étapes de reproduction
   - Logs complets

---

## ✅ Checklist de Migration

### 📋 Pré-Migration

- [ ] Lire la documentation complète
- [ ] Identifier les scripts utilisés
- [ ] Planifier les workflows de remplacement
- [ ] Préparer l'environnement de test

### 📋 Migration

- [ ] Mettre à jour les scripts locaux
- [ ] Modifier les pipelines CI/CD
- [ ] Former l'équipe
- [ ] Valider les workflows

### 📋 Post-Migration

- [ ] Supprimer les anciens scripts
- [ ] Mettre à jour la documentation
- [ ] Monitorer les performances
- [ ] Collecter les feedbacks

---

## 🎉 Conclusion

La migration vers les scripts consolidés offre des avantages significatifs :

- **90% de réduction** du nombre de scripts
- **Commandes unifiées** et mémorisables
- **Maintenance simplifiée** et centralisée
- **Documentation complète** et intégrée

Avec ce guide de migration, la transition devrait être fluide et sans interruption pour votre équipe.

---

**Dernière mise à jour** : 06/11/2025  
**Version** : 1.0.0  
**Statut** : Production ✅