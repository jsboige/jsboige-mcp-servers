# Script de test baseline pour Phase 3B
# Date: 2025-10-15
# Objectif: Établir la baseline des tests après pull RooSync

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot/..

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  TEST BASELINE - PHASE 3B" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Timestamp
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$outputFile = "analysis-tests/test-results-baseline-$timestamp.txt"
$jsonFile = "analysis-tests/test-results-baseline-$timestamp.json"

Write-Host "📊 Sortie: $outputFile" -ForegroundColor Yellow
Write-Host "📊 JSON: $jsonFile" -ForegroundColor Yellow
Write-Host ""

# Exécution des tests
Write-Host "🚀 Lancement des tests..." -ForegroundColor Green
$startTime = Get-Date

# Rediriger stdout et stderr
npm test 2>&1 | Tee-Object -FilePath $outputFile

$endTime = Get-Date
$duration = ($endTime - $startTime).TotalSeconds

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "⏱️  Durée: $([math]::Round($duration, 2))s" -ForegroundColor Yellow
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Analyse rapide des résultats
Write-Host "📈 Analyse rapide..." -ForegroundColor Green
$content = Get-Content $outputFile -Raw

# Extraction du résumé
if ($content -match "Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total") {
    $failed = $matches[1]
    $passed = $matches[2]
    $total = $matches[3]
    
    Write-Host ""
    Write-Host "✅ Tests réussis: $passed/$total" -ForegroundColor Green
    Write-Host "❌ Tests échoués: $failed/$total" -ForegroundColor Red
    
    $percentage = [math]::Round(($passed / $total) * 100, 1)
    Write-Host "📊 Taux de réussite: $percentage%" -ForegroundColor $(if($percentage -ge 85) { "Green" } else { "Yellow" })
    
    Write-Host ""
    Write-Host "Progression attendue:" -ForegroundColor Cyan
    Write-Host "  Avant Phase 3A: 407/520 (78.3%)" -ForegroundColor Gray
    Write-Host "  Après Phase 3A: 429/520 (82.5%)" -ForegroundColor Gray
    Write-Host "  Actuel:         $passed/$total ($percentage%)" -ForegroundColor White
} else {
    Write-Host "⚠️  Impossible d'extraire le résumé automatiquement" -ForegroundColor Yellow
    Write-Host "   Consultez le fichier: $outputFile" -ForegroundColor Gray
}

Write-Host ""
Write-Host "📁 Résultats sauvegardés dans:" -ForegroundColor Green
Write-Host "   $outputFile" -ForegroundColor Gray

# Générer un JSON simplifié pour analyse ultérieure
$summary = @{
    timestamp = $timestamp
    duration_seconds = [math]::Round($duration, 2)
    tests_passed = if($passed) { [int]$passed } else { 0 }
    tests_failed = if($failed) { [int]$failed } else { 0 }
    tests_total = if($total) { [int]$total } else { 0 }
    success_rate = if($percentage) { [math]::Round($percentage, 1) } else { 0.0 }
    output_file = $outputFile
}

$summary | ConvertTo-Json | Out-File $jsonFile -Encoding UTF8
Write-Host "   $jsonFile" -ForegroundColor Gray

Write-Host ""
Write-Host "✅ Baseline établie avec succès!" -ForegroundColor Green
Write-Host ""