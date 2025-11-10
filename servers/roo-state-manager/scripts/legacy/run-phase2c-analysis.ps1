#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Phase 2c : Generation des statistiques detaillees de reconstitution parentID

.DESCRIPTION
    Ce script automatise la Phase 2c de validation du systeme de gestion des hierarchies de taches.
    Il genere des statistiques detaillees pour valider que le systeme identifie une majorite 
    ecrasante de relations hierarchiques dans chaque workspace.

.PARAMETER ForceRebuild
    Force la reconstruction complete du cache skeleton, meme s'il existe deja

.PARAMETER AnalysisOnly
    Lance uniquement l'analyse sans reconstruire le cache

.PARAMETER TimeoutMinutes
    Timeout en minutes pour la generation du cache (defaut: 10)

.EXAMPLE
    .\run-phase2c-analysis.ps1
    Lance l'analyse complete Phase 2c

.EXAMPLE
    .\run-phase2c-analysis.ps1 -ForceRebuild
    Force la reconstruction du cache avant analyse

.EXAMPLE
    .\run-phase2c-analysis.ps1 -AnalysisOnly
    Lance uniquement l'analyse sur le cache existant

.NOTES
    Auteur: Phase 2c Roo Extensions Team  
    Version: 1.0
    Cree: 2025-10-03
    
    OBJECTIFS DE VALIDATION:
    - >=70% de taches avec enfants par workspace principal
    - Detection patterns "j'aimerais" dans taches racines
    - <20% taches orphelines reelles
    - Identification claire vraies racines vs enfants sans parent
#>

param(
    [switch]$ForceRebuild,
    [switch]$AnalysisOnly,
    [int]$TimeoutMinutes = 10
)

# Configuration
$ErrorActionPreference = "Continue"
$OriginalEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Chemins
$RootPath = Split-Path -Parent $PSScriptRoot
$CachePath = Join-Path $RootPath ".roo-state-manager\skeleton-cache.json"
$ReportPath = Join-Path $RootPath "docs\RAPPORT-STATS-PARENTID-PHASE2C.md"
$BuildPath = Join-Path $RootPath "build\src\index.js"

# Fonctions utilitaires
function Write-Header {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=" * 80) -ForegroundColor Cyan
    Write-Host " $Title" -ForegroundColor Yellow
    Write-Host ("=" * 80) -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Message)
    Write-Host "🔍 $Message" -ForegroundColor Green
}

function Write-Success {
    param([string]$Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠️  $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "❌ $Message" -ForegroundColor Red
}

function Test-NodeModule {
    try {
        $nodeVersion = node --version
        Write-Host "Node.js version: $nodeVersion" -ForegroundColor Gray
        return $true
    } catch {
        Write-Error "Node.js n'est pas installe ou accessible"
        return $false
    }
}

function Build-Project {
    Write-Step "Build du projet roo-state-manager..."
    
    try {
        Push-Location $RootPath
        
        # Verifier si package.json existe
        if (-not (Test-Path "package.json")) {
            Write-Error "package.json introuvable dans $RootPath"
            return $false
        }
        
        # Build
        npm run build 2>&1 | Tee-Object -Variable buildOutput
        
        if ($LASTEXITCODE -eq 0 -and (Test-Path $BuildPath)) {
            Write-Success "Build reussi"
            return $true
        } else {
            Write-Warning "Build echoue ou fichier manquant, continuons avec le cache existant"
            return $false
        }
    } catch {
        Write-Warning "Erreur durant le build: $($_.Exception.Message)"
        return $false
    } finally {
        Pop-Location
    }
}

function Test-ExistingCache {
    if (Test-Path $CachePath) {
        $cacheInfo = Get-Item $CachePath
        try {
            $cacheContent = Get-Content $CachePath -Raw | ConvertFrom-Json
            $taskCount = ($cacheContent | Get-Member -MemberType NoteProperty).Count
            
            Write-Host "📋 Cache existant trouve:" -ForegroundColor Cyan
            Write-Host "   - Chemin: $CachePath" -ForegroundColor Gray
            Write-Host "   - Taille: $($cacheInfo.Length) bytes" -ForegroundColor Gray
            Write-Host "   - Taches: $taskCount" -ForegroundColor Gray
            Write-Host "   - Modifie: $($cacheInfo.LastWriteTime)" -ForegroundColor Gray
            
            return @{
                Exists = $true
                TaskCount = $taskCount
                LastModified = $cacheInfo.LastWriteTime
            }
        } catch {
            Write-Warning "Cache existant mais illisible"
            return @{ Exists = $false }
        }
    } else {
        Write-Host "📋 Aucun cache skeleton trouve" -ForegroundColor Yellow
        return @{ Exists = $false }
    }
}

function Generate-SkeletonCache {
    param([int]$TimeoutMinutes)
    
    Write-Step "Generation du cache skeleton..."
    
    try {
        Push-Location $RootPath
        
        # Lancer le script de generation avec timeout
        $job = Start-Job -ScriptBlock {
            param($RootPath)
            Set-Location $RootPath
            node "scripts/generate-skeleton-cache.mjs"
        } -ArgumentList $RootPath
        
        Write-Host "⏱️  Generation en cours (timeout: $TimeoutMinutes minutes)..." -ForegroundColor Cyan
        
        if (Wait-Job $job -Timeout ($TimeoutMinutes * 60)) {
            $result = Receive-Job $job
            Write-Host $result
            
            if ($job.State -eq "Completed") {
                Write-Success "Cache skeleton genere avec succes"
                return $true
            } else {
                Write-Error "Erreur durant la generation du cache"
                return $false
            }
        } else {
            Write-Warning "Timeout de generation du cache ($TimeoutMinutes min)"
            Stop-Job $job
            return $false
        }
    } catch {
        Write-Error "Erreur generation cache: $($_.Exception.Message)"
        return $false
    } finally {
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        Pop-Location
    }
}

function Run-StatisticsAnalysis {
    Write-Step "Lancement de l'analyse des statistiques parentID..."
    
    try {
        Push-Location $RootPath
        
        # Executer l'analyse
        node "scripts/analyze-parentid-stats.mjs" 2>&1 | Tee-Object -Variable analysisOutput
        
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Analyse des statistiques terminee avec succes"
            
            # Afficher le resume si disponible
            $summaryLines = $analysisOutput | Select-String "🎯 RESUME PHASE 2C:" -A 10
            if ($summaryLines) {
                Write-Host ""
                Write-Host "RESUME:" -ForegroundColor Yellow
                $summaryLines | ForEach-Object { Write-Host $_.Line -ForegroundColor Cyan }
            }
            
            return $true
        } else {
            Write-Error "Erreur durant l'analyse des statistiques"
            return $false
        }
    } catch {
        Write-Error "Erreur analyse: $($_.Exception.Message)"
        return $false
    } finally {
        Pop-Location
    }
}

function Show-ValidationResults {
    if (Test-Path $ReportPath) {
        Write-Header "RESULTATS PHASE 2C"
        
        $reportContent = Get-Content $ReportPath -Raw
        
        # Extraire les metriques de validation
        $metricsSection = $reportContent -split "## 📈 METRIQUES DE VALIDATION PHASE 2C" | Select-Object -Last 1
        
        if ($metricsSection) {
            Write-Host "📈 METRIQUES DE VALIDATION:" -ForegroundColor Yellow
            $metricsSection -split "`n" | Select-Object -First 10 | ForEach-Object {
                if ($_ -match "✅|❌") {
                    $color = if ($_ -match "✅") { "Green" } else { "Red" }
                    Write-Host "   $_" -ForegroundColor $color
                }
            }
        }
        
        Write-Host ""
        Write-Host "📊 Rapport complet disponible: $ReportPath" -ForegroundColor Cyan
        
        # Ouvrir le rapport si possible
        try {
            if ($IsWindows -or $env:OS -eq "Windows_NT") {
                Write-Host "💡 Tentative d'ouverture du rapport..." -ForegroundColor Gray
                Start-Process $ReportPath -ErrorAction SilentlyContinue
            }
        } catch {
            # Ignorer silencieusement si l'ouverture echoue
        }
    } else {
        Write-Warning "Rapport non trouve: $ReportPath"
    }
}

# MAIN EXECUTION
Write-Header "PHASE 2C : STATISTIQUES RECONSTITUTION PARENTID"

Write-Host "Parametres:" -ForegroundColor Cyan
Write-Host "  - ForceRebuild: $ForceRebuild" -ForegroundColor Gray
Write-Host "  - AnalysisOnly: $AnalysisOnly" -ForegroundColor Gray
Write-Host "  - TimeoutMinutes: $TimeoutMinutes" -ForegroundColor Gray
Write-Host "  - Repertoire: $RootPath" -ForegroundColor Gray

# Etape 1 : Verifications preliminaires
Write-Header "ETAPE 1 : VERIFICATIONS"

if (-not (Test-NodeModule)) {
    Write-Error "Node.js requis pour executer les scripts"
    exit 1
}

# Etape 2 : Gestion du cache skeleton
Write-Header "ETAPE 2 : CACHE SKELETON"

$cacheInfo = Test-ExistingCache
$needsRebuild = $ForceRebuild -or -not $cacheInfo.Exists

if (-not $AnalysisOnly) {
    if ($needsRebuild) {
        if (-not $cacheInfo.Exists) {
            Write-Step "Aucun cache existant, generation requise"
        } else {
            Write-Step "Reconstruction forcee du cache"
        }
        
        # Build du projet si necessaire
        $buildSuccess = Build-Project
        
        # Generation du cache
        $cacheSuccess = Generate-SkeletonCache -TimeoutMinutes $TimeoutMinutes
        
        if (-not $cacheSuccess) {
            Write-Warning "Generation du cache echouee, utilisation du cache existant si disponible"
            if (-not $cacheInfo.Exists) {
                Write-Error "Aucun cache disponible pour l'analyse"
                exit 1
            }
        }
    } else {
        Write-Success "Cache existant utilise ($($cacheInfo.TaskCount) taches)"
        
        # Verifier si le cache est recent
        $ageHours = (Get-Date).Subtract($cacheInfo.LastModified).TotalHours
        if ($ageHours -gt 24) {
            Write-Warning "Cache ancien ($([math]::Round($ageHours, 1))h), considerer -ForceRebuild"
        }
    }
} else {
    Write-Step "Mode analyse uniquement"
    if (-not $cacheInfo.Exists) {
        Write-Error "Aucun cache trouve pour l'analyse"
        exit 1
    }
}

# Etape 3 : Analyse des statistiques
Write-Header "ETAPE 3 : ANALYSE STATISTIQUES"

$analysisSuccess = Run-StatisticsAnalysis

if (-not $analysisSuccess) {
    Write-Error "Echec de l'analyse des statistiques"
    exit 1
}

# Etape 4 : Presentation des resultats
Write-Header "ETAPE 4 : RESULTATS"

Show-ValidationResults

# Finalisation
Write-Header "PHASE 2C TERMINEE"

if ($analysisSuccess) {
    Write-Success "Phase 2c executee avec succes"
    Write-Host ""
    Write-Host "📋 Actions recommandees:" -ForegroundColor Yellow
    Write-Host "  1. Examiner le rapport genere" -ForegroundColor Gray
    Write-Host "  2. Valider les metriques vs objectifs Phase 2c" -ForegroundColor Gray
    Write-Host "  3. Si >= 70% hierarchie: pret pour production" -ForegroundColor Gray
    Write-Host "  4. Si moins de 70%: analyser et ameliorer" -ForegroundColor Gray
} else {
    Write-Error "Phase 2c terminee avec des erreurs"
    exit 1
}

# Restaurer l'encodage
[Console]::OutputEncoding = $OriginalEncoding