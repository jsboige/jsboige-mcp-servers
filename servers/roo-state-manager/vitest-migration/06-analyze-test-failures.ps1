#!/usr/bin/env pwsh
# Script d'analyse des échecs de tests Vitest

Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ANALYSE DES ÉCHECS DE TESTS - Vitest Migration" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$reportFile = "vitest-migration/test-failures-analysis-$(Get-Date -Format 'yyyyMMdd_HHmmss').txt"

# Lire le dernier rapport de validation
$validationReports = Get-ChildItem "vitest-migration/validation-*.txt" | Sort-Object LastWriteTime -Descending
if ($validationReports.Count -eq 0) {
    Write-Host "❌ Aucun rapport de validation trouvé" -ForegroundColor Red
    exit 1
}

$latestReport = $validationReports[0].FullName
Write-Host "📄 Analyse du rapport: $($validationReports[0].Name)" -ForegroundColor Yellow
Write-Host ""

# Extraire les erreurs du rapport
$reportContent = Get-Content $latestReport -Raw

# 1. Analyser les erreurs "Cannot find module"
Write-Host "🔍 1. MODULES MANQUANTS" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

$missingModules = @()
$modulePattern = "Cannot find (?:module|package) '([^']+)'"
$matches = [regex]::Matches($reportContent, $modulePattern)

foreach ($match in $matches) {
    $module = $match.Groups[1].Value
    if ($module -notin $missingModules) {
        $missingModules += $module
    }
}

if ($missingModules.Count -gt 0) {
    Write-Host "  Modules introuvables:" -ForegroundColor Yellow
    foreach ($module in $missingModules) {
        Write-Host "    • $module" -ForegroundColor Red
    }
} else {
    Write-Host "  ✓ Aucun module manquant" -ForegroundColor Green
}
Write-Host ""

# 2. Analyser les imports avec extension .js incorrects
Write-Host "🔍 2. IMPORTS AVEC EXTENSIONS INCORRECTES" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

$incorrectImports = @()
$importPattern = "Cannot find module '([^']+\.js)'"
$matches = [regex]::Matches($reportContent, $importPattern)

foreach ($match in $matches) {
    $importPath = $match.Groups[1].Value
    if ($importPath -notin $incorrectImports) {
        $incorrectImports += $importPath
    }
}

if ($incorrectImports.Count -gt 0) {
    Write-Host "  Imports problématiques (.js au lieu de .ts):" -ForegroundColor Yellow
    foreach ($import in $incorrectImports) {
        Write-Host "    • $import" -ForegroundColor Red
        
        # Vérifier si le fichier .ts existe
        $tsPath = $import -replace '\.js$', '.ts'
        $fullTsPath = Join-Path (Get-Location) "src" $tsPath.Replace('../src/', '').Replace('../../src/', '').Replace('../../../src/', '')
        
        if (Test-Path $fullTsPath) {
            Write-Host "      ✓ Fichier .ts trouvé: $tsPath" -ForegroundColor Green
        } else {
            Write-Host "      ✗ Fichier .ts NOT trouvé: $tsPath" -ForegroundColor Red
        }
    }
} else {
    Write-Host "  ✓ Aucun import avec extension incorrecte" -ForegroundColor Green
}
Write-Host ""

# 3. Compter les tests échoués par catégorie
Write-Host "🔍 3. STATISTIQUES DES ÉCHECS" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

$failedTestsPattern = "Test Files\s+(\d+) failed\s+\|\s+(\d+) passed"
$failedTestsMatch = [regex]::Match($reportContent, $failedTestsPattern)

if ($failedTestsMatch.Success) {
    $failedFiles = [int]$failedTestsMatch.Groups[1].Value
    $passedFiles = [int]$failedTestsMatch.Groups[2].Value
    $totalFiles = $failedFiles + $passedFiles
    $successRate = [math]::Round(($passedFiles / $totalFiles) * 100, 2)
    
    Write-Host "  Fichiers de tests:" -ForegroundColor Yellow
    Write-Host "    • Échoués: $failedFiles" -ForegroundColor Red
    Write-Host "    • Réussis: $passedFiles" -ForegroundColor Green
    Write-Host "    • Total: $totalFiles" -ForegroundColor White
    Write-Host "    • Taux de réussite: $successRate%" -ForegroundColor $(if ($successRate -ge 80) { "Green" } else { "Yellow" })
}

$testsPattern = "Tests\s+(\d+) failed\s+\|\s+(\d+) passed"
$testsMatch = [regex]::Match($reportContent, $testsPattern)

if ($testsMatch.Success) {
    $failedTests = [int]$testsMatch.Groups[1].Value
    $passedTests = [int]$testsMatch.Groups[2].Value
    $totalTests = $failedTests + $passedTests
    $successRate = [math]::Round(($passedTests / $totalTests) * 100, 2)
    
    Write-Host ""
    Write-Host "  Tests individuels:" -ForegroundColor Yellow
    Write-Host "    • Échoués: $failedTests" -ForegroundColor Red
    Write-Host "    • Réussis: $passedTests" -ForegroundColor Green
    Write-Host "    • Total: $totalTests" -ForegroundColor White
    Write-Host "    • Taux de réussite: $successRate%" -ForegroundColor $(if ($successRate -ge 80) { "Green" } else { "Yellow" })
}
Write-Host ""

# 4. Catégoriser les types d'erreurs
Write-Host "🔍 4. CATÉGORIES D'ERREURS" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

$errorCategories = @{
    "Module non trouvé" = @($missingModules + $incorrectImports).Count
    "Assertions échouées" = ([regex]::Matches($reportContent, "AssertionError|toBe|toEqual|toContain")).Count
    "Timeouts" = ([regex]::Matches($reportContent, "timeout|timed out")).Count
    "Erreurs de compilation" = ([regex]::Matches($reportContent, "SyntaxError|Cannot find")).Count
}

foreach ($category in $errorCategories.Keys | Sort-Object { $errorCategories[$_] } -Descending) {
    $count = $errorCategories[$category]
    if ($count -gt 0) {
        Write-Host "  • $category : $count" -ForegroundColor Yellow
    }
}
Write-Host ""

# 5. Générer le rapport complet
Write-Host "📝 5. GÉNÉRATION DU RAPPORT DÉTAILLÉ" -ForegroundColor Cyan
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

$reportContent = @"
ANALYSE DES ÉCHECS DE TESTS VITEST
===================================
Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Rapport de validation analysé: $($validationReports[0].Name)

1. MODULES MANQUANTS
───────────────────────────────────────
$($missingModules | ForEach-Object { "  • $_" } | Out-String)

2. IMPORTS AVEC EXTENSIONS INCORRECTES
───────────────────────────────────────
$($incorrectImports | ForEach-Object { "  • $_" } | Out-String)

3. STATISTIQUES
───────────────────────────────────────
Fichiers de tests:
  • Échoués: $failedFiles
  • Réussis: $passedFiles
  • Taux de réussite: $successRate%

Tests individuels:
  • Échoués: $failedTests
  • Réussis: $passedTests
  • Taux de réussite: $successRate%

4. RECOMMANDATIONS
───────────────────────────────────────
"@

# Ajouter des recommandations basées sur l'analyse
if ($missingModules.Count -gt 0) {
    $reportContent += @"

⚠️  MODULES MANQUANTS:
   Les modules suivants doivent être installés:
   npm install --save-dev $($missingModules -join ' ')

"@
}

if ($incorrectImports.Count -gt 0) {
    $reportContent += @"

⚠️  IMPORTS INCORRECTS:
   Les imports utilisent l'extension .js au lieu de .ts
   Ceci est correct pour ESM TypeScript - les imports doivent
   utiliser .js même si les fichiers sources sont .ts
   
   Vérifiez que les fichiers sources .ts existent bien.

"@
}

if ($successRate -ge 80) {
    $reportContent += @"

✅ MIGRATION MAJORITAIREMENT RÉUSSIE:
   Plus de 80% des tests passent. Les échecs restants sont
   probablement des problèmes de tests eux-mêmes, pas de la
   migration Vitest.

"@
} else {
    $reportContent += @"

⚠️  TAUX DE RÉUSSITE FAIBLE:
   Moins de 80% des tests passent. Une révision approfondie
   est nécessaire avant de considérer la migration comme terminée.

"@
}

$reportContent | Out-File $reportFile -Encoding UTF8
Write-Host "  ✓ Rapport sauvegardé: $reportFile" -ForegroundColor Green
Write-Host ""

# 6. Recommandations finales
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  RECOMMANDATIONS" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

if ($missingModules.Count -eq 0 -and $successRate -ge 80) {
    Write-Host "✅ Migration Vitest techniquement réussie!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Les échecs restants ($failedTests tests) sont probablement:" -ForegroundColor Yellow
    Write-Host "  • Des tests flaky (instables)" -ForegroundColor Gray
    Write-Host "  • Des bugs dans les tests eux-mêmes" -ForegroundColor Gray
    Write-Host "  • Des tests nécessitant des ajustements de configuration" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Prochaines étapes:" -ForegroundColor Cyan
    Write-Host "  1. Documenter la migration dans VITEST_MIGRATION_REPORT.md" -ForegroundColor White
    Write-Host "  2. Commiter les changements" -ForegroundColor White
    Write-Host "  3. Marquer les tests problématiques comme 'skip' si nécessaire" -ForegroundColor White
} else {
    Write-Host "⚠️  Migration partiellement réussie" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Actions requises:" -ForegroundColor Cyan
    
    if ($missingModules.Count -gt 0) {
        Write-Host "  1. Installer les modules manquants" -ForegroundColor White
    }
    
    if ($incorrectImports.Count -gt 0) {
        Write-Host "  2. Vérifier l'existence des fichiers sources .ts" -ForegroundColor White
    }
    
    if ($successRate -lt 80) {
        Write-Host "  3. Réviser les tests qui échouent" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "📄 Consultez le rapport détaillé: $reportFile" -ForegroundColor Cyan
Write-Host ""