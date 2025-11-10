#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Diagnostic du répertoire de sortie de compilation pour roo-state-manager

.DESCRIPTION
    Script de diagnostic pour identifier et documenter la configuration de sortie
    de compilation (tsconfig.json outDir vs package.json main).
    
    Ce script vérifie :
    - La configuration tsconfig.json (outDir)
    - La configuration package.json (main)
    - L'existence et le contenu des répertoires build/ et dist/
    - La cohérence entre les configurations

.PARAMETER Fix
    Supprime le répertoire dist/ s'il existe (ancien outDir potentiel)

.EXAMPLE
    .\diagnose-build-outdir-20251018.ps1
    Effectue un diagnostic complet

.EXAMPLE
    .\diagnose-build-outdir-20251018.ps1 -Fix
    Diagnostic + suppression de dist/ si présent

.NOTES
    Author: Roo Code (Code mode)
    Date: 2025-10-18
    Context: Investigation échec compilation dans rebuild-mcp-servers-20251018.ps1
    Issue: Script cherche dist/ mais tsconfig.json utilise outDir: "./build"
#>

param(
    [switch]$Fix
)

# Encodage UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Couleurs
$Cyan = "`e[36m"
$Green = "`e[32m"
$Yellow = "`e[33m"
$Red = "`e[31m"
$Gray = "`e[90m"
$Reset = "`e[0m"

# Vérifier qu'on est dans le bon répertoire
$expectedPath = "mcps\internal\servers\roo-state-manager"
$currentPath = (Get-Location).Path

if (-not $currentPath.EndsWith($expectedPath.Replace('\', [IO.Path]::DirectorySeparatorChar))) {
    Write-Host "${Red}❌ ERREUR: Ce script doit être exécuté depuis d:/roo-extensions/mcps/internal/servers/roo-state-manager${Reset}"
    Write-Host "${Yellow}Répertoire actuel: $currentPath${Reset}"
    exit 1
}

Write-Host "${Cyan}=== DIAGNOSTIC BUILD OUTPUT DIRECTORY ===${Reset}"
Write-Host ""

# 1. Analyser tsconfig.json
Write-Host "${Yellow}📄 Configuration tsconfig.json:${Reset}"

if (-not (Test-Path "tsconfig.json")) {
    Write-Host "${Red}❌ tsconfig.json introuvable${Reset}"
    exit 1
}

try {
    $tsconfig = Get-Content "tsconfig.json" -Raw | ConvertFrom-Json
    $outDir = $tsconfig.compilerOptions.outDir
    $rootDir = $tsconfig.compilerOptions.rootDir
    
    Write-Host "${Gray}  rootDir: $rootDir${Reset}"
    Write-Host "${Gray}  outDir: $outDir${Reset}"
    
    if ($outDir -eq "./build") {
        Write-Host "${Green}  ✅ outDir configuré sur './build'${Reset}"
    } elseif ($outDir -eq "./dist") {
        Write-Host "${Yellow}  ⚠️  outDir configuré sur './dist' (ancien?)${Reset}"
    } else {
        Write-Host "${Red}  ❌ outDir inattendu: $outDir${Reset}"
    }
} catch {
    Write-Host "${Red}❌ Erreur lecture tsconfig.json: $_${Reset}"
    exit 1
}

Write-Host ""

# 2. Analyser package.json
Write-Host "${Yellow}📦 Configuration package.json:${Reset}"

if (-not (Test-Path "package.json")) {
    Write-Host "${Red}❌ package.json introuvable${Reset}"
    exit 1
}

try {
    $package = Get-Content "package.json" -Raw | ConvertFrom-Json
    $mainPath = $package.main
    
    Write-Host "${Gray}  main: $mainPath${Reset}"
    
    if ($mainPath -like "build/*") {
        Write-Host "${Green}  ✅ main pointe vers build/${Reset}"
    } elseif ($mainPath -like "dist/*") {
        Write-Host "${Yellow}  ⚠️  main pointe vers dist/ (incohérence potentielle)${Reset}"
    } else {
        Write-Host "${Red}  ❌ main ne pointe ni vers build/ ni vers dist/: $mainPath${Reset}"
    }
    
    # Vérifier cohérence tsconfig.json outDir vs package.json main
    $expectedMainDir = $outDir.TrimStart('.').TrimStart('/')
    if ($mainPath.StartsWith($expectedMainDir)) {
        Write-Host "${Green}  ✅ Cohérence: package.json main correspond à tsconfig.json outDir${Reset}"
    } else {
        Write-Host "${Red}  ❌ INCOHÉRENCE: package.json main ($mainPath) ne correspond pas à tsconfig.json outDir ($outDir)${Reset}"
    }
} catch {
    Write-Host "${Red}❌ Erreur lecture package.json: $_${Reset}"
    exit 1
}

Write-Host ""

# 3. Vérifier existence répertoires
Write-Host "${Yellow}📁 Vérification répertoires de sortie:${Reset}"

# build/
if (Test-Path "build") {
    Write-Host "${Green}  ✅ build/ existe${Reset}"
    
    $buildFiles = Get-ChildItem "build" -Recurse -Filter "*.js" -ErrorAction SilentlyContinue
    $buildCount = ($buildFiles | Measure-Object).Count
    
    if ($buildCount -gt 0) {
        Write-Host "${Gray}     Fichiers .js compilés: $buildCount${Reset}"
        
        # Afficher quelques exemples
        $buildFiles | Select-Object -First 3 | ForEach-Object {
            Write-Host "${Gray}     - $($_.Name)${Reset}"
        }
        
        if ($buildCount -gt 3) {
            Write-Host "${Gray}     ... et $($buildCount - 3) autres${Reset}"
        }
    } else {
        Write-Host "${Yellow}     ⚠️  Aucun fichier .js trouvé dans build/${Reset}"
    }
} else {
    Write-Host "${Red}  ❌ build/ manquant${Reset}"
}

Write-Host ""

# dist/
if (Test-Path "dist") {
    Write-Host "${Yellow}  ⚠️  dist/ existe (potentiellement ancien outDir)${Reset}"
    
    $distFiles = Get-ChildItem "dist" -Recurse -Filter "*.js" -ErrorAction SilentlyContinue
    $distCount = ($distFiles | Measure-Object).Count
    
    if ($distCount -gt 0) {
        Write-Host "${Gray}     Fichiers .js compilés: $distCount${Reset}"
        Write-Host "${Yellow}     ⚠️  dist/ contient des fichiers compilés obsolètes${Reset}"
    } else {
        Write-Host "${Gray}     dist/ vide ou sans .js${Reset}"
    }
    
    if ($Fix) {
        Write-Host ""
        Write-Host "${Yellow}  🗑️  Suppression de dist/ (Fix activé)...${Reset}"
        
        try {
            Remove-Item -Path "dist" -Recurse -Force -ErrorAction Stop
            Write-Host "${Green}     ✅ dist/ supprimé${Reset}"
        } catch {
            Write-Host "${Red}     ❌ Erreur suppression dist/: $_${Reset}"
        }
    }
} else {
    Write-Host "${Green}  ✅ dist/ absent (OK)${Reset}"
}

Write-Host ""

# 4. Vérifier src/
Write-Host "${Yellow}📝 Vérification sources TypeScript:${Reset}"

if (Test-Path "src") {
    $tsFiles = Get-ChildItem "src" -Recurse -Filter "*.ts" -ErrorAction SilentlyContinue
    $tsCount = ($tsFiles | Measure-Object).Count
    
    Write-Host "${Green}  ✅ src/ existe${Reset}"
    Write-Host "${Gray}     Fichiers .ts: $tsCount${Reset}"
} else {
    Write-Host "${Red}  ❌ src/ manquant${Reset}"
}

Write-Host ""

# 5. Résumé et recommandations
Write-Host "${Cyan}=== RÉSUMÉ ET RECOMMANDATIONS ===${Reset}"
Write-Host ""

$issues = @()
$success = $true

# Vérifier incohérence outDir vs main
if ($outDir -ne "./build" -or $mainPath -notlike "build/*") {
    $issues += "❌ INCOHÉRENCE: tsconfig.json outDir ($outDir) et package.json main ($mainPath) ne correspondent pas"
    $success = $false
}

# Vérifier existence build/
if (-not (Test-Path "build")) {
    $issues += "❌ CRITIQUE: Répertoire build/ manquant - compilation non exécutée ou échouée"
    $success = $false
}

# Vérifier présence fichiers compilés
if (Test-Path "build") {
    $buildFiles = Get-ChildItem "build" -Recurse -Filter "*.js" -ErrorAction SilentlyContinue
    if (($buildFiles | Measure-Object).Count -eq 0) {
        $issues += "⚠️  WARNING: build/ existe mais ne contient aucun fichier .js"
        $success = $false
    }
}

# Vérifier dist/ inattendu
if (Test-Path "dist") {
    $issues += "⚠️  WARNING: dist/ existe (ancien outDir?) - peut causer confusion"
}

if ($issues.Count -gt 0) {
    Write-Host "${Yellow}Problèmes détectés:${Reset}"
    foreach ($issue in $issues) {
        Write-Host "  $issue"
    }
    Write-Host ""
}

if ($success -and -not (Test-Path "dist")) {
    Write-Host "${Green}✅ SUCCÈS: Configuration cohérente${Reset}"
    Write-Host "${Gray}   - tsconfig.json outDir: $outDir${Reset}"
    Write-Host "${Gray}   - package.json main: $mainPath${Reset}"
    Write-Host "${Gray}   - build/ existe avec fichiers compilés${Reset}"
    Write-Host ""
    Write-Host "${Green}👉 Le script rebuild-mcp-servers-20251018.ps1 doit chercher build/ et non dist/${Reset}"
} elseif (Test-Path "dist") {
    Write-Host "${Yellow}⚠️  ATTENTION: Configuration potentiellement correcte mais dist/ présent${Reset}"
    Write-Host ""
    Write-Host "${Yellow}👉 Recommandations:${Reset}"
    Write-Host "   1. Supprimer dist/: ${Gray}.\diagnose-build-outdir-20251018.ps1 -Fix${Reset}"
    Write-Host "   2. Recompiler: ${Gray}npm run build${Reset}"
    Write-Host "   3. Mettre à jour rebuild-mcp-servers-20251018.ps1 pour chercher build/${Reset}"
} else {
    Write-Host "${Red}❌ ÉCHEC: Problèmes de configuration détectés${Reset}"
    Write-Host ""
    Write-Host "${Yellow}👉 Recommandations:${Reset}"
    Write-Host "   1. Vérifier tsconfig.json outDir et package.json main${Reset}"
    Write-Host "   2. Recompiler: ${Gray}npm run build${Reset}"
    Write-Host "   3. Vérifier présence fichiers dans build/${Reset}"
}

Write-Host ""

# Exit code
if ($success -and -not (Test-Path "dist")) {
    exit 0
} else {
    exit 1
}