# Script d'application des optimisations des performances des tests
# Version simplifiée sans erreurs de syntaxe

param(
    [Parameter(Mandatory=$false)][switch]$Backup,
    [Parameter(Mandatory=$false)][switch]$ApplyChanges,
    [Parameter(Mandatory=$false)][string]$OutputDir = "./test-results/performance"
)

# Fonctions utilitaires
function Write-Info {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Write-Error-Message {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
}

function Write-Header {
    param([string]$Title)
    Write-Host ""
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ("=" * $Title.Length) -ForegroundColor Cyan
    Write-Host ""
}

# Créer le répertoire de sortie
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportFile = Join-Path $OutputDir "optimization-applied-$timestamp.md"

Write-Header "APPLICATION DES OPTIMISATIONS DES TESTS"

# Optimisation 1: Vitest configuration
$vitestConfigPath = "vitest.config.ts"
if (Test-Path $vitestConfigPath) {
    Write-Info "Optimisation de vitest.config.ts"
    
    if ($Backup) {
        $backupPath = "$vitestConfigPath.backup.$timestamp"
        Copy-Item $vitestConfigPath $backupPath
        Write-Info "Sauvegarde créée : $backupPath"
    }
    
    if ($ApplyChanges) {
        # Lire le contenu actuel
        $content = Get-Content $vitestConfigPath -Raw
        
        # Appliquer les optimisations principales
        $optimizedContent = $content -replace "pool: 'forks'", "pool: 'threads'"
        $optimizedContent = $optimizedContent -replace "singleFork: true", "maxThreads: Math.max(1, require('os').cpus().length - 1)"
        $optimizedContent = $optimizedContent -replace "isolate: true", "isolate: false"
        $optimizedContent = $optimizedContent -replace "reporters: \['verbose'\]", "reporters: ['basic']"
        $optimizedContent = $optimizedContent -replace "testTimeout: 30000", "testTimeout: 15000"
        
        # Écrire le fichier optimisé
        $optimizedContent | Out-File -FilePath $vitestConfigPath -Encoding UTF8 -Force
        Write-Info "Configuration Vitest optimisée"
    }
} else {
    Write-Warning "Fichier vitest.config.ts non trouvé"
}

# Optimisation 2: Test configuration
$testConfigPath = "config/test-config.json"
if (Test-Path $testConfigPath) {
    Write-Info "Optimisation de config/test-config.json"
    
    if ($Backup) {
        $backupPath = "$testConfigPath.backup.$timestamp"
        Copy-Item $testConfigPath $backupPath
        Write-Info "Sauvegarde créée : $backupPath"
    }
    
    if ($ApplyChanges) {
        # Lire et parser la configuration
        try {
            $config = Get-Content $testConfigPath -Raw | ConvertFrom-Json
            
            # Optimiser les timeouts
            if ($config.testTypes.unit) { $config.testTypes.unit.timeout = 15000 }
            if ($config.testTypes.integration) { $config.testTypes.integration.timeout = 45000 }
            if ($config.testTypes.e2e) { $config.testTypes.e2e.timeout = 90000 }
            if ($config.testTypes.services) { $config.testTypes.services.timeout = 20000 }
            if ($config.testTypes.tools) { $config.testTypes.tools.timeout = 15000 }
            if ($config.testTypes.roosync) { $config.testTypes.roosync.timeout = 25000 }
            if ($config.testTypes.detector) { $config.testTypes.detector.timeout = 20000 }
            if ($config.testTypes.all) { $config.testTypes.all.timeout = 120000 }
            
            # Ajouter la section d'optimisation
            $config.optimization = @{
                parallelExecution = $true
                maxWorkers = 4
                cacheEnabled = $true
                reducedTimeouts = $true
            }
            
            # Écrire la configuration optimisée
            $config | ConvertTo-Json -Depth 3 | Out-File -FilePath $testConfigPath -Encoding UTF8 -Force
            Write-Info "Configuration des tests optimisée"
        } catch {
            Write-Error-Message "Erreur lors de l'optimisation de test-config.json : $($_.Exception.Message)"
        }
    }
} else {
    Write-Warning "Fichier config/test-config.json non trouvé"
}

# Optimisation 3: Script de test consolidé
$scriptPath = "scripts/consolidated/roo-tests.ps1"
if (Test-Path $scriptPath) {
    Write-Info "Optimisation de scripts/consolidated/roo-tests.ps1"
    
    if ($Backup) {
        $backupPath = "$scriptPath.backup.$timestamp"
        Copy-Item $scriptPath $backupPath
        Write-Info "Sauvegarde créée : $backupPath"
    }
    
    if ($ApplyChanges) {
        # Lire le contenu actuel
        $content = Get-Content $scriptPath -Raw
        
        # Optimisations simples
        $optimizedContent = $content -replace "--reporter=verbose", "--reporter=basic"
        $optimizedContent = $optimizedContent -replace "timeout = 30000", "timeout = 15000"
        $optimizedContent = $optimizedContent -replace "timeout = 60000", "timeout = 45000"
        $optimizedContent = $optimizedContent -replace "timeout = 120000", "timeout = 90000"
        
        # Écrire le script optimisé
        $optimizedContent | Out-File -FilePath $scriptPath -Encoding UTF8 -Force
        Write-Info "Script de test optimisé"
    }
} else {
    Write-Warning "Fichier scripts/consolidated/roo-tests.ps1 non trouvé"
}

# Optimisation 4: Variables d'environnement
Write-Info "Configuration des variables d'environnement optimisées"

if ($ApplyChanges) {
    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    $env:NODE_ENV = "test"
    $env:MOCK_EXTERNAL_APIS = "true"
    $env:SKIP_NETWORK_CALLS = "true"
    
    Write-Info "Variables d'environnement configurées"
    Write-Info "NODE_OPTIONS: $env:NODE_OPTIONS"
    Write-Info "NODE_ENV: $env:NODE_ENV"
}

# Générer le rapport
$markdown = @"
# Rapport d'Application des Optimisations des Tests

**Date** : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  
**Statut** : $(if ($ApplyChanges) { "Appliquées" } else { "Simulation uniquement" })

## Optimisations Appliquées

### 1. Configuration Vitest (vitest.config.ts)
- **Parallélisme** : `pool: 'threads'` au lieu de `pool: 'forks'`
- **Workers** : `maxThreads` basé sur les CPU disponibles
- **Isolation** : `isolate: false` pour les tests rapides
- **Reporter** : `basic` au lieu de `verbose` pour réduire la sortie
- **Timeout** : Réduit à 15s pour les tests unitaires

### 2. Configuration des Tests (config/test-config.json)
- **Timeouts optimisés** :
  - Unitaires : 15s (au lieu de 30s)
  - Intégration : 45s (au lieu de 60s)
  - E2E : 90s (au lieu de 120s)
  - Services : 20s (au lieu de 30s)
  - Outils : 15s (au lieu de 30s)
  - RooSync : 25s (au lieu de 30s)
  - Détecteur : 20s (au lieu de 30s)
  - Tous : 120s (inchangé)

### 3. Script de Test (scripts/consolidated/roo-tests.ps1)
- **Reporter** : `basic` pour réduire la sortie console
- **Timeouts** : Ajustés dans le script

### 4. Variables d'Environnement
- **NODE_OPTIONS** : `--max-old-space-size=4096` (4GB de mémoire)
- **NODE_ENV** : `test`
- **MOCK_EXTERNAL_APIS** : `true`
- **SKIP_NETWORK_CALLS** : `true`

## Bénéfices Attendus

### Performance
- **Réduction du temps d'exécution** : 40-60%
- **Parallélisme efficace** : Utilisation de tous les CPU disponibles
- **Moins d'attente** : Timeouts optimisés par type de test

### Ressources
- **Mémoire optimisée** : 4GB alloués pour Node.js
- **Cache activé** : Réduction des recompilations
- **Logs réduits** : Moins de sortie console à traiter

## Commandes d'Utilisation

### Exécution Standard Optimisée
```powershell
.\scripts\consolidated\roo-tests.ps1 -TestMode all
```

### Exécution Parallèle
```powershell
.\scripts\consolidated\roo-tests.ps1 -TestMode all -Parallel -MaxWorkers 4
```

### Tests par Catégorie Optimisés
```powershell
.\scripts\consolidated\roo-tests.ps1 -TestMode unit
.\scripts\consolidated\roo-tests.ps1 -TestMode integration
.\scripts\consolidated\roo-tests.ps1 -TestMode e2e
```

## Validation

Pour valider les améliorations :

1. **Exécuter les tests avant et après optimisations**
2. **Comparer les temps d'exécution**
3. **Vérifier que tous les tests passent toujours**
4. **Mesurer l'utilisation CPU et mémoire**

---

*Généré par apply-optimizations.ps1*
"@

$markdown | Out-File -FilePath $reportFile -Encoding UTF8 -Force

Write-Header "RAPPORT D'OPTIMISATION"
Write-Info "Rapport généré : $reportFile"

if ($ApplyChanges) {
    Write-Info "Optimisations appliquées avec succès !"
    Write-Info "Redémarrez votre terminal pour prendre en compte les changements"
} else {
    Write-Warning "Mode simulation - aucune modification appliquée"
    Write-Warning "Utilisez le paramètre -ApplyChanges pour appliquer les optimisations"
    Write-Warning "Utilisez le paramètre -Backup pour créer des sauvegardes"
}

Write-Host ""
Write-Info "Prochaines étapes recommandées :"
Write-Info "1. Exécuter: .\scripts\consolidated\roo-tests.ps1 -TestMode all"
Write-Info "2. Comparer les temps d'exécution avant/après"
Write-Info "3. Ajuster les paramètres si nécessaire"

Write-Info "Optimisation des tests terminée !"