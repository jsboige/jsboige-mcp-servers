#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Résolution automatique du conflit dans registry.ts
.DESCRIPTION
    Résout le conflit merge en gardant la version HEAD (--ours)
    qui contient tous les outils RooSync Messaging + get_current_task
    Mission : Validation Fonctionnelle MCP et Push Final Sécurisé
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
Push-Location $ServerDir

try {
    Write-Host "🔧 RÉSOLUTION CONFLIT registry.ts" -ForegroundColor Cyan
    Write-Host ""

    # 1. Vérifier état rebase
    $rebaseStatus = git status --short
    if ($rebaseStatus -notmatch "registry.ts") {
        Write-Host "⚠️ Pas de conflit détecté dans registry.ts" -ForegroundColor Yellow
        git status
        exit 1
    }

    Write-Host "📊 CONFLIT DÉTECTÉ:" -ForegroundColor Cyan
    git status --short

    # 2. Résolution avec stratégie --ours (garder HEAD)
    Write-Host ""
    Write-Host "🔧 RÉSOLUTION STRATÉGIE --OURS (garder version locale)..." -ForegroundColor Cyan
    Write-Host "  Version HEAD contient :" -ForegroundColor Gray
    Write-Host "    + Tous les outils RooSync Messaging (Phase 1+2)" -ForegroundColor Gray
    Write-Host "    + Handler get_current_task déjà intégré (ligne 406)" -ForegroundColor Gray
    Write-Host "  Version upstream contient :" -ForegroundColor Gray
    Write-Host "    + Doublon get_current_task (déjà présent)" -ForegroundColor Gray
    
    git checkout --ours src/tools/registry.ts
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "❌ Checkout --ours échoué" -ForegroundColor Red
        exit 1
    }

    # 3. Stage fichier résolu
    Write-Host ""
    Write-Host "➕ STAGING FICHIER RÉSOLU..." -ForegroundColor Cyan
    git add src/tools/registry.ts
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "❌ Git add échoué" -ForegroundColor Red
        exit 1
    }

    # 4. Continuer rebase
    Write-Host ""
    Write-Host "🔄 CONTINUATION REBASE..." -ForegroundColor Cyan
    git rebase --continue
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "❌ Rebase --continue échoué" -ForegroundColor Red
        Write-Host "État git:" -ForegroundColor Cyan
        git status
        exit 1
    }

    # 5. Vérification finale
    Write-Host ""
    Write-Host "✅ REBASE COMPLÉTÉ" -ForegroundColor Green
    Write-Host ""
    Write-Host "📊 ÉTAT FINAL:" -ForegroundColor Cyan
    git status --short --branch
    
    Write-Host ""
    Write-Host "📜 HISTORIQUE (5 derniers):" -ForegroundColor Cyan
    git log --oneline -5

    Write-Host ""
    Write-Host "✅ CONFLIT RÉSOLU - Sous-module prêt pour push" -ForegroundColor Green

} catch {
    Write-Host ""
    Write-Host "❌ ERREUR: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}