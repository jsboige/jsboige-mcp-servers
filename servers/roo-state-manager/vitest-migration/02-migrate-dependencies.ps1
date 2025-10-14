#!/usr/bin/env pwsh
# Script de migration des dépendances Jest → Vitest
# Date: 2025-10-14
# Désinstalle Jest et installe Vitest

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  MIGRATION DÉPENDANCES - Jest → Vitest                       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Vérification que npm est disponible
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "❌ npm n'est pas disponible. Vérifiez votre installation Node.js" -ForegroundColor Red
    exit 1
}

# Sauvegarde du package.json avant modifications
Write-Host "📦 1. SAUVEGARDE DU PACKAGE.JSON" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupFile = "vitest-migration/backups/package.json.$timestamp.bak"
New-Item -ItemType Directory -Force -Path (Split-Path $backupFile) | Out-Null
Copy-Item "package.json" $backupFile
Write-Host "  ✅ Sauvegardé dans: $backupFile" -ForegroundColor Green
Write-Host ""

# Désinstallation de Jest et dépendances
Write-Host "🗑️  2. DÉSINSTALLATION DE JEST" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

$jestPackages = @(
    "jest",
    "@types/jest",
    "ts-jest",
    "jest-environment-node"
)

Write-Host "  📋 Packages à désinstaller:" -ForegroundColor Cyan
$jestPackages | ForEach-Object { Write-Host "     - $_" -ForegroundColor Gray }
Write-Host ""

Write-Host "  🔄 Désinstallation en cours..." -ForegroundColor Cyan
try {
    $output = npm uninstall $jestPackages 2>&1
    Write-Host "  ✅ Jest désinstallé avec succès" -ForegroundColor Green
} catch {
    Write-Host "  ⚠️  Erreur lors de la désinstallation de Jest:" -ForegroundColor Yellow
    Write-Host "     $($_.Exception.Message)" -ForegroundColor Gray
    Write-Host "  ℹ️  Tentative de continuation..." -ForegroundColor Cyan
}
Write-Host ""

# Installation de Vitest
Write-Host "📦 3. INSTALLATION DE VITEST" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

$vitestPackages = @(
    "vitest",
    "@vitest/ui",
    "@vitest/coverage-v8"
)

Write-Host "  📋 Packages à installer:" -ForegroundColor Cyan
$vitestPackages | ForEach-Object { Write-Host "     - $_" -ForegroundColor Gray }
Write-Host ""

Write-Host "  🔄 Installation en cours..." -ForegroundColor Cyan
try {
    $output = npm install --save-dev $vitestPackages 2>&1
    Write-Host "  ✅ Vitest installé avec succès" -ForegroundColor Green
} catch {
    Write-Host "  ❌ Erreur lors de l'installation de Vitest:" -ForegroundColor Red
    Write-Host "     $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}
Write-Host ""

# Vérification des versions installées
Write-Host "✅ 4. VÉRIFICATION DES VERSIONS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json

Write-Host "  📋 Versions installées:" -ForegroundColor Green
if ($packageJson.devDependencies.vitest) {
    Write-Host "     - vitest: $($packageJson.devDependencies.vitest)" -ForegroundColor Gray
}
if ($packageJson.devDependencies.'@vitest/ui') {
    Write-Host "     - @vitest/ui: $($packageJson.devDependencies.'@vitest/ui')" -ForegroundColor Gray
}
if ($packageJson.devDependencies.'@vitest/coverage-v8') {
    Write-Host "     - @vitest/coverage-v8: $($packageJson.devDependencies.'@vitest/coverage-v8')" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  📋 Dépendances Jest restantes (devrait être vide):" -ForegroundColor Yellow
$jestRemaining = @()
if ($packageJson.devDependencies) {
    $packageJson.devDependencies.PSObject.Properties | Where-Object { 
        $_.Name -like "*jest*" 
    } | ForEach-Object {
        $jestRemaining += "     - $($_.Name): $($_.Value)"
    }
}

if ($jestRemaining.Count -eq 0) {
    Write-Host "     ✅ Aucune dépendance Jest restante" -ForegroundColor Green
} else {
    Write-Host "     ⚠️  Dépendances Jest encore présentes:" -ForegroundColor Yellow
    $jestRemaining | ForEach-Object { Write-Host $_ -ForegroundColor Gray }
}
Write-Host ""

# Résumé
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  RÉSUMÉ DE LA MIGRATION DES DÉPENDANCES                      ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "Sauvegarde        : ✅ $backupFile" -ForegroundColor Green
Write-Host "Jest désinstallé  : ✅ $($jestPackages.Count) packages" -ForegroundColor Green
Write-Host "Vitest installé   : ✅ $($vitestPackages.Count) packages" -ForegroundColor Green
Write-Host ""

# Sauvegarde du résultat
$outputFile = "vitest-migration/migration-dependencies-$timestamp.txt"
$output = @"
=== MIGRATION DÉPENDANCES - Jest → Vitest ===
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Sauvegarde: $backupFile

Packages désinstallés:
$($jestPackages | ForEach-Object { "  - $_" } | Out-String)

Packages installés:
$($vitestPackages | ForEach-Object { "  - $_" } | Out-String)

Dépendances Jest restantes: $($jestRemaining.Count)

Versions Vitest:
  - vitest: $($packageJson.devDependencies.vitest)
  - @vitest/ui: $($packageJson.devDependencies.'@vitest/ui')
  - @vitest/coverage-v8: $($packageJson.devDependencies.'@vitest/coverage-v8')
"@

Set-Content -Path $outputFile -Value $output -Encoding UTF8
Write-Host "📄 Résultat sauvegardé dans: $outputFile" -ForegroundColor Cyan
Write-Host ""

Write-Host "✅ Migration des dépendances terminée avec succès!" -ForegroundColor Green
Write-Host "📝 Prochaine étape: Créer la configuration Vitest" -ForegroundColor Cyan
Write-Host ""