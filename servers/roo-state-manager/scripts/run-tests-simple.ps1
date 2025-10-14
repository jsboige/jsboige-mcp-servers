# Script Simple d'Exécution des Tests
param(
    [string]$OutputFile = "test-results.txt"
)

$ErrorActionPreference = "Continue"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "EXÉCUTION DES TESTS" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Se placer dans le répertoire du package
$packageRoot = Split-Path -Parent $PSScriptRoot
Set-Location $packageRoot

Write-Host "📁 Répertoire : $packageRoot" -ForegroundColor Yellow
Write-Host "📝 Fichier de sortie : $OutputFile" -ForegroundColor Yellow
Write-Host ""

# Timestamp de début
$startTime = Get-Date
Write-Host "⏱️  Début : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Green
Write-Host ""

# Exécuter les tests
Write-Host "🧪 Exécution de la suite de tests..." -ForegroundColor Cyan
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

# Analyse rapide
$content = Get-Content $OutputFile -Raw

if ($content -match "(\d+) passing") {
    Write-Host "✅ Tests passants : $($matches[1])" -ForegroundColor Green
}

if ($content -match "(\d+) failing") {
    Write-Host "❌ Tests échouants : $($matches[1])" -ForegroundColor Red
}

if ($exitCode -eq 0) {
    Write-Host "✅ SUCCÈS" -ForegroundColor Green
}
else {
    Write-Host "⚠️  ÉCHECS DÉTECTÉS" -ForegroundColor Yellow
}

Write-Host ""