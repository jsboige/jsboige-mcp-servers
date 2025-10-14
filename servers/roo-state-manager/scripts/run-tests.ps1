<#
.SYNOPSIS
    Script PowerShell pour executer les tests roo-state-manager
.DESCRIPTION
    Execute les suites de tests avec gestion des environnements et logs
.PARAMETER TestFiles
    Fichiers de tests specifiques a executer (optionnel)
.EXAMPLE
    .\run-tests.ps1
    .\run-tests.ps1 -TestFiles "tests/integration.test.ts","tests/hierarchy-reconstruction.test.ts"
#>

param(
    [string[]]$TestFiles = @()
)

# Configuration
$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "[TESTS] Execution des tests roo-state-manager" -ForegroundColor Cyan
Write-Host "[INFO] Repertoire: $ProjectRoot" -ForegroundColor Gray
Write-Host ""

if ($TestFiles.Count -gt 0) {
    # Joindre avec des espaces, pas des virgules
    $testPattern = $TestFiles -join " "
    Write-Host "[INFO] Tests specifiques: $testPattern" -ForegroundColor Yellow
    Write-Host ""
    
    # Construire la commande npm test avec les fichiers separes par des espaces
    $testCmd = "npm test -- $testPattern"
    Write-Host "[DEBUG] Commande: $testCmd" -ForegroundColor Gray
    
    Invoke-Expression $testCmd
    $exitCode = $LASTEXITCODE
} else {
    Write-Host "[INFO] Suite complete de tests" -ForegroundColor Yellow
    Write-Host ""
    
    # Executer la suite complete
    npm test
    $exitCode = $LASTEXITCODE
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "[SUCCESS] Tous les tests passent!" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Des tests ont echoue (exit code: $exitCode)" -ForegroundColor Red
}

Write-Host ""
Write-Host "[DONE] Rapport de test termine" -ForegroundColor Cyan

exit $exitCode