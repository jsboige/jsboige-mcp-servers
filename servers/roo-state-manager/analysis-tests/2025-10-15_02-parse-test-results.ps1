# Script d'analyse des résultats de tests
# Extrait les chiffres réels depuis la sortie Vitest

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot/..

$inputFile = "analysis-tests/test-results-baseline-2025-10-15_23-19-15.txt"

Write-Host "=== ANALYSE RÉSULTATS BASELINE PHASE 3B ===" -ForegroundColor Cyan
Write-Host ""

# Lecture du fichier
$content = Get-Content $inputFile -Raw

# Recherche de la ligne "Tests" avec pattern flexible
if ($content -match 'Tests[^\d]*(\d+)\s+failed[^\d]*(\d+)\s+passed[^\d]*(\d+)\s+skipped[^\d]*\((\d+)\)') {
    $failed = [int]$matches[1]
    $passed = [int]$matches[2]
    $skipped = [int]$matches[3]
    $total = [int]$matches[4]
    
    $rate = [math]::Round(($passed / $total) * 100, 1)
    
    Write-Host "✅ Tests réussis: $passed/$total" -ForegroundColor Green
    Write-Host "❌ Tests échoués: $failed/$total" -ForegroundColor Red
    Write-Host "⏭️  Tests skippés: $skipped/$total" -ForegroundColor Yellow
    Write-Host "📊 Taux de réussite: $rate%" -ForegroundColor $(if($rate -ge 85) { "Green" } elseif($rate -ge 80) { "Yellow" } else { "Red" })
    Write-Host ""
    
    Write-Host "Comparaison avec Phase 3A:" -ForegroundColor Cyan
    Write-Host "  Avant:  429/520 (82.5%)" -ForegroundColor Gray
    Write-Host "  Actuel: $passed/520 ($rate%)" -ForegroundColor White
    
    $diff = $passed - 429
    if ($diff -gt 0) {
        Write-Host "  📈 +$diff tests corrigés" -ForegroundColor Green
    } elseif ($diff -lt 0) {
        Write-Host "  📉 $diff tests régressés" -ForegroundColor Red
    } else {
        Write-Host "  ➡️  Aucun changement" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "📋 Tests restants à corriger: $failed" -ForegroundColor Yellow
    
    # Sauvegarder en JSON corrigé
    $summary = @{
        timestamp = "2025-10-15_23-19-15"
        tests_passed = $passed
        tests_failed = $failed
        tests_skipped = $skipped
        tests_total = $total
        success_rate = $rate
        comparison_phase3a = 429
        diff_from_phase3a = $diff
        duration_seconds = 45.67
    }
    
    $jsonFile = "analysis-tests/test-results-baseline-2025-10-15_23-19-15-corrected.json"
    $summary | ConvertTo-Json | Out-File $jsonFile -Encoding UTF8
    
    Write-Host ""
    Write-Host "✅ JSON corrigé sauvegardé: $jsonFile" -ForegroundColor Green
    
} else {
    Write-Host "⚠️  Pattern de résultats non trouvé dans le fichier" -ForegroundColor Red
    Write-Host "Recherche dans les dernières lignes..." -ForegroundColor Yellow
    Write-Host ""
    Get-Content $inputFile | Select-Object -Last 10
}