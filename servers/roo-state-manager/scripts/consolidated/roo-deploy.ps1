#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Script UNIFIÉ de déploiement pour roo-state-manager
    Remplace : deploy.ps1, deploy-simple.ps1

.DESCRIPTION
    Script paramétrable pour installer, compiler, tester et configurer le MCP Roo State Manager.
    Supporte toutes les étapes du déploiement avec validation des prérequis et logging détaillé.

.PARAMETER Install
    Installe les dépendances npm

.PARAMETER Build
    Compile le projet TypeScript

.PARAMETER Test
    Lance les tests de validation

.PARAMETER Configure
    Configure le serveur MCP

.PARAMETER Deploy
    Effectue une installation complète (install + build + test)

.PARAMETER SkipPrereqs
    Saute la vérification des prérequis

.PARAMETER Verbose
    Active le logging verbeux

.PARAMETER Config
    Chemin vers le fichier de configuration (défaut: config/deploy-config.json)

.PARAMETER Help
    Affiche l'aide détaillée

.EXAMPLE
    .\roo-deploy.ps1 -Deploy
    Effectue une installation complète

.EXAMPLE
    .\roo-deploy.ps1 -Install -Build -Test
    Installe, compile et teste séparément

.EXAMPLE
    .\roo-deploy.ps1 -Test -Verbose
    Lance uniquement les tests en mode verbeux
#>

param(
    [switch]$Install,
    [switch]$Build,
    [switch]$Test,
    [switch]$Configure,
    [switch]$Deploy,
    [switch]$SkipPrereqs,
    [switch]$Verbose,
    [string]$Config = "config/deploy-config.json",
    [switch]$Help
)

# Configuration
$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectRoot

# Charger la configuration
function Load-Config {
    param([string]$ConfigPath)
    
    $fullConfigPath = Join-Path $PSScriptRoot $ConfigPath
    if (Test-Path $fullConfigPath) {
        try {
            return Get-Content $fullConfigPath -Raw | ConvertFrom-Json
        } catch {
            Write-Warning "Impossible de charger la configuration : $fullConfigPath"
            return $null
        }
    } else {
        Write-Warning "Fichier de configuration non trouvé : $fullConfigPath"
        return $null
    }
}

# Fonctions de logging unifiées
function Write-Success($message) {
    Write-Host "✅ $message" -ForegroundColor Green
}

function Write-Error($message) {
    Write-Host "❌ $message" -ForegroundColor Red
}

function Write-Warning($message) {
    Write-Host "⚠️  $message" -ForegroundColor Yellow
}

function Write-Info($message) {
    Write-Host "ℹ️  $message" -ForegroundColor Blue
}

function Write-Verbose($message) {
    if ($Verbose) {
        Write-Host "🔍 $message" -ForegroundColor Gray
    }
}

# Affichage de l'aide
function Show-Help {
    Write-Host @"
🚀 SCRIPT UNIFIÉ DE DÉPLOIEMENT - roo-state-manager
=================================================

UTILISATION:
    .\roo-deploy.ps1 [PARAMÈTRES]

PARAMÈTRES:
    -Install        Installe les dépendances npm
    -Build          Compile le projet TypeScript
    -Test           Lance les tests de validation
    -Configure      Configure le serveur MCP
    -Deploy         Installation complète (install + build + test)
    -SkipPrereqs    Saute la vérification des prérequis
    -Verbose        Active le logging verbeux
    -Config         Fichier de configuration (défaut: config/deploy-config.json)
    -Help           Affiche cette aide

EXEMPLES:
    .\roo-deploy.ps1 -Deploy                    # Installation complète
    .\roo-deploy.ps1 -Install -Build -Test      # Étapes séparées
    .\roo-deploy.ps1 -Test                      # Tests uniquement
    .\roo-deploy.ps1 -Configure                 # Configuration MCP uniquement
"@
}

# Vérification des prérequis
function Test-Prerequisites {
    param([hashtable]$Config)
    
    Write-Host "🔍 VÉRIFICATION DES PRÉREQUIS" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Cyan
    Write-Host ""
    
    $prereqs = $Config.prerequisites
    $allPassed = $true
    
    # Vérification de Node.js
    Write-Host "📦 Node.js" -ForegroundColor Magenta
    try {
        $nodeVersion = node --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Node.js détecté : $nodeVersion"
            Write-Verbose "Version requise : $($prereqs.node.minVersion)"
        } else {
            Write-Error "Node.js n'est pas installé ou non disponible dans le PATH"
            $allPassed = $false
        }
    } catch {
        Write-Error "Node.js n'est pas installé ou non disponible dans le PATH"
        $allPassed = $false
    }
    
    # Vérification de npm
    Write-Host "📦 NPM" -ForegroundColor Magenta
    try {
        $npmVersion = npm --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "npm détecté : $npmVersion"
            Write-Verbose "Version requise : $($prereqs.npm.minVersion)"
        } else {
            Write-Error "npm n'est pas installé ou non disponible dans le PATH"
            $allPassed = $false
        }
    } catch {
        Write-Error "npm n'est pas installé ou non disponible dans le PATH"
        $allPassed = $false
    }
    
    # Vérification de PowerShell
    Write-Host "📦 PowerShell" -ForegroundColor Magenta
    $psVersion = $PSVersionTable.PSVersion
    Write-Success "PowerShell détecté : $psVersion"
    Write-Verbose "Version requise : $($prereqs.powershell.minVersion)"
    
    # Vérification de l'espace disque
    Write-Host "💾 Espace Disque" -ForegroundColor Magenta
    $drive = Get-PSDrive -Name (Get-Location).Drive.Name
    $freeSpaceGB = [math]::Round($drive.Free / 1GB, 2)
    Write-Info "Espace libre : $freeSpaceGB GB"
    
    if ($freeSpaceGB -lt 1) {
        Write-Warning "Espace disque limité, recommandé > 1GB"
    }
    
    Write-Host ""
    if ($allPassed) {
        Write-Success "Tous les prérequis sont satisfaits"
    } else {
        Write-Error "Certains prérequis ne sont pas satisfaits"
    }
    
    return $allPassed
}

# Installation des dépendances
function Install-Dependencies {
    param([hashtable]$Config)
    
    Write-Host "📦 INSTALLATION DES DÉPENDANCES" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Cyan
    Write-Host ""
    
    $installConfig = $Config.steps.install
    
    Write-Info "Commande : $($installConfig.command)"
    Write-Info "Timeout : $($installConfig.timeout)ms"
    Write-Info "Description : $($installConfig.description)"
    Write-Host ""
    
    try {
        $startTime = Get-Date
        Write-Info "Début : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
        
        # Vérifier si package.json existe
        if (-not (Test-Path "package.json")) {
            Write-Error "package.json non trouvé dans le répertoire courant"
            return $false
        }
        
        # Vérifier si node_modules existe déjà
        if (Test-Path "node_modules") {
            Write-Warning "node_modules existe déjà, suppression en cours..."
            Remove-Item -Path "node_modules" -Recurse -Force
            Write-Success "node_modules supprimé"
        }
        
        # Vérifier si package-lock.json existe
        if (Test-Path "package-lock.json") {
            Write-Info "package-lock.json trouvé, utilisation pour installation cohérente"
        }
        
        # Exécution de npm install
        Write-Host "🔄 Installation en cours..." -ForegroundColor Yellow
        $installOutput = Invoke-Expression $installConfig.command 2>&1
        $exitCode = $LASTEXITCODE
        
        $endTime = Get-Date
        $duration = $endTime - $startTime
        
        Write-Host ""
        Write-Host "📊 RÉSULTATS" -ForegroundColor Cyan
        Write-Host "============" -ForegroundColor Cyan
        Write-Host "Durée : $($duration.TotalSeconds) secondes" -ForegroundColor White
        Write-Host "Code de sortie : $exitCode" -ForegroundColor White
        
        if ($Verbose) {
            Write-Host ""
            Write-Host "📄 SORTIE DÉTAILLÉE" -ForegroundColor Gray
            Write-Host "====================" -ForegroundColor Gray
            Write-Host $installOutput
        }
        
        if ($exitCode -eq 0) {
            Write-Success "Dépendances installées avec succès"
            
            # Vérification post-installation
            if (Test-Path "node_modules") {
                $moduleCount = (Get-ChildItem "node_modules" -Directory).Count
                Write-Info "Modules installés : $moduleCount"
            }
            
            return $true
        } else {
            Write-Error "Erreur lors de l'installation des dépendances"
            if ($installOutput -match "npm ERR!") {
                $errorLines = $installOutput -split "`n" | Where-Object { $_ -match "npm ERR!" }
                foreach ($line in $errorLines) {
                    Write-Error $line.Trim()
                }
            }
            return $false
        }
        
    } catch {
        Write-Error "Erreur lors de l'installation : $($_.Exception.Message)"
        return $false
    }
}

# Compilation du projet
function Build-Project {
    param([hashtable]$Config)
    
    Write-Host "🔨 COMPILATION DU PROJET" -ForegroundColor Cyan
    Write-Host "========================" -ForegroundColor Cyan
    Write-Host ""
    
    $buildConfig = $Config.steps.build
    
    Write-Info "Commande : $($buildConfig.command)"
    Write-Info "Timeout : $($buildConfig.timeout)ms"
    Write-Info "Description : $($buildConfig.description)"
    Write-Host ""
    
    try {
        $startTime = Get-Date
        Write-Info "Début : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
        
        # Vérifier si tsconfig.json existe
        if (-not (Test-Path "tsconfig.json")) {
            Write-Error "tsconfig.json non trouvé"
            return $false
        }
        
        # Vérifier les sources TypeScript
        $sourceFiles = Get-ChildItem -Path "src" -Recurse -Include "*.ts" -File -ErrorAction SilentlyContinue
        Write-Info "Fichiers TypeScript trouvés : $($sourceFiles.Count)"
        
        # Exécution de la compilation
        Write-Host "🔄 Compilation en cours..." -ForegroundColor Yellow
        $buildOutput = Invoke-Expression $buildConfig.command 2>&1
        $exitCode = $LASTEXITCODE
        
        $endTime = Get-Date
        $duration = $endTime - $startTime
        
        Write-Host ""
        Write-Host "📊 RÉSULTATS" -ForegroundColor Cyan
        Write-Host "============" -ForegroundColor Cyan
        Write-Host "Durée : $($duration.TotalSeconds) secondes" -ForegroundColor White
        Write-Host "Code de sortie : $exitCode" -ForegroundColor White
        
        if ($Verbose) {
            Write-Host ""
            Write-Host "📄 SORTIE DÉTAILLÉE" -ForegroundColor Gray
            Write-Host "====================" -ForegroundColor Gray
            Write-Host $buildOutput
        }
        
        if ($exitCode -eq 0) {
            Write-Success "Compilation réussie"
            
            # Vérification post-compilation
            if (Test-Path "build") {
                $buildFiles = Get-ChildItem -Path "build" -Recurse -File -ErrorAction SilentlyContinue
                Write-Info "Fichiers compilés : $($buildFiles.Count)"
                
                $mainJs = Join-Path "build" "index.js"
                if (Test-Path $mainJs) {
                    Write-Success "Fichier principal généré : build/index.js"
                }
            }
            
            return $true
        } else {
            Write-Error "Erreur lors de la compilation"
            if ($buildOutput -match "error TS") {
                $errorLines = $buildOutput -split "`n" | Where-Object { $_ -match "error TS" }
                foreach ($line in $errorLines | Select-Object -First 10) {
                    Write-Error $line.Trim()
                }
            }
            return $false
        }
        
    } catch {
        Write-Error "Erreur lors de la compilation : $($_.Exception.Message)"
        return $false
    }
}

# Tests de validation
function Test-Project {
    param([hashtable]$Config)
    
    Write-Host "🧪 TESTS DE VALIDATION" -ForegroundColor Cyan
    Write-Host "========================" -ForegroundColor Cyan
    Write-Host ""
    
    $testConfig = $Config.steps.test
    
    Write-Info "Commande : $($testConfig.command)"
    Write-Info "Timeout : $($testConfig.timeout)ms"
    Write-Info "Description : $($testConfig.description)"
    Write-Host ""
    
    try {
        $startTime = Get-Date
        Write-Info "Début : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
        
        # Vérifier si les tests existent
        $testFiles = Get-ChildItem -Path "tests" -Recurse -Include "*.test.ts" -File -ErrorAction SilentlyContinue
        Write-Info "Fichiers de test trouvés : $($testFiles.Count)"
        
        # Exécution des tests
        Write-Host "🔄 Tests en cours..." -ForegroundColor Yellow
        $testOutput = Invoke-Expression $testConfig.command 2>&1
        $exitCode = $LASTEXITCODE
        
        $endTime = Get-Date
        $duration = $endTime - $startTime
        
        Write-Host ""
        Write-Host "📊 RÉSULTATS" -ForegroundColor Cyan
        Write-Host "============" -ForegroundColor Cyan
        Write-Host "Durée : $($duration.TotalSeconds) secondes" -ForegroundColor White
        Write-Host "Code de sortie : $exitCode" -ForegroundColor White
        
        # Analyse des résultats
        if ($testOutput -match "(\d+) passing") {
            Write-Success "Tests passants : $($matches[1])"
        }
        
        if ($testOutput -match "(\d+) failing") {
            Write-Error "Tests échouants : $($matches[1])"
        } else {
            Write-Success "Aucun échec détecté"
        }
        
        if ($Verbose) {
            Write-Host ""
            Write-Host "📄 SORTIE DÉTAILLÉE" -ForegroundColor Gray
            Write-Host "====================" -ForegroundColor Gray
            Write-Host $testOutput
        }
        
        return $exitCode -eq 0
        
    } catch {
        Write-Error "Erreur lors des tests : $($_.Exception.Message)"
        return $false
    }
}

# Configuration MCP
function Configure-MCP {
    Write-Host "⚙️ CONFIGURATION MCP" -ForegroundColor Cyan
    Write-Host "===================" -ForegroundColor Cyan
    Write-Host ""
    
    Write-Info "Génération de la configuration MCP..."
    Write-Host ""
    
    $serverPath = Join-Path $ProjectRoot "build\index.js"
    $serverPath = $serverPath.Replace('\', '\\')
    
    $mcpConfig = @{
        "mcpServers" = @{
            "roo-state-manager" = @{
                "command" = "node"
                "args" = @($serverPath)
            }
        }
    }
    
    Write-Host "📋 CONFIGURATION MCP GÉNÉRÉE" -ForegroundColor Green
    Write-Host "=============================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Ajoutez ce bloc à votre fichier de configuration MCP :" -ForegroundColor Yellow
    Write-Host ""
    Write-Host ($mcpConfig | ConvertTo-Json -Depth 10) -ForegroundColor White
    Write-Host ""
    Write-Info "Chemin du serveur : $serverPath"
    Write-Info "Pour appliquer cette configuration, modifiez votre fichier mcp_settings.json"
}

# Point d'entrée principal
function Main {
    Write-Host "🚀 SCRIPT UNIFIÉ DE DÉPLOIEMENT - roo-state-manager" -ForegroundColor Cyan
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host ""
    
    if ($Help) {
        Show-Help
        return
    }
    
    # Charger la configuration
    $config = Load-Config -ConfigPath $Config
    if (-not $config) {
        Write-Error "Impossible de charger la configuration. Utilisation des valeurs par défaut."
        # Configuration par défaut minimale
        $config = @{
            prerequisites = @{
                node = @{ minVersion = "18.0.0"; required = $true }
                npm = @{ minVersion = "8.0.0"; required = $true }
                powershell = @{ minVersion = "5.1"; required = $true }
            }
            steps = @{
                install = @{ command = "npm install"; description = "Installation des dépendances"; timeout = 300000 }
                build = @{ command = "npm run build"; description = "Compilation TypeScript"; timeout = 120000 }
                test = @{ command = "npm run test:detector"; description = "Tests de validation"; timeout = 180000 }
                configure = @{ command = "node scripts/configure-mcp.js"; description = "Configuration MCP"; timeout = 60000 }
            }
            output = @{
                logFile = "deploy-execution.log"
                backupConfig = $true
                showProgress = $true
            }
        }
    }
    
    Write-Info "Répertoire du projet : $ProjectRoot"
    Write-Info "Configuration chargée : $Config"
    Write-Host ""
    
    # Configuration du logging
    if ($config.output.logFile) {
        $logFile = Join-Path $ProjectRoot $config.output.logFile
        Start-Transcript -Path $logFile -Append
        Write-Verbose "Logging activé vers : $logFile"
    }
    
    try {
        # Vérification des prérequis
        if (-not $SkipPrereqs) {
            if (-not (Test-Prerequisites -Config $config)) {
                Write-Error "Prérequis non satisfaits. Arrêt du déploiement."
                exit 1
            }
        } else {
            Write-Warning "Vérification des prérequis ignorée"
        }
        
        Write-Host ""
        
        # Mode déploiement complet
        if ($Deploy) {
            $Install = $true
            $Build = $true
            $Test = $true
            Write-Info "Mode déploiement complet activé"
        }
        
        # Si aucune option spécifiée, afficher l'aide
        if (-not ($Install -or $Build -or $Test -or $Configure)) {
            Write-Warning "Aucune action spécifiée. Affichage de l'aide."
            Show-Help
            return
        }
        
        $success = $true
        
        # Installation des dépendances
        if ($Install) {
            if (-not (Install-Dependencies -Config $config)) {
                $success = $false
            }
        }
        
        # Compilation
        if ($Build -and $success) {
            if (-not (Build-Project -Config $config)) {
                $success = $false
            }
        }
        
        # Tests
        if ($Test -and $success) {
            if (-not (Test-Project -Config $config)) {
                $success = $false
            }
        }
        
        # Configuration MCP
        if ($Configure) {
            Configure-MCP
        }
        
        # Résumé final
        Write-Host ""
        Write-Host "📋 RÉSUMÉ DU DÉPLOIEMENT" -ForegroundColor Cyan
        Write-Host "=========================" -ForegroundColor Cyan
        
        if ($success) {
            Write-Success "Déploiement terminé avec succès!"
            Write-Info "Le serveur MCP Roo State Manager est prêt à être utilisé."
            Write-Info "Chemin du serveur : $(Join-Path $ProjectRoot 'build\index.js')"
        } else {
            Write-Error "Le déploiement a échoué. Vérifiez les erreurs ci-dessus."
            exit 1
        }
        
    } finally {
        # Arrêter le logging
        if ($config.output.logFile) {
            Stop-Transcript
            Write-Info "Log sauvegardé dans : $($config.output.logFile)"
        }
    }
}

# Exécution principale
Main