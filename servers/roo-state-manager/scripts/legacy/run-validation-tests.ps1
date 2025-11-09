# Script de Validation Finale des Tests
# Objectif : Exécuter la suite complète de tests et capturer les résultats

param(
    [string]$OutputFile = "test-results-post-consolidation.txt"
)

$ErrorActionPreference = "Continue"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "VALIDATION FINALE DES TESTS POST-CONSOLIDATION" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Se placer dans le répertoire du package
$packageRoot = Split-Path -Parent $PSScriptRoot
Push-Location $packageRoot

Write-Host "📁 Répertoire : $packageRoot" -ForegroundColor Yellow
Write-Host "📝 Fichier de sortie : $OutputFile" -ForegroundColor Yellow
Write-Host ""

# Timestamp de début
$startTime = Get-Date
Write-Host "⏱️  Début : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Green
Write-Host ""

# Exécuter les tests avec capture complète
Write-Host "🧪 Exécution de la suite de tests..." -ForegroundColor Cyan
Write-Host ""

try {
    # Exécuter npm test et capturer tout
    npm test 2>&1 | Tee-Object -FilePath $OutputFile
    
    $exitCode = $LASTEXITCODE
    
    # Timestamp de fin
    $endTime = Get-Date
    $duration = $endTime - $startTime
    
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "⏱️  Fin : $($endTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Green
    Write-Host "⏱️  Durée : $($duration.TotalSeconds) secondes" -ForegroundColor Green
    Write-Host "📄 Résultats sauvegardés dans : $OutputFile" -ForegroundColor Yellow
    Write-Host ""
    
    # Analyse rapide des résultats
    Write-Host "📊 ANALYSE RAPIDE DES RÉSULTATS" -ForegroundColor Cyan
    Write-Host "================================" -ForegroundColor Cyan
    
    $content = Get-Content $OutputFile -Raw
    
    # Compter les tests
    if ($content -match "(\d+) passing") {
        $passing = $matches[1]
        Write-Host "✅ Tests passants : $passing" -ForegroundColor Green
    }
    
    if ($content -match "(\d+) failing") {
        $failing = $matches[1]
        Write-Host "❌ Tests échouants : $failing" -ForegroundColor Red
    }
    else {
        Write-Host "✅ Aucun échec détecté" -ForegroundColor Green
    }
    
    # Compter les suites
    $suiteCount = ([regex]::Matches($content, "^\s{2}\S", "Multiline")).Count
    if ($suiteCount -gt 0) {
        Write-Host "📦 Suites de tests : $suiteCount" -ForegroundColor Cyan
    }
    
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    
    if ($exitCode -eq 0) {
        Write-Host "✅ VALIDATION RÉUSSIE - Tous les tests sont opérationnels" -ForegroundColor Green
    }
    else {
        Write-Host "⚠️  Des échecs ont été détectés - Analyse requise" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "❌ ERREUR lors de l'exécution des tests : $_" -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Consulte $OutputFile pour les détails complets" -ForegroundColor Cyan