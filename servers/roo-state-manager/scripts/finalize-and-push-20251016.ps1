#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Finalisation sous-module : commit modifications + pull rebase + préparation push
.DESCRIPTION
    Étapes :
    1. Commit package.json + script dans sous-module
    2. Pull rebase sous-module (résout divergence)
    3. Validation état clean
    Mission : Validation Fonctionnelle MCP et Push Final Sécurisé
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
Push-Location $ServerDir

try {
    Write-Host "🔧 FINALISATION SOUS-MODULE AVANT PUSH" -ForegroundColor Cyan
    Write-Host ""

    # 1. Commit modifications locales
    Write-Host "📝 COMMIT MODIFICATIONS LOCALES..." -ForegroundColor Cyan
    
    git add package.json
    git add scripts/commit-tsconfig-fix-20251016.ps1
    
    Write-Host "  + package.json (main: build/index.js)" -ForegroundColor Gray
    Write-Host "  + scripts/commit-tsconfig-fix-20251016.ps1" -ForegroundColor Gray
    
    $commitMsg = @"
chore(build): Add commit script + update package.json main path

- Update package.json main: build/src/index.js → build/index.js
- Add commit-tsconfig-fix-20251016.ps1 for tracking
- Aligns with tsconfig.json rootDir correction (commit 7c0d751)

Part of: Mission Validation Fonctionnelle MCP et Push Final Sécurisé
"@

    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "❌ Commit échoué" -ForegroundColor Red
        exit 1
    }
    
    Write-Host ""
    Write-Host "✅ Commit local réussi" -ForegroundColor Green
    $newSHA = git rev-parse HEAD
    Write-Host "  SHA: $newSHA" -ForegroundColor Gray

    # 2. État avant rebase
    Write-Host ""
    Write-Host "📊 ÉTAT AVANT REBASE:" -ForegroundColor Cyan
    git log origin/main..HEAD --oneline

    # 3. Pull rebase
    Write-Host ""
    Write-Host "🔄 PULL REBASE..." -ForegroundColor Cyan
    git pull --rebase origin main
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "❌ REBASE ÉCHOUÉ" -ForegroundColor Red
        Write-Host "ACTION: Résoudre conflits ou git rebase --abort" -ForegroundColor Yellow
        exit 1
    }

    # 4. Vérification post-rebase
    Write-Host ""
    Write-Host "✅ REBASE RÉUSSI" -ForegroundColor Green
    Write-Host ""
    Write-Host "📊 ÉTAT APRÈS REBASE:" -ForegroundColor Cyan
    git status --short --branch
    
    Write-Host ""
    Write-Host "📜 HISTORIQUE (5 derniers):" -ForegroundColor Cyan
    git log --oneline -5

    # 5. Vérifier prêt pour push
    $behind = (git rev-list --count HEAD..origin/main)
    if ($behind -gt 0) {
        Write-Host ""
        Write-Host "⚠️ Encore $behind commits distants non intégrés" -ForegroundColor Yellow
        exit 1
    }

    Write-Host ""
    Write-Host "✅ SOUS-MODULE PRÊT POUR PUSH" -ForegroundColor Green
    Write-Host "SHA final: $(git rev-parse HEAD)" -ForegroundColor Gray

} catch {
    Write-Host ""
    Write-Host "❌ ERREUR: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}