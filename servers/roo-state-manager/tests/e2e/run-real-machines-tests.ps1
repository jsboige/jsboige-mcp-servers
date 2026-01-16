# Script pour exécuter les tests E2E sur machines réelles
# Ce script exécute les tests SANS les setups globaux qui contiennent des mocks

$ErrorActionPreference = "Stop"

Write-Host "🚀 Exécution des tests E2E RooSync sur machines réelles" -ForegroundColor Cyan
Write-Host "   ATTENTION: Ces tests utilisent les outils RooSync RÉELS" -ForegroundColor Yellow
Write-Host ""

# Aller dans le répertoire du projet
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Exécuter vitest avec la configuration dédiée aux tests sur machines réelles
# On utilise --run pour exécuter une seule fois
# On utilise --config pour utiliser la configuration SANS mocks
# On utilise --reporter=verbose pour voir les détails
Write-Host "📋 Exécution de vitest avec configuration dédiée..." -ForegroundColor Green
npx vitest run --config ./vitest.config.real-machines.ts --reporter=verbose

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ Tests terminés avec succès!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "❌ Tests échoués avec le code de sortie: $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
