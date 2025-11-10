#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Point d'entree principal pour les scripts consolidés roo-state-manager
.DESCRIPTION
    Interface unifiee pour acceder rapidement a toutes les fonctionnalités
    des scripts consolidés (tests, deploiement, diagnostic, cache)
.PARAMETER Action
    Action principale a executer
.PARAMETER Type
    Type specifique pour l'action (tests, diagnostic, etc.)
.PARAMETER Verbose
    Active le mode verbeux
.EXAMPLE
    .\roo.ps1 test
    Lance les tests unitaires
.EXAMPLE
    .\roo.ps1 deploy
    Lance le deploiement complet
.EXAMPLE
    .\roo.ps1 diagnose
    Lance le diagnostic complet
#>

[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet("test", "deploy", "diagnose", "cache", "help", "version")]
    [string]$Action = "help",
    
    [Parameter(Position=1)]
    [string]$Type = "",
    
    [switch]$Detailed,
    [switch]$Force,
    [switch]$Quiet,
    [string]$Output = "",
    [switch]$Help
)

# Configuration
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$CONSOLIDATED_DIR = Join-Path $SCRIPT_DIR "consolidated"
$CONFIG_DIR = Join-Path $SCRIPT_DIR "config"

# Fonctions de logging
function Write-Logo {
    Write-Host @"
========================================
     ROO-STATE-MANAGER v1.0.0
     Scripts Consolidés Unifiés
========================================
"@ -ForegroundColor Cyan
}

function Write-Usage {
    Write-Host @"
UTILISATION RAPIDE :

Tests :
  .\roo.ps1 test [unit|integration|all]     Tests unitaires (défaut: unit)
  .\roo.ps1 test -verbose                Tests détaillés
  
Deploiement :
  .\roo.ps1 deploy                       Déploiement complet
  .\roo.ps1 deploy -force                 Force le déploiement
  
Diagnostic :
  .\roo.ps1 diagnose [cache|system|all]    Diagnostic complet (défaut: all)
  .\roo.ps1 diagnose -verbose             Diagnostic détaillé
  
Cache :
  .\roo.ps1 cache [build|clean|validate]   Gestion du cache
  .\roo.ps1 cache build -force            Force la reconstruction
  
Aide :
  .\roo.ps1 help                         Affiche cette aide
  .\roo.ps1 version                      Affiche la version

COMMANDE SPECIFIQUE POUR LES TESTS UNITAIRES :
  .\roo.ps1 test unit
"@ -ForegroundColor Green
}

function Write-Version {
    Write-Host "ROO-STATE-MANAGER Scripts Consolidés v1.0.0" -ForegroundColor Cyan
    Write-Host "Date : 06/11/2025" -ForegroundColor White
    Write-Host "PowerShell : $($PSVersionTable.PSVersion)" -ForegroundColor White
}

# Fonctions d'exécution
function Invoke-Tests {
    param([string]$testType = "unit")
    
    $testScript = Join-Path $CONSOLIDATED_DIR "roo-tests.ps1"
    $params = @{}
    # Ajouter les paramètres nommés
    if ($testType -and $testType -ne "unit") {
        $params["TestMode"] = $testType
    }
    
    if ($Detailed) {
        $params["Detailed"] = $true
    }
    
    if ($Output -and $Output -ne "") {
        $params["OutputParam"] = $Output
    }
    
    Write-Host "Lancement des tests : $testType" -ForegroundColor Blue
    
    try {
        & $testScript @params
    } catch {
        Write-Error "Erreur lors de l'exécution du script de tests : $($_.Exception.Message)"
        throw
    }
}

function Invoke-Deploy {
    $deployScript = Join-Path $CONSOLIDATED_DIR "roo-deploy.ps1"
    $params = @("-Deploy")
    
    if ($Force) { $params += "-Force" }
    if ($Detailed) { $params += "-Verbose" }
    
    Write-Host "Lancement du déploiement" -ForegroundColor Blue
    & $deployScript @params
}

function Invoke-Diagnose {
    param([string]$diagType = "all")
    
    $diagnoseScript = Join-Path $CONSOLIDATED_DIR "roo-diagnose.ps1"
    $params = @("-Type", $diagType)
    
    if ($Detailed) { $params += "-Verbose" }
    if ($Detailed) { $params += "-Detailed" }
    
    Write-Host "Lancement du diagnostic : $diagType" -ForegroundColor Blue
    & $diagnoseScript @params
}

function Invoke-Cache {
    param([string]$cacheAction = "status")
    
    $cacheScript = Join-Path $CONSOLIDATED_DIR "roo-cache.ps1"
    $params = @("-Action", $cacheAction)
    
    if ($Force) { $params += "-Force" }
    if ($Detailed) { $params += "-Verbose" }
    
    Write-Host "Gestion du cache : $cacheAction" -ForegroundColor Blue
    & $cacheScript @params
}

# Vérification des prérequis
function Test-Prerequisites {
    $requiredDirs = @($CONSOLIDATED_DIR, $CONFIG_DIR)
    
    foreach ($dir in $requiredDirs) {
        if (-not (Test-Path $dir)) {
            Write-Error "Repertoire requis manquant : $dir"
            return $false
        }
    }
    
    $requiredScripts = @(
        "roo-tests.ps1",
        "roo-deploy.ps1", 
        "roo-diagnose.ps1",
        "roo-cache.ps1"
    )
    
    foreach ($script in $requiredScripts) {
        $scriptPath = Join-Path $CONSOLIDATED_DIR $script
        if (-not (Test-Path $scriptPath)) {
            Write-Error "Script requis manquant : $script"
            return $false
        }
    }
    
    return $true
}

# Point d'entrée principal
function Main {
    Write-Logo
    
    if ($Action -eq "help" -or $Help) {
        Write-Usage
        return
    }
    
    if ($Action -eq "version") {
        Write-Version
        return
    }
    
    # Vérification des prérequis
    if (-not (Test-Prerequisites)) {
        Write-Error "Prérequis non satisfaits. Vérifiez l'installation."
        exit 1
    }
    
    # Traitement des actions
    switch ($Action.ToLower()) {
        "test" {
            $testType = if ($Type) { $Type } else { "unit" }
            Invoke-Tests -testType $testType
        }
        
        "deploy" {
            Invoke-Deploy
        }
        
        "diagnose" {
            $diagType = if ($Type) { $Type } else { "all" }
            Invoke-Diagnose -diagType $diagType
        }
        
        "cache" {
            $cacheAction = if ($Type) { $Type } else { "status" }
            Invoke-Cache -cacheAction $cacheAction
        }
        
        default {
            Write-Error "Action non reconnue : $Action"
            Write-Usage
            exit 1
        }
    }
}

# Gestion des erreurs
trap {
    Write-Error "Erreur lors de l'exécution : $($_.Exception.Message)"
    Write-Host "Utilisez '.\roo.ps1 help' pour obtenir de l'aide" -ForegroundColor Yellow
    exit 1
}

# Lancement du programme principal
Main