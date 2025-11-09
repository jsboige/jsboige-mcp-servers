#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Commit de la correction tsconfig.json dans le sous-module
.DESCRIPTION
    Phase de commit sécurisée pour la correction du build path
    Mission : Validation Fonctionnelle MCP et Push Final Sécurisé
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
Push-Location $ServerDir

try {
    Write-Host "📝 COMMIT CORRECTION TSCONFIG" -ForegroundColor Cyan
    Write-Host ""

    # Vérifier qu'on est dans le bon répertoire
    $gitRoot = git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Pas dans un dépôt git" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Dépôt git détecté: $gitRoot" -ForegroundColor Green

    # Vérifier état avant commit
    Write-Host ""
    Write-Host "📊 ÉTAT GIT AVANT COMMIT:" -ForegroundColor Cyan
    git status --short

    # Vérifier fichiers modifiés
    $modified = git status --short
    if ($modified -notmatch "tsconfig.json") {
        Write-Host ""
        Write-Host "⚠️ tsconfig.json non modifié, vérification étendue..." -ForegroundColor Yellow
        git diff --name-only HEAD
    }

    # Stage des fichiers critiques
    Write-Host ""
    Write-Host "➕ STAGING FICHIERS..." -ForegroundColor Cyan
    
    git add tsconfig.json
    if (Test-Path "scripts/test-startup-20251016.ps1") {
        git add scripts/test-startup-20251016.ps1
        Write-Host "  + scripts/test-startup-20251016.ps1" -ForegroundColor Gray
    }
    Write-Host "  + tsconfig.json" -ForegroundColor Gray

    # Rebuild pour assurer cohérence (fichiers build/ pas commités)
    Write-Host ""
    Write-Host "🔄 REBUILD AVANT COMMIT..." -ForegroundColor Cyan
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Build échoué" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Build réussi" -ForegroundColor Green

    # Commit
    Write-Host ""
    Write-Host "💾 COMMIT..." -ForegroundColor Cyan
    $commitMsg = @"
fix(build): Correct tsconfig.json rootDir for proper build output

- Changed rootDir from "." to "./src" to flatten build structure
- Fixes MODULE_NOT_FOUND error (expected build/index.js, got build/src/index.js)
- Server now starts successfully
- Added test-startup-20251016.ps1 for validation

Validation: npm start succeeds with timeout (server running)
Part of: Mission Validation Fonctionnelle MCP et Push Final Sécurisé
"@

    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Commit échoué" -ForegroundColor Red
        exit 1
    }

    # Vérifier état après commit
    Write-Host ""
    Write-Host "📊 ÉTAT APRÈS COMMIT:" -ForegroundColor Cyan
    git log --oneline -1
    git status --short

    Write-Host ""
    Write-Host "✅ COMMIT RÉUSSI" -ForegroundColor Green
    Write-Host "SHA: $(git rev-parse HEAD)" -ForegroundColor Gray

} catch {
    Write-Host ""
    Write-Host "❌ ERREUR: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}