#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test de démarrage du serveur MCP roo-state-manager
.DESCRIPTION
    Valide que le serveur démarre correctement après rebuild
    Partie de la mission : Validation Fonctionnelle MCP et Push Final Sécurisé
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
Push-Location $ServerDir

try {
    Write-Host "🧪 TEST DÉMARRAGE SERVEUR MCP" -ForegroundColor Cyan
    Write-Host "Répertoire: $ServerDir" -ForegroundColor Gray
    Write-Host ""

    # Vérifier présence build/index.js
    if (-not (Test-Path "build/index.js")) {
        Write-Host "❌ ERREUR: build/index.js introuvable" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ build/index.js présent" -ForegroundColor Green

    # Démarrer serveur avec timeout
    Write-Host ""
    Write-Host "🚀 Démarrage serveur (timeout 8s)..." -ForegroundColor Cyan
    
    $job = Start-Job -ScriptBlock {
        Set-Location $using:ServerDir
        npm start 2>&1
    }

    # Attendre 8 secondes
    $waited = Wait-Job $job -Timeout 8

    if ($null -eq $waited) {
        # Timeout atteint = serveur probablement démarré
        Write-Host "✅ Serveur démarré (timeout atteint = processus actif)" -ForegroundColor Green
        Stop-Job $job -ErrorAction SilentlyContinue
    } else {
        # Job terminé prématurément = erreur
        Write-Host "❌ Serveur terminé prématurément" -ForegroundColor Red
        $output = Receive-Job $job
        Write-Host $output -ForegroundColor Yellow
        Remove-Job $job
        exit 1
    }

    # Récupérer sortie
    $output = Receive-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force

    Write-Host ""
    Write-Host "📋 SORTIE SERVEUR:" -ForegroundColor Cyan
    if ($output) {
        Write-Host $output -ForegroundColor Gray
    } else {
        Write-Host "(Aucune sortie capturée avant timeout)" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "✅ VALIDATION RÉUSSIE" -ForegroundColor Green
    Write-Host "Le serveur démarre sans erreur critique" -ForegroundColor Gray

} catch {
    Write-Host ""
    Write-Host "❌ ERREUR: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}