#!/usr/bin/env pwsh

<#
.SYNOPSIS
    🔒 VALIDATION SÉCURITÉ PHASE 2c - Script Documenté SDDD
    
.DESCRIPTION
    Script de consolidation des sécurités suite aux incompatibilités critiques découvertes.
    Vérifie que le nouveau système de parsing reste bloqué en attendant l'investigation Phase 2c.
    
.NOTES
    Auteur: Mission SDDD Critique
    Version: 1.0
    Date: 2025-10-03
    Contexte: Suspension déploiement suite à similarité 44.44% vs 90% requis
    
.LINK
    Documents liés:
    - PHASE-2B-COMPATIBILITY-ALERT.md
    - docs/architecture/roo-state-manager-parsing-refactoring.md
    
.EXAMPLE
    .\validate-phase-2c-security.ps1
    Exécute la validation complète des sécurités
#>

[CmdletBinding()]
param()

# Configuration du script
$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"

Write-Host "🔒 === VALIDATION SÉCURITÉ PHASE 2c - SDDD CRITIQUE ===" -ForegroundColor Red
Write-Host "⏰ Démarré à: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host ""

try {
    # Phase 1: Vérification structure projet
    Write-Host "📁 Phase 1: Vérification structure critique..." -ForegroundColor Yellow
    
    $requiredFiles = @(
        "src/utils/parsing-config.ts",
        "docs/PHASE-2B-COMPATIBILITY-ALERT.md",
        "validate-security-flags.js"
    )
    
    foreach ($file in $requiredFiles) {
        if (Test-Path $file) {
            Write-Host "  ✅ $file" -ForegroundColor Green
        } else {
            throw "❌ FICHIER CRITIQUE MANQUANT: $file"
        }
    }
    
    # Phase 2: Validation technique des feature flags
    Write-Host "`n🔧 Phase 2: Test technique des verrouillages..." -ForegroundColor Yellow
    Write-Host "  🚀 Exécution: node validate-security-flags.js" -ForegroundColor Gray
    
    $validationResult = node validate-security-flags.js
    $exitCode = $LASTEXITCODE
    
    # Phase 3: Analyse des résultats
    Write-Host "`n📊 Phase 3: Analyse des résultats de sécurité..." -ForegroundColor Yellow
    Write-Host $validationResult
    
    # Phase 4: Validation finale et rapport
    Write-Host "`n🛡️  Phase 4: Rapport de sécurité final..." -ForegroundColor Yellow
    
    if ($exitCode -eq 0) {
        Write-Host "  ✅ SÉCURITÉ CONFIRMÉE: Nouveau système correctement bloqué" -ForegroundColor Green
        Write-Host "  ✅ ANCIEN SYSTÈME: Protégé et opérationnel" -ForegroundColor Green
        Write-Host "  ✅ PHASE 2C: Investigation requise activée" -ForegroundColor Green
        
        # Génération horodatage succès
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $logFile = "validation-security-SUCCESS-$timestamp.log"
        
        @"
🔒 VALIDATION SÉCURITÉ PHASE 2c - SUCCÈS
==========================================
Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Status: ✅ SÉCURISÉ
Exit Code: $exitCode

Détails technique:
$validationResult

Prochaines étapes:
- Phase 2c investigation root cause prête à démarrer
- Nouveau système verrouillé jusqu'à résolution
- Documentation alertes à jour
"@ | Out-File -FilePath $logFile -Encoding UTF8
        
        Write-Host "`n📄 Log sauvegardé: $logFile" -ForegroundColor Cyan
        
    } else {
        Write-Host "  ❌ ERREUR CRITIQUE DE SÉCURITÉ DÉTECTÉE !" -ForegroundColor Red
        throw "Validation sécurité échouée avec code: $exitCode"
    }
    
    # Phase 5: Résumé consolidé
    Write-Host "`n🎯 === RÉSUMÉ CONSOLIDATION PHASE 2c ===" -ForegroundColor Magenta
    Write-Host "  🚨 Contexte: Incompatibilités critiques (44.44% similarité)" -ForegroundColor Yellow
    Write-Host "  🔒 Action: Suspension déploiement confirmée" -ForegroundColor Green
    Write-Host "  📋 Documentation: Alertes phase 2c à jour" -ForegroundColor Green
    Write-Host "  🔍 Prêt pour: Investigation root cause phase 2c" -ForegroundColor Green
    Write-Host ""
    Write-Host "✅ MISSION SÉCURISATION RÉUSSIE - Phase 2c peut débuter" -ForegroundColor Green

} catch {
    Write-Host "`n❌ ERREUR CRITIQUE:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    
    # Log d'erreur
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $errorLog = "validation-security-ERROR-$timestamp.log"
    
    @"
🔒 VALIDATION SÉCURITÉ PHASE 2c - ÉCHEC
=======================================
Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Status: ❌ ERREUR
Error: $($_.Exception.Message)

Action requise: Investigation immédiate des sécurités
"@ | Out-File -FilePath $errorLog -Encoding UTF8
    
    Write-Host "📄 Log d'erreur: $errorLog" -ForegroundColor Yellow
    exit 1
}