# run-e2e-tests.ps1
# Script pour exécuter les tests E2E RooSync

param(
    [switch]$Workflow,
    [switch]$ErrorHandling,
    [switch]$All,
    [switch]$Verbose
)

$ErrorActionPreference = "Continue"

Write-Host "=== Tests E2E RooSync ===" -ForegroundColor Cyan
Write-Host ""

# Vérifier que l'environnement est configuré
if (-not $env:SHARED_STATE_PATH) {
    Write-Host "⚠️ ATTENTION: SHARED_STATE_PATH non configuré" -ForegroundColor Yellow
    Write-Host "   Les tests E2E nécessitent un environnement RooSync configuré" -ForegroundColor Yellow
    Write-Host "   Configurez SHARED_STATE_PATH dans .env" -ForegroundColor Yellow
    Write-Host ""
}

# Aller au répertoire du projet
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "📁 Répertoire projet : $projectRoot" -ForegroundColor Green
Write-Host ""

# Construire les tests
Write-Host "🔨 Construction des tests..." -ForegroundColor Green
npm run build:tests

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Erreur lors de la construction des tests" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Déterminer quels tests exécuter
$testPattern = ""

if ($Workflow) {
    $testPattern = "tests/e2e/roosync-workflow.test.ts"
    Write-Host "🧪 Exécution tests workflow uniquement" -ForegroundColor Yellow
} elseif ($ErrorHandling) {
    $testPattern = "tests/e2e/roosync-error-handling.test.ts"
    Write-Host "🧪 Exécution tests error-handling uniquement" -ForegroundColor Yellow
} elseif ($All) {
    $testPattern = "tests/e2e/"
    Write-Host "🧪 Exécution de TOUS les tests E2E" -ForegroundColor Yellow
} else {
    Write-Host "Usage:" -ForegroundColor Cyan
    Write-Host "  .\run-e2e-tests.ps1 -Workflow         # Tests workflow complet"
    Write-Host "  .\run-e2e-tests.ps1 -ErrorHandling    # Tests gestion erreurs"
    Write-Host "  .\run-e2e-tests.ps1 -All              # Tous les tests E2E"
    Write-Host "  .\run-e2e-tests.ps1 -All -Verbose     # Avec sortie détaillée"
    Write-Host ""
    Write-Host "Par défaut, exécute tous les tests E2E" -ForegroundColor Yellow
    $testPattern = "tests/e2e/"
}

Write-Host ""

# Options Jest
$jestOptions = @(
    "--runInBand",
    "--testTimeout=120000"  # 2 minutes par test
)

if ($Verbose) {
    $jestOptions += "--verbose"
}

# Exécuter les tests
Write-Host "🚀 Lancement des tests..." -ForegroundColor Green
Write-Host ""

$env:NODE_OPTIONS = "--experimental-vm-modules --max-old-space-size=8192"
if ($testPattern) {
    & npx vitest run $testPattern @jestOptions
} else {
    & npx vitest run "tests/e2e/" @jestOptions
}

$testExitCode = $LASTEXITCODE

Write-Host ""
Write-Host "=== Fin des tests E2E ===" -ForegroundColor Cyan

if ($testExitCode -eq 0) {
    Write-Host "✅ Tous les tests sont passés !" -ForegroundColor Green
} else {
    Write-Host "❌ Certains tests ont échoué (code $testExitCode)" -ForegroundColor Red
}

Write-Host ""
Write-Host "📊 Pour générer un rapport détaillé :" -ForegroundColor Cyan
Write-Host "   npm run test:coverage -- tests/e2e/" -ForegroundColor Gray

exit $testExitCode