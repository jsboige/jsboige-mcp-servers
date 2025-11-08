#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Consolidation des fichiers markdown à la racine du MCP dans docs/

.DESCRIPTION
    Script de migration des fichiers .md dispersés à la racine vers une structure organisée dans docs/
    
.PARAMETER DryRun
    Simule les opérations sans les exécuter
    
.EXAMPLE
    .\consolidate-docs.ps1 -DryRun
    .\consolidate-docs.ps1
#>

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..

Write-Host "=== Consolidation des fichiers Markdown ===" -ForegroundColor Cyan
Write-Host ""

if ($DryRun) {
    Write-Host "[MODE DRY-RUN] Aucune modification ne sera effectuée" -ForegroundColor Yellow
    Write-Host ""
}

# Définition de la structure cible
$structure = @{
    "tests" = @(
        "AUDIT-TESTS-LAYOUT.md",
        "TEST-SUITE-COMPLETE-RESULTS.md", 
        "TESTS-ORGANIZATION.md",
        "NOUVEAU-LAYOUT-TESTS.md",
        "MIGRATION-PLAN-TESTS.md",
        "RAPPORT-FINAL-CORRECTION-TESTS-POST-MERGE.md"
    )
    "reports" = @(
        "RAPPORT-AVANCEMENT-REORGANISATION.md",
        "RAPPORT-FINAL-MISSION-VALIDATION-REORGANISATION-TESTS.md",
        "INDEX-LIVRABLES-REORGANISATION-TESTS.md",
        "RAPPORT-FINAL-VALIDATION-ARCHITECTURE-CONSOLIDEE.md",
        "RAPPORT-MISSION-ORCHESTRATEUR-VALIDATION-COMPLETE.md",
        "RAPPORT-DEPLOIEMENT-PHASE2.md",
        "FINALISATION_MISSION_PARSING.md"
    )
    "implementation" = @(
        "PHASE1-IMPLEMENTATION-REPORT.md",
        "PHASE2-VALIDATION-REPORT.md"
    )
    "debug" = @(
        "DEBUG-RESOLUTION-CYCLES.md",
        "DEBUGGING.md"
    )
    "parsing" = @(
        "ARBRE_HIERARCHIE_RECONSTRUITE_REPARE.md",
        "ARBRE_TACHES_MEGA_CONVERSATION_9381_MESSAGES.md",
        "ARBRE_TACHES_TEST_PARSING_FIX.md",
        "ARBRE_TACHES_VALIDATION_FINALE_6308_MESSAGES.md",
        "RAPPORT_PARSING_XML_SOUS_TACHES.md",
        "VALIDATION_FINALE_PARSING_XML_REPARE.md"
    )
}

# Fichiers à conserver à la racine
$keepAtRoot = @("README.md", "CHANGELOG.md")

# Statistiques
$stats = @{
    Created = 0
    Moved = 0
    Skipped = 0
    Errors = 0
}

function Move-FileSafely {
    param(
        [string]$Source,
        [string]$Destination
    )
    
    if (-not (Test-Path $Source)) {
        Write-Host "  ⚠️  Fichier source introuvable: $Source" -ForegroundColor Yellow
        $stats.Skipped++
        return $false
    }
    
    $destDir = Split-Path $Destination -Parent
    
    if ($DryRun) {
        Write-Host "  [DRY-RUN] Créerait: $destDir" -ForegroundColor Gray
        Write-Host "  [DRY-RUN] Déplacerait: $Source -> $Destination" -ForegroundColor Gray
        $stats.Moved++
        return $true
    }
    
    # Créer le répertoire cible si nécessaire
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        Write-Host "  ✅ Répertoire créé: $destDir" -ForegroundColor Green
        $stats.Created++
    }
    
    # Déplacer le fichier
    try {
        Move-Item -Path $Source -Destination $Destination -Force
        Write-Host "  ✅ Déplacé: $Source -> $Destination" -ForegroundColor Green
        $stats.Moved++
        return $true
    }
    catch {
        Write-Host "  ❌ Erreur lors du déplacement: $_" -ForegroundColor Red
        $stats.Errors++
        return $false
    }
}

# Parcourir chaque catégorie
foreach ($category in $structure.Keys) {
    Write-Host "📁 Catégorie: $category/" -ForegroundColor Cyan
    
    foreach ($file in $structure[$category]) {
        $source = $file
        $destination = "docs/$category/$file"
        
        Move-FileSafely -Source $source -Destination $destination
    }
    
    Write-Host ""
}

# Vérifier les fichiers à conserver à la racine
Write-Host "📌 Fichiers conservés à la racine:" -ForegroundColor Cyan
foreach ($file in $keepAtRoot) {
    if (Test-Path $file) {
        Write-Host "  ✅ $file (conservé)" -ForegroundColor Green
    }
    else {
        Write-Host "  ⚠️  $file (absent)" -ForegroundColor Yellow
    }
}
Write-Host ""

# Résumé
Write-Host "=== RÉSUMÉ ===" -ForegroundColor Cyan
Write-Host "Répertoires créés: $($stats.Created)" -ForegroundColor $(if ($stats.Created -gt 0) { "Green" } else { "Gray" })
Write-Host "Fichiers déplacés: $($stats.Moved)" -ForegroundColor $(if ($stats.Moved -gt 0) { "Green" } else { "Gray" })
Write-Host "Fichiers ignorés:  $($stats.Skipped)" -ForegroundColor $(if ($stats.Skipped -gt 0) { "Yellow" } else { "Gray" })
Write-Host "Erreurs:           $($stats.Errors)" -ForegroundColor $(if ($stats.Errors -gt 0) { "Red" } else { "Gray" })
Write-Host ""

if ($DryRun) {
    Write-Host "✅ Simulation terminée. Exécutez sans -DryRun pour appliquer les changements." -ForegroundColor Yellow
}
else {
    Write-Host "✅ Consolidation terminée!" -ForegroundColor Green
}