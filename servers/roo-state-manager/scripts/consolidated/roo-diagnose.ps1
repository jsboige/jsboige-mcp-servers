#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Script UNIFIÉ de diagnostic pour roo-state-manager
    Remplace : diagnose-skeleton-cache.ps1, diagnose-skeleton-cache.mjs, audit-tests.ps1, diagnose-tests-with-logging.ps1

.DESCRIPTION
    Script paramétrable pour diagnostiquer le cache skeleton, auditer les tests, valider l'environnement
    et analyser l'état du système. Supporte multiple types de diagnostic avec rapports détaillés.

.PARAMETER Type
    Type de diagnostic : cache, tests, environment, system, all (défaut: all)

.PARAMETER Output
    Format de sortie : console, json, markdown, all (défaut: console)

.PARAMETER Detailed
    Active le mode détaillé avec informations supplémentaires

.PARAMETER Verbose
    Active le logging verbeux

.PARAMETER Config
    Chemin vers le fichier de configuration (défaut: config/diagnostic-config.json)

.PARAMETER Help
    Affiche l'aide détaillée

.EXAMPLE
    .\roo-diagnose.ps1
    Diagnostic complet du système

.EXAMPLE
    .\roo-diagnose.ps1 -Type cache -Detailed
    Diagnostic détaillé du cache skeleton

.EXAMPLE
    .\roo-diagnose.ps1 -Type tests -Output markdown
    Audit des tests avec rapport markdown

.EXAMPLE
    .\roo-diagnose.ps1 -Type environment -Verbose
    Validation complète de l'environnement
#>

param(
    [ValidateSet("cache", "tests", "environment", "system", "all")]
    [string]$Type = "all",
    
    [ValidateSet("console", "json", "markdown", "all")]
    [string]$Output = "console",
    
    [switch]$Detailed,
    [switch]$Verbose,
    [string]$Config = "config/diagnostic-config.json",
    [switch]$Help
)

# Configuration
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
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
🔍 SCRIPT UNIFIÉ DE DIAGNOSTIC - roo-state-manager
================================================

UTILISATION:
    .\roo-diagnose.ps1 [PARAMÈTRES]

PARAMÈTRES:
    -Type           Type de diagnostic (cache|tests|environment|system|all)
    -Output         Format de sortie (console|json|markdown|all)
    -Detailed       Active le mode détaillé
    -Verbose        Active le logging verbeux
    -Config         Fichier de configuration (défaut: config/diagnostic-config.json)
    -Help           Affiche cette aide

EXEMPLES:
    .\roo-diagnose.ps1                           # Diagnostic complet
    .\roo-diagnose.ps1 -Type cache -Detailed    # Cache détaillé
    .\roo-diagnose.ps1 -Type tests -Output markdown # Tests avec rapport
    .\roo-diagnose.ps1 -Type environment          # Environnement
    .\roo-diagnose.ps1 -Type system               # Système complet
"@
}

# Diagnostic du cache skeleton
function Invoke-CacheDiagnostic {
    Write-Host "📊 DIAGNOSTIC CACHE SKELETON" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Cyan
    Write-Host ""
    
    $cachePath = Join-Path $ProjectRoot ".roo-state-manager/skeleton-cache.json"
    
    Write-Info "Chemin du cache : $cachePath"
    
    if (-not (Test-Path $cachePath)) {
        Write-Error "Cache skeleton manquant!"
        Write-Info "→ Exécuter : .\roo-cache.ps1 -Build"
        return @{
            Success = $false
            Error = "Cache manquant"
            Recommendation = "Exécuter .\roo-cache.ps1 -Build"
        }
    }
    
    try {
        # Taille et métadonnées du fichier
        $cacheFile = Get-Item $cachePath
        $sizeMB = [math]::Round($cacheFile.Length / 1MB, 2)
        $sizeKB = [math]::Round($cacheFile.Length / 1KB, 0)
        
        Write-Success "Cache trouvé"
        Write-Info "Taille : $sizeMB MB ($sizeKB KB)"
        Write-Info "Modifié : $($cacheFile.LastWriteTime)"
        
        # Analyse du contenu
        Write-Host ""
        Write-Info "Analyse du contenu..."
        
        $content = Get-Content $cachePath -Raw | ConvertFrom-Json
        $taskIds = $content | Get-Member -Type NoteProperty | Select-Object -ExpandProperty Name
        $taskCount = $taskIds.Count
        
        Write-Host "📈 STATISTIQUES GÉNÉRALES" -ForegroundColor Green
        Write-Info "Total tâches : $taskCount"
        
        if ($taskCount -eq 0) {
            Write-Error "Cache vide!"
            return @{
                Success = $false
                Error = "Cache vide"
                Recommendation = "Reconstruire le cache avec .\roo-cache.ps1 -Build"
            }
        }
        
        # Analyse des workspaces
        $workspaces = @{}
        $hierarchyStats = @{
            withChildren = 0
            withParents = 0
            orphans = 0
            roots = 0
        }
        
        foreach ($taskId in $taskIds) {
            $task = $content.$taskId
            
            # Comptage workspace
            $ws = $task.workspace
            if (-not $ws) { $ws = "UNKNOWN" }
            if (-not $workspaces.ContainsKey($ws)) {
                $workspaces[$ws] = 0
            }
            $workspaces[$ws]++
            
            # Stats hiérarchie
            $childCount = 0
            if ($task.childTaskInstructionPrefixes) {
                $childCount = $task.childTaskInstructionPrefixes.Count
            }
            
            if ($childCount -gt 0) {
                $hierarchyStats.withChildren++
            }
            
            if ($task.parentTaskId) {
                $hierarchyStats.withParents++
            } elseif ($childCount -eq 0) {
                $hierarchyStats.orphans++
            } else {
                $hierarchyStats.roots++
            }
        }
        
        Write-Host ""
        Write-Host "🏢 WORKSPACES ($($workspaces.Count))" -ForegroundColor Green
        $sortedWorkspaces = $workspaces.GetEnumerator() | Sort-Object Value -Descending
        $topWorkspaces = $sortedWorkspaces | Select-Object -First 10
        
        foreach ($ws in $topWorkspaces) {
            $percent = [math]::Round(($ws.Value / $taskCount) * 100, 1)
            Write-Info "$($ws.Name) : $($ws.Value) tâches ($percent%)"
        }
        
        if ($workspaces.Count -gt 10) {
            $remaining = $workspaces.Count - 10
            Write-Info "... et $remaining autres workspaces"
        }
        
        Write-Host ""
        Write-Host "🔗 HIÉRARCHIE" -ForegroundColor Green
        $hierarchyRate = [math]::Round(($hierarchyStats.withChildren / $taskCount) * 100, 1)
        $parentRate = [math]::Round(($hierarchyStats.withParents / $taskCount) * 100, 1)
        $rootRate = [math]::Round(($hierarchyStats.roots / $taskCount) * 100, 1)
        $orphanRate = [math]::Round(($hierarchyStats.orphans / $taskCount) * 100, 1)
        
        Write-Info "Avec enfants : $($hierarchyStats.withChildren) ($hierarchyRate%)"
        Write-Info "Avec parents : $($hierarchyStats.withParents) ($parentRate%)"
        Write-Info "Racines : $($hierarchyStats.roots) ($rootRate%)"
        Write-Info "Orphelines : $($hierarchyStats.orphans) ($orphanRate%)"
        
        # Évaluation système
        Write-Host ""
        Write-Host "📊 ÉVALUATION SYSTÈME" -ForegroundColor Yellow
        $quality = "EXCELLENT"
        $recommendation = "Système hiérarchique très performant"
        
        if ($hierarchyRate -lt 30) {
            $quality = "FAIBLE"
            $recommendation = "Investigation requise"
        } elseif ($hierarchyRate -lt 50) {
            $quality = "MOYEN"
            $recommendation = "Amélioration possible"
        } elseif ($hierarchyRate -lt 70) {
            $quality = "BON"
            $recommendation = "Performance satisfaisante"
        }
        
        Write-Success "$quality - $recommendation"
        
        # Échantillons si mode détaillé
        if ($Detailed -and $taskCount -gt 0) {
            Write-Host ""
            Write-Host "🔍 ÉCHANTILLON TÂCHES (Top 5)" -ForegroundColor Yellow
            
            $sampleTasks = $taskIds | Select-Object -First 5
            foreach ($taskId in $sampleTasks) {
                $task = $content.$taskId
                $shortId = $taskId.Substring(0, 8)
                $instruction = $task.instruction
                if ($instruction -and $instruction.Length -gt 80) {
                    $instruction = $instruction.Substring(0, 77) + "..."
                }
                $childCount = if ($task.childTaskInstructionPrefixes) { $task.childTaskInstructionPrefixes.Count } else { 0 }
                
                Write-Info "$shortId ($($task.workspace)): $childCount enfants"
                if ($instruction) {
                    Write-Verbose "→ $instruction"
                }
            }
        }
        
        return @{
            Success = $true
            TaskCount = $taskCount
            WorkspaceCount = $workspaces.Count
            HierarchyRate = $hierarchyRate
            Quality = $quality
            Recommendation = $recommendation
            CacheFile = $cachePath
            CacheSize = $sizeMB
        }
        
    } catch {
        Write-Error "Erreur lors de l'analyse du cache : $($_.Exception.Message)"
        return @{
            Success = $false
            Error = $_.Exception.Message
            Recommendation = "Vérifier le format du fichier de cache"
        }
    }
}

# Diagnostic des tests
function Invoke-TestsDiagnostic {
    Write-Host "🧪 DIAGNOSTIC DES TESTS" -ForegroundColor Cyan
    Write-Host "=========================" -ForegroundColor Cyan
    Write-Host ""
    
    # Collecter tous les fichiers de tests
    $testFiles = @()
    $testFiles += Get-ChildItem -Path "tests" -Recurse -Include "*.test.ts","*.test.js","*.test.d.ts" -File -ErrorAction SilentlyContinue
    $testFiles += Get-ChildItem -Path "src" -Recurse -Include "*.test.ts","*.test.js" -File -ErrorAction SilentlyContinue
    $testFiles += Get-ChildItem -Path "src" -Recurse -Include "test-*.ts","test-*.js","*-test.ts","*-test.js" -File -ErrorAction SilentlyContinue
    
    Write-Info "Fichiers de test trouvés : $($testFiles.Count)"
    
    if ($testFiles.Count -eq 0) {
        Write-Warning "Aucun fichier de test trouvé"
        return @{
            Success = $false
            Error = "Aucun test trouvé"
            Recommendation = "Créer des fichiers de test dans tests/"
        }
    }
    
    # Analyser chaque fichier
    $results = @()
    $totalTests = 0
    $totalSuites = 0
    $totalSize = 0
    
    foreach ($file in $testFiles) {
        $relativePath = $file.FullName.Replace($ProjectRoot + "\", "").Replace("\", "/")
        $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
        
        if ($content) {
            $testCount = ([regex]::Matches($content, "(?:it|test)\s*\(")).Count
            $describeCount = ([regex]::Matches($content, "describe\s*\(")).Count
            
            $totalTests += $testCount
            $totalSuites += $describeCount
            $totalSize += $file.Length
            
            $results += [PSCustomObject]@{
                Path = $relativePath
                Size = [math]::Round($file.Length / 1KB, 2)
                Tests = $testCount
                Suites = $describeCount
                Modified = $file.LastWriteTime.ToString("yyyy-MM-dd")
                Directory = Split-Path $relativePath -Parent
            }
        }
    }
    
    Write-Host "📊 STATISTIQUES GLOBALES" -ForegroundColor Green
    Write-Info "Fichiers de tests totaux : $($results.Count)"
    Write-Info "Tests individuels : $totalTests"
    Write-Info "Suites de tests : $totalSuites"
    Write-Info "Taille totale : $([math]::Round($totalSize / 1024, 2)) MB"
    
    # Analyse par répertoire
    Write-Host ""
    Write-Host "📁 RÉPARTITION PAR RÉPERTOIRE" -ForegroundColor Green
    $byDirectory = $results | Group-Object Directory | Sort-Object Name
    
    foreach ($group in $byDirectory) {
        $dirTests = ($group.Group | Measure-Object -Property Tests -Sum).Sum
        $dirSuites = ($group.Group | Measure-Object -Property Suites -Sum).Sum
        $dirSize = [math]::Round(($group.Group | Measure-Object -Property Size -Sum).Sum, 2)
        
        Write-Info "📂 $($group.Name) : $($group.Count) fichiers, $dirTests tests, $dirSize KB"
    }
    
    # Identification des problèmes
    Write-Host ""
    Write-Host "⚠️ FICHIERS NÉCESSITANT ATTENTION" -ForegroundColor Yellow
    
    $emptyFiles = $results | Where-Object { $_.Tests -eq 0 }
    if ($emptyFiles.Count -gt 0) {
        Write-Warning "Fichiers vides ou sans tests : $($emptyFiles.Count)"
        foreach ($file in $emptyFiles | Select-Object -First 5) {
            Write-Verbose "  - $($file.Path)"
        }
    }
    
    $oldFiles = $results | Where-Object { 
        $daysSinceModified = (Get-Date) - [DateTime]::Parse($_.Modified)
        $daysSinceModified.TotalDays -gt 90
    }
    if ($oldFiles.Count -gt 0) {
        Write-Warning "Fichiers anciens (>90 jours) : $($oldFiles.Count)"
        foreach ($file in $oldFiles | Select-Object -First 3) {
            Write-Verbose "  - $($file.Path) (modifié : $($file.Modified))"
        }
    }
    
    return @{
        Success = $true
        TotalFiles = $results.Count
        TotalTests = $totalTests
        TotalSuites = $totalSuites
        TotalSize = $totalSize
        EmptyFiles = $emptyFiles.Count
        OldFiles = $oldFiles.Count
    }
}

# Diagnostic de l'environnement
function Invoke-EnvironmentDiagnostic {
    Write-Host "🌍 DIAGNOSTIC ENVIRONNEMENT" -ForegroundColor Cyan
    Write-Host "=============================" -ForegroundColor Cyan
    Write-Host ""
    
    $envInfo = @{}
    
    # Système d'exploitation
    Write-Host "💻 SYSTÈME D'EXPLOITATION" -ForegroundColor Magenta
    $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem
    Write-Info "OS : $($osInfo.Caption) $($osInfo.Version)"
    Write-Info "Architecture : $($osInfo.OSArchitecture)"
    Write-Info "Service Pack : $($osInfo.ServicePackMajorVersion).$($osInfo.ServicePackMinorVersion)"
    
    $envInfo.OS = @{
        Name = $osInfo.Caption
        Version = $osInfo.Version
        Architecture = $osInfo.OSArchitecture
    }
    
    # Matériel
    Write-Host ""
    Write-Host "🖥️ MATÉRIEL" -ForegroundColor Magenta
    $cpuInfo = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
    $memoryInfo = Get-CimInstance -ClassName Win32_ComputerSystem
    $diskInfo = Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.DeviceID -eq "C:" }
    
    Write-Info "CPU : $($cpuInfo.Name)"
    Write-Info "Cœurs : $($cpuInfo.NumberOfCores)"
    Write-Info "RAM totale : $([math]::Round($memoryInfo.TotalPhysicalMemory / 1GB, 2)) GB"
    Write-Info "Espace disque (C:) : $([math]::Round($diskInfo.FreeSpace / 1GB, 2)) GB libre / $([math]::Round($diskInfo.Size / 1GB, 2)) GB total"
    
    $envInfo.Hardware = @{
        CPU = $cpuInfo.Name
        Cores = $cpuInfo.NumberOfCores
        RAM = [math]::Round($memoryInfo.TotalPhysicalMemory / 1GB, 2)
        DiskFree = [math]::Round($diskInfo.FreeSpace / 1GB, 2)
        DiskTotal = [math]::Round($diskInfo.Size / 1GB, 2)
    }
    
    # Logiciels
    Write-Host ""
    Write-Host "🔧 LOGICIELS" -ForegroundColor Magenta
    Write-Info "PowerShell : $($PSVersionTable.PSVersion)"
    
    try {
        $nodeVersion = node --version 2>$null
        Write-Info "Node.js : $nodeVersion"
        $envInfo.NodeJS = $nodeVersion
    } catch {
        Write-Warning "Node.js non détecté"
        $envInfo.NodeJS = "Non installé"
    }
    
    try {
        $npmVersion = npm --version 2>$null
        Write-Info "NPM : $npmVersion"
        $envInfo.NPM = $npmVersion
    } catch {
        Write-Warning "NPM non détecté"
        $envInfo.NPM = "Non installé"
    }
    
    try {
        $gitVersion = git --version 2>$null
        Write-Info "Git : $gitVersion"
        $envInfo.Git = $gitVersion
    } catch {
        Write-Warning "Git non détecté"
        $envInfo.Git = "Non installé"
    }
    
    # Variables d'environnement
    Write-Host ""
    Write-Host "🌍 VARIABLES D'ENVIRONNEMENT" -ForegroundColor Magenta
    $envVars = @("PATH", "NODE_ENV", "USERPROFILE", "TEMP", "TMP")
    foreach ($var in $envVars) {
        $value = [Environment]::GetEnvironmentVariable($var)
        if ($value) {
            if ($var -eq "PATH") {
                $pathCount = ($value -split ';').Count
                Write-Info "$var : $pathCount entrées"
            } else {
                Write-Info "$var : $value"
            }
            $envInfo.Variables[$var] = $value
        }
    }
    
    return @{
        Success = $true
        Environment = $envInfo
    }
}

# Diagnostic système complet
function Invoke-SystemDiagnostic {
    Write-Host "🖥️ DIAGNOSTIC SYSTÈME COMPLET" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Cyan
    Write-Host ""
    
    $results = @{}
    
    # Diagnostic du cache
    $cacheResult = Invoke-CacheDiagnostic
    $results.Cache = $cacheResult
    
    Write-Host ""
    
    # Diagnostic des tests
    $testsResult = Invoke-TestsDiagnostic
    $results.Tests = $testsResult
    
    Write-Host ""
    
    # Diagnostic de l'environnement
    $envResult = Invoke-EnvironmentDiagnostic
    $results.Environment = $envResult
    
    # Évaluation globale
    Write-Host ""
    Write-Host "📊 ÉVALUATION GLOBALE" -ForegroundColor Green
    Write-Host "========================" -ForegroundColor Green
    
    $globalScore = 0
    $maxScore = 3
    
    if ($cacheResult.Success) { $globalScore++ }
    if ($testsResult.Success) { $globalScore++ }
    if ($envResult.Success) { $globalScore++ }
    
    $scorePercent = [math]::Round(($globalScore / $maxScore) * 100, 0)
    
    Write-Info "Score global : $globalScore/$maxScore ($scorePercent%)"
    
    if ($scorePercent -eq 100) {
        Write-Success "SYSTÈME EXCELLENT - Tous les composants fonctionnels"
    } elseif ($scorePercent -ge 67) {
        Write-Success "SYSTÈME BON - Quelques améliorations possibles"
    } elseif ($scorePercent -ge 33) {
        Write-Warning "SYSTÈME MOYEN - Actions correctives requises"
    } else {
        Write-Error "SYSTÈME CRITIQUE - Intervention urgente requise"
    }
    
    return @{
        Success = $scorePercent -ge 67
        GlobalScore = $globalScore
        MaxScore = $maxScore
        ScorePercent = $scorePercent
        Components = $results
    }
}

# Point d'entrée principal
function Main {
    Write-Host "🔍 SCRIPT UNIFIÉ DE DIAGNOSTIC - roo-state-manager" -ForegroundColor Cyan
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host ""
    
    if ($Help) {
        Show-Help
        return
    }
    
    # Charger la configuration
    $config = Load-Config -ConfigPath $Config
    if (-not $config) {
        Write-Warning "Configuration non trouvée, utilisation des valeurs par défaut"
        $config = @{
            output = @{
                formats = @("console")
                directory = "./diagnostic-results"
                filename = "diagnostic-{timestamp}"
            }
        }
    }
    
    Write-Info "Répertoire du projet : $ProjectRoot"
    Write-Info "Type de diagnostic : $Type"
    Write-Info "Format de sortie : $Output"
    Write-Host ""
    
    # Préparation de la sortie
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $outputFile = $config.output.directory + "/" + ($config.output.filename -replace '\{timestamp\}', $timestamp)
    
    # Créer le répertoire de sortie si nécessaire
    $outputDir = Split-Path $outputFile -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    
    # Exécution du diagnostic
    $result = $null
    
    switch ($Type) {
        "cache" {
            $result = Invoke-CacheDiagnostic
        }
        "tests" {
            $result = Invoke-TestsDiagnostic
        }
        "environment" {
            $result = Invoke-EnvironmentDiagnostic
        }
        "system" {
            $result = Invoke-SystemDiagnostic
        }
        "all" {
            $result = Invoke-SystemDiagnostic
        }
        default {
            Write-Error "Type de diagnostic non reconnu : $Type"
            return
        }
    }
    
    # Génération de la sortie
    if ($result -and ($Output -eq "json" -or $Output -eq "all")) {
        $jsonOutput = $outputFile + ".json"
        $result | ConvertTo-Json -Depth 10 | Out-File -FilePath $jsonOutput -Encoding UTF8 -Force
        Write-Info "Résultat JSON sauvegardé : $jsonOutput"
    }
    
    if ($result -and ($Output -eq "markdown" -or $Output -eq "all")) {
        $markdownOutput = $outputFile + ".md"
        $markdown = @"
# Rapport de Diagnostic

**Type** : $Type  
**Timestamp** : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  
**Succès** : $(if ($result.Success) { 'Oui' } else { 'Non' })

## Résultats

```
$($result | ConvertTo-Json -Depth 5)
```

---

*Généré par roo-diagnose.ps1*
"@
        $markdown | Out-File -FilePath $markdownOutput -Encoding UTF8 -Force
        Write-Info "Rapport Markdown sauvegardé : $markdownOutput"
    }
    
    Write-Host ""
    if ($result.Success) {
        Write-Success "Diagnostic terminé avec succès"
    } else {
        Write-Error "Diagnostic a échoué"
        if ($result.Recommendation) {
            Write-Info "Recommandation : $($result.Recommendation)"
        }
        exit 1
    }
}

# Exécution principale
Main