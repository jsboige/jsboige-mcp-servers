# Script simple d'analyse des performances des tests
# Analyse rapide des temps d'exécution par catégorie

param(
    [Parameter(Mandatory=$false)][string]$OutputDir = "./test-results/performance"
)

# Créer le répertoire de sortie
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportFile = Join-Path $OutputDir "simple-performance-$timestamp.md"

Write-Host "ANALYSE SIMPLE DES PERFORMANCES DES TESTS" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Fonction pour exécuter et mesurer un test
function Test-Performance {
    param(
        [string]$Name,
        [string]$Command,
        [string]$Description
    )
    
    Write-Host "Test : $Description" -ForegroundColor Yellow
    Write-Host "Commande : $Command" -ForegroundColor Gray
    
    $startTime = Get-Date
    
    try {
        $output = Invoke-Expression $command 2>&1
        $exitCode = $LASTEXITCODE
        $success = $exitCode -eq 0
        
        $endTime = Get-Date
        $duration = $endTime - $startTime
        
        # Extraire les statistiques
        $testFiles = 0
        $passingTests = 0
        $failingTests = 0
        
        if ($output -match "Test Files\s+(\d+)") {
            $testFiles = [int]$matches[1]
        }
        if ($output -match "(\d+)\s+passing") {
            $passingTests = [int]$matches[1]
        }
        if ($output -match "(\d+)\s+failing") {
            $failingTests = [int]$matches[1]
        }
        
        $result = @{
            Name = $Name
            Description = $Description
            DurationSeconds = [math]::Round($duration.TotalSeconds, 2)
            TestFiles = $testFiles
            PassingTests = $passingTests
            FailingTests = $failingTests
            Success = $success
            ExitCode = $exitCode
        }
        
        $status = if ($success) { "✓ SUCCÈS" } else { "✗ ÉCHEC" }
        $statusColor = if ($success) { "Green" } else { "Red" }
        
        Write-Host "  Durée : $($result.DurationSeconds)s" -ForegroundColor $statusColor
        Write-Host "  Fichiers : $testFiles | Réussis : $passingTests | Échoués : $failingTests" -ForegroundColor $statusColor
        Write-Host "  Statut : $status" -ForegroundColor $statusColor
        Write-Host ""
        
        return $result
    } catch {
        $endTime = Get-Date
        $duration = $endTime - $startTime
        
        Write-Host "  ERREUR : $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  Durée : $([math]::Round($duration.TotalSeconds, 2))s" -ForegroundColor Red
        Write-Host ""
        
        return @{
            Name = $Name
            Description = $Description
            DurationSeconds = [math]::Round($duration.TotalSeconds, 2)
            TestFiles = 0
            PassingTests = 0
            FailingTests = 0
            Success = $false
            ExitCode = -1
            Error = $_.Exception.Message
        }
    }
}

# Tests à analyser
$tests = @(
    @{ Name = "unit"; Command = "npx vitest run tests/unit --reporter=basic"; Description = "Tests unitaires" },
    @{ Name = "services"; Command = "npx vitest run tests/unit/services --reporter=basic"; Description = "Tests des services" },
    @{ Name = "tools"; Command = "npx vitest run tests/unit/tools --reporter=basic"; Description = "Tests des outils" },
    @{ Name = "roosync"; Command = "npx vitest run tests/unit/tools/roosync --reporter=basic"; Description = "Tests RooSync" },
    @{ Name = "integration"; Command = "npx vitest run tests/integration --reporter=basic"; Description = "Tests d'intégration" }
)

$results = @()
$totalStartTime = Get-Date

foreach ($test in $tests) {
    $result = Test-Performance -Name $test.Name -Command $test.Command -Description $test.Description
    $results += $result
}

$totalEndTime = Get-Date
$totalDuration = $totalEndTime - $totalStartTime

# Analyse des résultats
$successfulTests = $results | Where-Object { $_.Success }
$failedTests = $results | Where-Object { -not $_.Success }
$totalFiles = ($results | Measure-Object -Property TestFiles -Sum).Sum
$totalPassing = ($results | Measure-Object -Property PassingTests -Sum).Sum
$totalFailing = ($results | Measure-Object -Property FailingTests -Sum).Sum

Write-Host "RÉSUMÉ DE L'ANALYSE" -ForegroundColor Cyan
Write-Host "==================" -ForegroundColor Cyan
Write-Host "Durée totale : $([math]::Round($totalDuration.TotalSeconds, 2))s" -ForegroundColor White
Write-Host "Catégories analysées : $($results.Count)" -ForegroundColor White
Write-Host "Catégories réussies : $($successfulTests.Count)" -ForegroundColor Green
Write-Host "Catégories échouées : $($failedTests.Count)" -ForegroundColor Red
Write-Host "Total fichiers : $totalFiles" -ForegroundColor White
Write-Host "Total tests réussis : $totalPassing" -ForegroundColor Green
Write-Host "Total tests échoués : $totalFailing" -ForegroundColor Red
Write-Host ""

# Identifier les goulots d'étranglement
$slowestTests = $results | Sort-Object -Property DurationSeconds -Descending | Select-Object -First 3
$fileHeavyTests = $results | Sort-Object -Property TestFiles -Descending | Select-Object -First 3

Write-Host "GOULOTS D'ÉTRANGLEMENT IDENTIFIÉS" -ForegroundColor Yellow
Write-Host "===============================" -ForegroundColor Yellow
Write-Host "Tests les plus lents :" -ForegroundColor Yellow
foreach ($test in $slowestTests) {
    Write-Host "  $($test.Description) : $($test.DurationSeconds)s" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Tests avec le plus de fichiers :" -ForegroundColor Yellow
foreach ($test in $fileHeavyTests) {
    Write-Host "  $($test.Description) : $($test.TestFiles) fichiers" -ForegroundColor Yellow
}
Write-Host ""

# Générer le rapport
$markdown = @"
# Analyse Simple des Performances des Tests

**Date** : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  
**Durée totale** : $([math]::Round($totalDuration.TotalSeconds, 2)) secondes

## Résumé Exécutif

- **Catégories analysées** : $($results.Count)
- **Catégories réussies** : $($successfulTests.Count)
- **Catégories échouées** : $($failedTests.Count)
- **Total fichiers de test** : $totalFiles
- **Total tests réussis** : $totalPassing
- **Total tests échoués** : $totalFailing

## Résultats par Catégorie

| Catégorie | Description | Durée (s) | Fichiers | Réussis | Échoués | Statut |
|-----------|-------------|------------|---------|----------|---------|--------|
"@

foreach ($result in $results) {
    $status = if ($result.Success) { "✓" } else { "✗" }
    $markdown += "`n| $($result.Name) | $($result.Description) | $($result.DurationSeconds) | $($result.TestFiles) | $($result.PassingTests) | $($result.FailingTests) | $status |"
}

$markdown += @"

## Analyse des Goulots d'Étranglement

### Tests les plus lents
"@

foreach ($test in $slowestTests) {
    $markdown += "`n- **$($test.Description)** : $($test.DurationSeconds)s"
}

$markdown += @"

### Tests avec le plus de fichiers
"@

foreach ($test in $fileHeavyTests) {
    $markdown += "`n- **$($test.Description)** : $($test.TestFiles) fichiers"
}

$markdown += @"

## Recommandations d'Optimisation

### 1. Configuration Vitest
- Activer le parallélisme : `pool: 'threads'` au lieu de `pool: 'forks'`
- Augmenter le nombre de workers : `maxWorkers: 4` (ou basé sur CPU cores)
- Optimiser les timeouts selon les besoins réels

### 2. Structure des tests
- Répartir équitablement les tests entre les catégories
- Isoler les tests lents dans des suites séparées
- Optimiser les fixtures et données de test

### 3. Optimisations spécifiques
- Tests unitaires : Parallélisation possible
- Tests d'intégration : Optimiser les configurations de base de données
- Tests RooSync : Optimiser les opérations de synchronisation

---

*Généré par simple-performance-test.ps1*
"@

$markdown | Out-File -FilePath $reportFile -Encoding UTF8 -Force

Write-Host "RAPPORT GÉNÉRÉ : $reportFile" -ForegroundColor Green
Write-Host "ANALYSE TERMINÉE" -ForegroundColor Green