#!/usr/bin/env pwsh
# Script de validation de la migration Jest → Vitest
# Date: 2025-10-14
# Compile le projet et lance les tests Vitest

$ErrorActionPreference = "Continue" # Continue pour capturer les erreurs
Set-Location $PSScriptRoot/..

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  VALIDATION DE LA MIGRATION - Vitest                         ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportFile = "vitest-migration/validation-$timestamp.txt"
$report = @()

# Étape 1: Compilation du projet
Write-Host "🔨 1. COMPILATION DU PROJET" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

Write-Host "  🔄 Compilation de src/..." -ForegroundColor Cyan
$buildOutput = npm run build 2>&1
$buildExitCode = $LASTEXITCODE

if ($buildExitCode -eq 0) {
    Write-Host "  ✅ Compilation du projet réussie" -ForegroundColor Green
    $report += "BUILD: SUCCESS"
} else {
    Write-Host "  ❌ Erreur de compilation du projet" -ForegroundColor Red
    Write-Host "     Voir la sortie pour plus de détails" -ForegroundColor Gray
    $report += "BUILD: FAILED"
    $report += "BUILD OUTPUT:"
    $report += $buildOutput | Out-String
}
Write-Host ""

# Étape 2: Compilation des tests
Write-Host "🔨 2. COMPILATION DES TESTS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

Write-Host "  🔄 Compilation de tests/..." -ForegroundColor Cyan
$buildTestsOutput = npm run build:tests 2>&1
$buildTestsExitCode = $LASTEXITCODE

if ($buildTestsExitCode -eq 0) {
    Write-Host "  ✅ Compilation des tests réussie" -ForegroundColor Green
    $report += "BUILD TESTS: SUCCESS"
} else {
    Write-Host "  ❌ Erreur de compilation des tests" -ForegroundColor Red
    Write-Host "     Voir la sortie pour plus de détails" -ForegroundColor Gray
    $report += "BUILD TESTS: FAILED"
    $report += "BUILD TESTS OUTPUT:"
    $report += $buildTestsOutput | Out-String
}
Write-Host ""

# Étape 3: Exécution des tests Vitest (seulement si compilation OK)
$testsRun = $false
$testsExitCode = 1

if ($buildExitCode -eq 0 -and $buildTestsExitCode -eq 0) {
    Write-Host "🧪 3. EXÉCUTION DES TESTS VITEST" -ForegroundColor Yellow
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host ""
    
    Write-Host "  🔄 Lancement de 'npm run test:run'..." -ForegroundColor Cyan
    Write-Host "     (Cela peut prendre quelques minutes)" -ForegroundColor Gray
    Write-Host ""
    
    $testsOutput = npm run test:run 2>&1
    $testsExitCode = $LASTEXITCODE
    $testsRun = $true
    
    Write-Host ""
    if ($testsExitCode -eq 0) {
        Write-Host "  ✅ Tests Vitest passés avec succès" -ForegroundColor Green
        $report += "TESTS: SUCCESS"
    } else {
        Write-Host "  ⚠️  Certains tests ont échoué" -ForegroundColor Yellow
        Write-Host "     Code de sortie: $testsExitCode" -ForegroundColor Gray
        $report += "TESTS: FAILED (exit code: $testsExitCode)"
    }
    
    # Extraction des statistiques de tests
    Write-Host ""
    Write-Host "  📊 Statistiques des tests:" -ForegroundColor Cyan
    $testStats = $testsOutput | Select-String -Pattern "Test Files|Tests|Time" -Context 0,0
    if ($testStats) {
        $testStats | ForEach-Object { 
            Write-Host "     $_" -ForegroundColor Gray 
        }
    }
    
    $report += "TEST OUTPUT:"
    $report += $testsOutput | Out-String
} else {
    Write-Host "⏭️  3. TESTS VITEST IGNORÉS" -ForegroundColor Yellow
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  ⚠️  Tests ignorés car la compilation a échoué" -ForegroundColor Yellow
    $report += "TESTS: SKIPPED (compilation failed)"
}
Write-Host ""

# Résumé final
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  RÉSUMÉ DE LA VALIDATION                                     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$successCount = 0
$failCount = 0

Write-Host "Résultats:" -ForegroundColor Cyan
if ($buildExitCode -eq 0) {
    Write-Host "  ✅ Compilation du projet     : SUCCÈS" -ForegroundColor Green
    $successCount++
} else {
    Write-Host "  ❌ Compilation du projet     : ÉCHEC" -ForegroundColor Red
    $failCount++
}

if ($buildTestsExitCode -eq 0) {
    Write-Host "  ✅ Compilation des tests     : SUCCÈS" -ForegroundColor Green
    $successCount++
} else {
    Write-Host "  ❌ Compilation des tests     : ÉCHEC" -ForegroundColor Red
    $failCount++
}

if ($testsRun) {
    if ($testsExitCode -eq 0) {
        Write-Host "  ✅ Tests Vitest              : SUCCÈS" -ForegroundColor Green
        $successCount++
    } else {
        Write-Host "  ⚠️  Tests Vitest              : ÉCHEC" -ForegroundColor Yellow
        $failCount++
    }
} else {
    Write-Host "  ⏭️  Tests Vitest              : IGNORÉS" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Score: $successCount / 3" -ForegroundColor $(if ($successCount -eq 3) { "Green" } elseif ($successCount -ge 2) { "Yellow" } else { "Red" })
Write-Host ""

# Status final
if ($buildExitCode -eq 0 -and $buildTestsExitCode -eq 0 -and $testsExitCode -eq 0) {
    Write-Host "🎉 MIGRATION VALIDÉE AVEC SUCCÈS!" -ForegroundColor Green
    Write-Host "   Le projet compile et tous les tests passent avec Vitest" -ForegroundColor Green
    $report += "`nFINAL STATUS: SUCCESS"
    $finalExitCode = 0
} elseif ($buildExitCode -eq 0 -and $buildTestsExitCode -eq 0) {
    Write-Host "⚠️  MIGRATION PARTIELLEMENT VALIDÉE" -ForegroundColor Yellow
    Write-Host "   Le projet compile mais certains tests échouent" -ForegroundColor Yellow
    Write-Host "   Examinez les erreurs de tests ci-dessus" -ForegroundColor Yellow
    $report += "`nFINAL STATUS: PARTIAL SUCCESS (tests failed)"
    $finalExitCode = 1
} else {
    Write-Host "❌ VALIDATION ÉCHOUÉE" -ForegroundColor Red
    Write-Host "   Des erreurs de compilation ont été détectées" -ForegroundColor Red
    Write-Host "   Examinez les erreurs ci-dessus" -ForegroundColor Red
    $report += "`nFINAL STATUS: FAILED (compilation errors)"
    $finalExitCode = 2
}

Write-Host ""

# Sauvegarde du rapport
$reportContent = @"
=== VALIDATION DE LA MIGRATION - Jest → Vitest ===
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

$($report -join "`n")
"@

Set-Content -Path $reportFile -Value $reportContent -Encoding UTF8
Write-Host "📄 Rapport de validation sauvegardé: $reportFile" -ForegroundColor Cyan
Write-Host ""

if ($finalExitCode -eq 0) {
    Write-Host "📝 Prochaine étape: Créer la documentation (VITEST_MIGRATION_REPORT.md)" -ForegroundColor Cyan
} elseif ($finalExitCode -eq 1) {
    Write-Host "📝 Prochaine étape: Corriger les tests qui échouent ou documenter les résultats" -ForegroundColor Cyan
} else {
    Write-Host "📝 Prochaine étape: Corriger les erreurs de compilation" -ForegroundColor Cyan
}
Write-Host ""

exit $finalExitCode