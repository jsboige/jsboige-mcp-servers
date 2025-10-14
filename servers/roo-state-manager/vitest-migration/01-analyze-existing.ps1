#!/usr/bin/env pwsh
# Script d'analyse de l'existant pour la migration Jest → Vitest
# Date: 2025-10-14
# Migration des tests du serveur MCP roo-state-manager

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  ANALYSE DE L'EXISTANT - Migration Jest → Vitest            ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 1. Fichiers de tests
Write-Host "📁 1. FICHIERS DE TESTS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$testFiles = @(Get-ChildItem -Path . -Include "*.test.ts","*.spec.ts" -Recurse -ErrorAction SilentlyContinue)
if ($testFiles.Count -eq 0) {
    Write-Host "  ❌ Aucun fichier de tests trouvé" -ForegroundColor Red
} else {
    Write-Host "  ✅ $($testFiles.Count) fichier(s) de tests trouvé(s):" -ForegroundColor Green
    $testFiles | ForEach-Object {
        $relativePath = $_.FullName.Replace((Get-Location).Path + "\", "")
        Write-Host "     - $relativePath" -ForegroundColor Gray
    }
}
Write-Host ""

# 2. Répertoire __tests__
Write-Host "📁 2. RÉPERTOIRE __tests__" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
if (Test-Path "src/__tests__") {
    $testsDir = Get-ChildItem "src/__tests__" -Recurse -ErrorAction SilentlyContinue
    Write-Host "  ✅ Répertoire __tests__ trouvé avec $($testsDir.Count) fichier(s)" -ForegroundColor Green
    $testsDir | ForEach-Object {
        $relativePath = $_.FullName.Replace((Get-Location).Path + "\", "")
        Write-Host "     - $relativePath" -ForegroundColor Gray
    }
} else {
    Write-Host "  ❌ Pas de répertoire __tests__" -ForegroundColor Red
}
Write-Host ""

# 3. Configuration Jest
Write-Host "⚙️  3. CONFIGURATION JEST" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$jestConfigFound = $false
if (Test-Path "jest.config.js") {
    Write-Host "  ✅ jest.config.js trouvé" -ForegroundColor Green
    $jestConfigFound = $true
}
if (Test-Path "jest.config.ts") {
    Write-Host "  ✅ jest.config.ts trouvé" -ForegroundColor Green
    $jestConfigFound = $true
}
if (-not $jestConfigFound) {
    Write-Host "  ❌ Pas de configuration Jest trouvée" -ForegroundColor Red
}
Write-Host ""

# 4. Package.json - Dépendances Jest
Write-Host "📦 4. DÉPENDANCES JEST dans package.json" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
if (Test-Path "package.json") {
    $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    
    $jestDeps = @()
    if ($packageJson.devDependencies) {
        $packageJson.devDependencies.PSObject.Properties | Where-Object { 
            $_.Name -like "*jest*" 
        } | ForEach-Object {
            $jestDeps += "  - $($_.Name): $($_.Value)"
        }
    }
    
    if ($jestDeps.Count -eq 0) {
        Write-Host "  ℹ️  Aucune dépendance Jest trouvée" -ForegroundColor Cyan
    } else {
        Write-Host "  📋 Dépendances Jest trouvées:" -ForegroundColor Green
        $jestDeps | ForEach-Object { Write-Host $_ -ForegroundColor Gray }
    }
    
    # Scripts Jest
    Write-Host ""
    Write-Host "  📋 Scripts Jest dans package.json:" -ForegroundColor Green
    $jestScripts = @()
    if ($packageJson.scripts) {
        $packageJson.scripts.PSObject.Properties | Where-Object { 
            $_.Value -like "*jest*" 
        } | ForEach-Object {
            $jestScripts += "  - $($_.Name): $($_.Value)"
        }
    }
    
    if ($jestScripts.Count -eq 0) {
        Write-Host "  ℹ️  Aucun script Jest trouvé" -ForegroundColor Cyan
    } else {
        $jestScripts | ForEach-Object { Write-Host $_ -ForegroundColor Gray }
    }
} else {
    Write-Host "  ❌ package.json non trouvé" -ForegroundColor Red
}
Write-Host ""

# 5. Configuration TypeScript
Write-Host "📝 5. CONFIGURATION TYPESCRIPT" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
if (Test-Path "tsconfig.json") {
    Write-Host "  ✅ tsconfig.json trouvé" -ForegroundColor Green
    $tsconfig = Get-Content "tsconfig.json" -Raw | ConvertFrom-Json
    if ($tsconfig.compilerOptions.types) {
        Write-Host "  📋 Types actuels:" -ForegroundColor Green
        $tsconfig.compilerOptions.types | ForEach-Object {
            Write-Host "     - $_" -ForegroundColor Gray
        }
    }
}
if (Test-Path "tsconfig.test.json") {
    Write-Host "  ✅ tsconfig.test.json trouvé" -ForegroundColor Green
}
Write-Host ""

# 6. Vitest existant ?
Write-Host "🔍 6. VITEST EXISTANT ?" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
if (Test-Path "vitest.config.ts") {
    Write-Host "  ⚠️  vitest.config.ts DÉJÀ PRÉSENT" -ForegroundColor Yellow
} else {
    Write-Host "  ✅ Pas de vitest.config.ts (prêt pour création)" -ForegroundColor Green
}

if (Test-Path "package.json") {
    $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    if ($packageJson.devDependencies -and $packageJson.devDependencies.vitest) {
        Write-Host "  ⚠️  Vitest DÉJÀ INSTALLÉ: $($packageJson.devDependencies.vitest)" -ForegroundColor Yellow
    } else {
        Write-Host "  ✅ Vitest non installé (prêt pour installation)" -ForegroundColor Green
    }
}
Write-Host ""

# Résumé
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  RÉSUMÉ DE L'ANALYSE                                         ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "Tests existants   : $($testFiles.Count) fichier(s)" -ForegroundColor $(if ($testFiles.Count -gt 0) { "Green" } else { "Red" })
Write-Host "Config Jest       : $(if ($jestConfigFound) { '✅ Trouvée' } else { '❌ Absente' })" -ForegroundColor $(if ($jestConfigFound) { "Green" } else { "Red" })
Write-Host "Dépendances Jest  : $(if ($jestDeps.Count -gt 0) { "$($jestDeps.Count) trouvée(s)" } else { 'Aucune' })" -ForegroundColor $(if ($jestDeps.Count -gt 0) { "Yellow" } else { "Green" })
Write-Host "Vitest existant   : $(if (Test-Path 'vitest.config.ts') { '⚠️  OUI' } else { '✅ NON' })" -ForegroundColor $(if (Test-Path 'vitest.config.ts') { "Yellow" } else { "Green" })
Write-Host ""

# Sauvegarde du résultat
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outputFile = "vitest-migration/analysis-result-$timestamp.txt"
$output = @"
=== ANALYSE EXISTANT - Migration Jest → Vitest ===
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Fichiers de tests: $($testFiles.Count)
Configuration Jest: $(if ($jestConfigFound) { 'Trouvée' } else { 'Absente' })
Dépendances Jest: $($jestDeps.Count)
Vitest existant: $(if (Test-Path 'vitest.config.ts') { 'OUI' } else { 'NON' })

Tests trouvés:
$($testFiles | ForEach-Object { "  - " + $_.FullName.Replace((Get-Location).Path + "\", "") } | Out-String)

Dépendances Jest:
$($jestDeps | Out-String)
"@

New-Item -ItemType Directory -Force -Path (Split-Path $outputFile) | Out-Null
Set-Content -Path $outputFile -Value $output -Encoding UTF8
Write-Host "📄 Résultat sauvegardé dans: $outputFile" -ForegroundColor Cyan
Write-Host ""