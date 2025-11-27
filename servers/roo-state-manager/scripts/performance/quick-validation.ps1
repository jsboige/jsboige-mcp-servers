# Script de validation rapide des performances après optimisations

param(
    [Parameter(Mandatory=$false)][string]$OutputDir = "./test-results/performance"
)

# Configuration UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Fonctions utilitaires
function Write-Info {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
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
$reportFile = Join-Path $OutputDir "quick-validation-$timestamp.md"

Write-Header "VALIDATION RAPIDE DES PERFORMANCES"

# Configuration des variables d'environnement optimisées
$env:NODE_OPTIONS = "--max-old-space-size=4096"
$env:NODE_ENV = "test"
$env:MOCK_EXTERNAL_APIS = "true"
$env:SKIP_NETWORK_CALLS = "true"

Write-Info "Variables d'environnement configurées"
Write-Info "NODE_OPTIONS: $env:NODE_OPTIONS"
Write-Info "NODE_ENV: $env:NODE_ENV"

# Tests rapides à exécuter
$testSuites = @(
    @{
        Name = "Unitaires"
        Command = "npm run test:unit -- --reporter=basic --run"
    },
    @{
        Name = "Services"
        Command = "npm run test:unit -- tests/unit/services --reporter=basic --run"
    },
    @{
        Name = "Outils"
        Command = "npm run test:unit -- tests/unit/tools --reporter=basic --run"
    }
)

# Exécuter les tests et mesurer les performances
$results = @()
$totalStart = Get-Date

foreach ($suite in $testSuites) {
    Write-Host "Exécution des tests $($suite.Name)..." -ForegroundColor Gray
    
    $start = Get-Date
    try {
        $result = Invoke-Expression $suite.Command
        $end = Get-Date
        $duration = $end - $start
        
        $testResult = @{
            TestType = $suite.Name
            Duration = $duration
            Success = $LASTEXITCODE -eq 0
        }
        
        if ($testResult.Success) {
            Write-Info "✓ $($suite.Name) : $($testResult.Duration.TotalSeconds.ToString('F2'))s"
        } else {
            Write-Host "✗ $($suite.Name) : Échec" -ForegroundColor Red
        }
        
        $results += $testResult
    } catch {
        $end = Get-Date
        $duration = $end - $start
        
        Write-Host "✗ $($suite.Name) : Erreur - $($_.Exception.Message)" -ForegroundColor Red
        $results += @{
            TestType = $suite.Name
            Duration = $duration
            Success = $false
        }
    }
}

$totalEnd = Get-Date
$totalDuration = $totalEnd - $totalStart

# Calculer les statistiques
$successfulTests = $results | Where-Object { $_.Success }
$failedTests = $results | Where-Object { -not $_.Success }

# Générer le rapport
$reportContent = @"
# Rapport de Validation Rapide des Performances

**Date** : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
**Durée totale** : $($totalDuration.TotalMinutes.ToString('F2')) minutes

## Résultats des Tests

| Catégorie | Statut | Durée (s) |
|-----------|--------|-----------|
"@

foreach ($test in $successfulTests) {
    $reportContent += "`n| $($test.TestType) | ✓ | $($test.Duration.TotalSeconds.ToString('F2')) |"
}

foreach ($test in $failedTests) {
    $reportContent += "`n| $($test.TestType) | ✗ | - |"
}

$reportContent += @"

## Résumé

- **Tests réussis** : $($successfulTests.Count)/$($testSuites.Count)
- **Durée totale** : $($totalDuration.TotalMinutes.ToString('F2')) minutes
- **Temps moyen** : $(if ($successfulTests.Count -gt 0) { (($totalDuration.TotalSeconds / $successfulTests.Count).ToString('F2')) } else { "N/A" }) secondes

## Optimisations Appliquées

1. **Configuration Vitest** : Pool threads, isolation false, reporter basic
2. **Timeouts optimisés** : Réduits par catégorie
3. **Mémoire augmentée** : 4GB alloués
4. **Variables d'environnement** : NODE_OPTIONS, NODE_ENV optimisés

## Recommandations

- Si tous les tests passent : Les optimisations sont validées
- Si des tests échouent : Vérifier les logs et ajuster les timeouts
- Pour plus de détails : Utiliser le script de validation complète

---

*Généré par quick-validation.ps1*
"@

$reportContent | Out-File -FilePath $reportFile -Encoding UTF8 -Force

Write-Header "RAPPORT DE VALIDATION"
Write-Info "Rapport généré : $reportFile"

Write-Host ""
Write-Host "RÉSULTATS :" -ForegroundColor Cyan
Write-Host "Durée totale : $($totalDuration.TotalMinutes.ToString('F2')) minutes" -ForegroundColor White
Write-Host "Tests réussis : $($successfulTests.Count)/$($testSuites.Count)" -ForegroundColor $(if ($successfulTests.Count -eq $testSuites.Count) { "Green" } else { "Yellow" })

if ($successfulTests.Count -eq $testSuites.Count) {
    Write-Host ""
    Write-Info "🎉 Tous les tests passent avec les optimisations !"
    Write-Info "Les optimisations des performances sont validées."
} else {
    Write-Host ""
    Write-Host "⚠️ Certains tests échouent. Vérifiez le rapport pour les détails." -ForegroundColor Yellow
}

Write-Host ""
Write-Info "Validation rapide terminée !"