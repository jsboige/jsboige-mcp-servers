#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Script UNIFIÉ de gestion du cache pour roo-state-manager
    Remplace : build-cache-direct.mjs, test-build-skeleton-cache-direct.ps1, diagnose-skeleton-cache.ps1

.DESCRIPTION
    Script paramétrable pour construire, valider, diagnostiquer et nettoyer le cache skeleton.
    Supporte multiple modes de construction avec validation et rapports détaillés.

.PARAMETER Action
    Action à effectuer : Build, Validate, Clean, Diagnose, Status (défaut: Status)

.PARAMETER Force
    Force la reconstruction complète du cache

.PARAMETER Verbose
    Active le logging verbeux

.PARAMETER Output
    Format de sortie : console, json, markdown, all (défaut: console)

.PARAMETER Config
    Chemin vers le fichier de configuration (défaut: config/cache-config.json)

.PARAMETER Help
    Affiche l'aide détaillée

.EXAMPLE
    .\roo-cache.ps1 -Build
    Construit le cache skeleton

.EXAMPLE
    .\roo-cache.ps1 -Validate -Verbose
    Valide le cache existant en mode verbeux

.EXAMPLE
    .\roo-cache.ps1 -Diagnose -Output markdown
    Diagnostic complet avec rapport markdown

.EXAMPLE
    .\roo-cache.ps1 -Clean -Force
    Nettoie complètement le cache
#>

param(
    [ValidateSet("Build", "Validate", "Clean", "Diagnose", "Status")]
    [string]$Action = "Status",
    
    [switch]$Force,
    [switch]$Verbose,
    [ValidateSet("console", "json", "markdown", "all")]
    [string]$Output = "console",
    [string]$Config = "config/cache-config.json",
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
💾 SCRIPT UNIFIÉ DE GESTION CACHE - roo-state-manager
====================================================

UTILISATION:
    .\roo-cache.ps1 [PARAMÈTRES]

PARAMÈTRES:
    -Action         Action à effectuer (Build|Validate|Clean|Diagnose|Status)
    -Force          Force la reconstruction complète
    -Verbose        Active le logging verbeux
    -Output         Format de sortie (console|json|markdown|all)
    -Config         Fichier de configuration (défaut: config/cache-config.json)
    -Help           Affiche cette aide

ACTIONS:
    Build           Construit le cache skeleton
    Validate        Valide le cache existant
    Clean           Nettoie le cache
    Diagnose        Diagnostic complet du cache
    Status          Affiche le statut actuel

EXEMPLES:
    .\roo-cache.ps1 -Build                    # Construire le cache
    .\roo-cache.ps1 -Validate -Verbose         # Valider en mode verbeux
    .\roo-cache.ps1 -Diagnose -Output markdown # Diagnostic avec rapport
    .\roo-cache.ps1 -Clean -Force              # Nettoyer complètement
    .\roo-cache.ps1 -Status                   # Afficher le statut
"@
}

# Construction du cache
function Invoke-CacheBuild {
    param([hashtable]$Config)
    
    Write-Host "🚀 CONSTRUCTION DU CACHE SKELETON" -ForegroundColor Cyan
    Write-Host "===================================" -ForegroundColor Cyan
    Write-Host ""
    
    $cacheDir = Join-Path $ProjectRoot ".roo-state-manager"
    $cacheFile = Join-Path $cacheDir "skeleton-cache.json"
    
    Write-Info "Répertoire du cache : $cacheDir"
    Write-Info "Fichier du cache : $cacheFile"
    
    # Créer le répertoire si nécessaire
    if (-not (Test-Path $cacheDir)) {
        New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
        Write-Info "Répertoire du cache créé"
    }
    
    # Vérifier si le cache existe et si on ne force pas
    if ((Test-Path $cacheFile) -and (-not $Force)) {
        $cacheFile = Get-Item $cacheFile
        $ageHours = (Get-Date) - $cacheFile.LastWriteTime | Select-Object TotalHours
        Write-Warning "Cache existant détecté (âge : $($ageHours.TotalHours) heures)"
        Write-Info "Utilisez -Force pour reconstruire complètement"
        return @{
            Success = $false
            Action = "Skipped"
            Reason = "Cache exists, use -Force to rebuild"
            CacheFile = $cacheFile
        }
    }
    
    try {
        $startTime = Get-Date
        Write-Info "Début de la construction : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
        
        # Utiliser l'outil MCP pour construire le cache
        Write-Host "🔄 Construction en cours..." -ForegroundColor Yellow
        
        # Préparation de la commande
        $buildCommand = "node build/index.js build_skeleton_cache"
        if ($Force) {
            $buildCommand += " --force_rebuild true"
        }
        
        Write-Verbose "Commande : $buildCommand"
        
        # Exécution avec capture
        $buildOutput = Invoke-Expression $buildCommand 2>&1
        $exitCode = $LASTEXITCODE
        
        $endTime = Get-Date
        $duration = $endTime - $startTime
        
        Write-Host ""
        Write-Host "📊 RÉSULTATS DE LA CONSTRUCTION" -ForegroundColor Cyan
        Write-Host "=================================" -ForegroundColor Cyan
        Write-Host "Durée : $($duration.TotalSeconds) secondes" -ForegroundColor White
        Write-Host "Code de sortie : $exitCode" -ForegroundColor White
        
        # Analyse de la sortie
        if ($buildOutput -match "Built=") {
            if ($buildOutput -match "Built=(\d+)") {
                Write-Success "Tâches construites : $($matches[1])"
            }
        }
        
        if ($buildOutput -match "Skipped=") {
            if ($buildOutput -match "Skipped=(\d+)") {
                Write-Info "Tâches ignorées : $($matches[1])"
            }
        }
        
        if ($Verbose) {
            Write-Host ""
            Write-Host "📄 SORTIE COMPLÈTE" -ForegroundColor Gray
            Write-Host "===================" -ForegroundColor Gray
            Write-Host $buildOutput
        }
        
        # Validation post-construction
        if (Test-Path $cacheFile) {
            $newCacheFile = Get-Item $cacheFile
            $sizeMB = [math]::Round($newCacheFile.Length / 1MB, 2)
            $sizeKB = [math]::Round($newCacheFile.Length / 1KB, 0)
            
            Write-Success "Cache construit avec succès"
            Write-Info "Taille : $sizeMB MB ($sizeKB KB)"
            Write-Info "Modifié : $($newCacheFile.LastWriteTime)"
            
            # Validation rapide du contenu
            try {
                $content = Get-Content $cacheFile -Raw | ConvertFrom-Json
                $taskCount = ($content | Get-Member -Type NoteProperty).Count
                
                Write-Info "Tâches dans le cache : $taskCount"
                
                return @{
                    Success = $true
                    Action = "Built"
                    TaskCount = $taskCount
                    CacheSize = $sizeMB
                    Duration = $duration.TotalSeconds
                    CacheFile = $cacheFile
                }
            } catch {
                Write-Warning "Cache créé mais format invalide"
                return @{
                    Success = $false
                    Action = "BuiltInvalid"
                    Reason = "Invalid cache format"
                    CacheFile = $cacheFile
                }
            }
        } else {
            Write-Error "Le cache n'a pas été créé"
            return @{
                Success = $false
                Action = "Failed"
                Reason = "Cache file not created"
                ExitCode = $exitCode
            }
        }
        
    } catch {
        Write-Error "Erreur lors de la construction du cache : $($_.Exception.Message)"
        return @{
            Success = $false
            Action = "Error"
            Reason = $_.Exception.Message
        }
    }
}

# Validation du cache
function Invoke-CacheValidate {
    Write-Host "🔍 VALIDATION DU CACHE SKELETON" -ForegroundColor Cyan
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host ""
    
    $cacheFile = Join-Path $ProjectRoot ".roo-state-manager/skeleton-cache.json"
    
    Write-Info "Fichier du cache : $cacheFile"
    
    if (-not (Test-Path $cacheFile)) {
        Write-Error "Cache skeleton manquant!"
        Write-Info "→ Exécuter : .\roo-cache.ps1 -Build"
        return @{
            Success = $false
            Valid = $false
            Reason = "Cache file missing"
            Recommendation = "Run .\roo-cache.ps1 -Build"
        }
    }
    
    try {
        # Taille et métadonnées du fichier
        $cacheFileObj = Get-Item $cacheFile
        $sizeMB = [math]::Round($cacheFileObj.Length / 1MB, 2)
        $sizeKB = [math]::Round($cacheFileObj.Length / 1KB, 0)
        
        Write-Success "Cache trouvé"
        Write-Info "Taille : $sizeMB MB ($sizeKB KB)"
        Write-Info "Modifié : $($cacheFileObj.LastWriteTime)"
        
        # Validation du contenu JSON
        Write-Host ""
        Write-Info "Validation du format JSON..."
        
        $content = Get-Content $cacheFile -Raw | ConvertFrom-Json
        $taskIds = $content | Get-Member -Type NoteProperty | Select-Object -ExpandProperty Name
        $taskCount = $taskIds.Count
        
        Write-Success "Format JSON valide"
        Write-Info "Tâches trouvées : $taskCount"
        
        if ($taskCount -eq 0) {
            Write-Warning "Cache vide!"
            return @{
                Success = $true
                Valid = $false
                TaskCount = 0
                Reason = "Empty cache"
                Recommendation = "Run .\roo-cache.ps1 -Build"
            }
        }
        
        # Validation structurelle
        Write-Host ""
        Write-Info "Validation de la structure..."
        
        $validTasks = 0
        $invalidTasks = 0
        $sampleSize = [math]::Min(100, $taskCount)
        
        foreach ($taskId in $taskIds | Select-Object -First $sampleSize) {
            $task = $content.$taskId
            
            # Vérification des champs obligatoires
            $hasInstruction = $task.instruction -and $task.instruction.Trim().Length -gt 0
            $hasWorkspace = $task.workspace -and $task.workspace.Trim().Length -gt 0
            $hasTaskId = $task.taskId -eq $taskId
            
            if ($hasInstruction -and $hasWorkspace -and $hasTaskId) {
                $validTasks++
            } else {
                $invalidTasks++
                if ($Verbose) {
                    Write-Warning "Tâche invalide : $taskId"
                    if (-not $hasInstruction) { Write-Verbose "  → Manque : instruction" }
                    if (-not $hasWorkspace) { Write-Verbose "  → Manque : workspace" }
                    if (-not $hasTaskId) { Write-Verbose "  → Incohérence : taskId" }
                }
            }
        }
        
        $validityRate = [math]::Round(($validTasks / $sampleSize) * 100, 1)
        
        Write-Host "📊 STATISTIQUES DE VALIDATION" -ForegroundColor Green
        Write-Info "Tâches validées : $validTasks/$sampleSize ($validityRate%)"
        Write-Info "Tâches invalides : $invalidTasks/$sampleSize"
        
        # Évaluation de la qualité
        $quality = "EXCELLENT"
        if ($validityRate -lt 90) { $quality = "BON" }
        if ($validityRate -lt 75) { $quality = "MOYEN" }
        if ($validityRate -lt 50) { $quality = "FAIBLE" }
        
        Write-Success "Qualité du cache : $quality"
        
        $isValid = ($invalidTasks -eq 0) -and ($taskCount -gt 0)
        
        return @{
            Success = $true
            Valid = $isValid
            TaskCount = $taskCount
            ValidTasks = $validTasks
            InvalidTasks = $invalidTasks
            ValidityRate = $validityRate
            Quality = $quality
            CacheSize = $sizeMB
            CacheFile = $cacheFile
        }
        
    } catch {
        Write-Error "Erreur lors de la validation du cache : $($_.Exception.Message)"
        return @{
            Success = $false
            Valid = $false
            Reason = $_.Exception.Message
        }
    }
}

# Nettoyage du cache
function Invoke-CacheClean {
    Write-Host "🧹 NETTOYAGE DU CACHE SKELETON" -ForegroundColor Cyan
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host ""
    
    $cacheDir = Join-Path $ProjectRoot ".roo-state-manager"
    $cacheFile = Join-Path $cacheDir "skeleton-cache.json"
    
    Write-Info "Répertoire du cache : $cacheDir"
    
    if (-not (Test-Path $cacheDir)) {
        Write-Info "Répertoire du cache inexistant, rien à nettoyer"
        return @{
            Success = $true
            Action = "NothingToClean"
            Reason = "Cache directory does not exist"
        }
    }
    
    try {
        $filesRemoved = 0
        $totalSize = 0
        
        # Lister les fichiers dans le répertoire du cache
        $cacheFiles = Get-ChildItem -Path $cacheDir -File -ErrorAction SilentlyContinue
        
        if ($cacheFiles.Count -eq 0) {
            Write-Info "Répertoire du cache vide"
            return @{
                Success = $true
                Action = "AlreadyEmpty"
                Reason = "Cache directory is empty"
            }
        }
        
        Write-Host "🔄 Nettoyage en cours..." -ForegroundColor Yellow
        
        foreach ($file in $cacheFiles) {
            $totalSize += $file.Length
            
            if ($Force -or $Verbose) {
                Write-Verbose "Suppression : $($file.Name) ($([math]::Round($file.Length / 1KB, 2)) KB)"
            }
            
            Remove-Item $file.FullName -Force
            $filesRemoved++
        }
        
        $totalSizeMB = [math]::Round($totalSize / 1MB, 2)
        
        Write-Success "Nettoyage terminé"
        Write-Info "Fichiers supprimés : $filesRemoved"
        Write-Info "Espace libéré : $totalSizeMB MB"
        
        # Supprimer le répertoire s'il est vide
        if ((Get-ChildItem -Path $cacheDir -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item $cacheDir -Force
            Write-Info "Répertoire du cache supprimé"
        }
        
        return @{
            Success = $true
            Action = "Cleaned"
            FilesRemoved = $filesRemoved
            SizeFreed = $totalSizeMB
        }
        
    } catch {
        Write-Error "Erreur lors du nettoyage du cache : $($_.Exception.Message)"
        return @{
            Success = $false
            Action = "Error"
            Reason = $_.Exception.Message
        }
    }
}

# Diagnostic du cache
function Invoke-CacheDiagnose {
    Write-Host "🔬 DIAGNOSTIC COMPLET DU CACHE" -ForegroundColor Cyan
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host ""
    
    $cacheFile = Join-Path $ProjectRoot ".roo-state-manager/skeleton-cache.json"
    
    if (-not (Test-Path $cacheFile)) {
        Write-Error "Cache skeleton manquant!"
        Write-Info "→ Exécuter : .\roo-cache.ps1 -Build"
        return @{
            Success = $false
            Reason = "Cache file missing"
        }
    }
    
    try {
        # Validation de base
        $validation = Invoke-CacheValidate
        
        if (-not $validation.Success) {
            return $validation
        }
        
        # Analyse approfondie
        Write-Host ""
        Write-Host "📊 ANALYSE APPROFONDIE" -ForegroundColor Magenta
        
        $content = Get-Content $cacheFile -Raw | ConvertFrom-Json
        $taskIds = $content | Get-Member -Type NoteProperty | Select-Object -ExpandProperty Name
        
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
        
        # Rapport détaillé
        Write-Host "🏢 WORKSPACES ($($workspaces.Count))" -ForegroundColor Green
        $sortedWorkspaces = $workspaces.GetEnumerator() | Sort-Object Value -Descending
        $topWorkspaces = $sortedWorkspaces | Select-Object -First 10
        
        foreach ($ws in $topWorkspaces) {
            $percent = [math]::Round(($ws.Value / $taskIds.Count) * 100, 1)
            Write-Info "$($ws.Name) : $($ws.Value) tâches ($percent%)"
        }
        
        Write-Host ""
        Write-Host "🔗 HIÉRARCHIE" -ForegroundColor Green
        $hierarchyRate = [math]::Round(($hierarchyStats.withChildren / $taskIds.Count) * 100, 1)
        $parentRate = [math]::Round(($hierarchyStats.withParents / $taskIds.Count) * 100, 1)
        $rootRate = [math]::Round(($hierarchyStats.roots / $taskIds.Count) * 100, 1)
        $orphanRate = [math]::Round(($hierarchyStats.orphans / $taskIds.Count) * 100, 1)
        
        Write-Info "Avec enfants : $($hierarchyStats.withChildren) ($hierarchyRate%)"
        Write-Info "Avec parents : $($hierarchyStats.withParents) ($parentRate%)"
        Write-Info "Racines : $($hierarchyStats.roots) ($rootRate%)"
        Write-Info "Orphelines : $($hierarchyStats.orphans) ($orphanRate%)"
        
        # Recommandations
        Write-Host ""
        Write-Host "💡 RECOMMANDATIONS" -ForegroundColor Yellow
        
        if ($hierarchyRate -lt 30) {
            Write-Warning "Taux de hiérarchie faible ($hierarchyRate%)"
            Write-Info "→ Vérifier l'algorithme de détection des relations parent-enfant"
        }
        
        if ($orphanRate -gt 50) {
            Write-Warning "Taux élevé de tâches orphelines ($orphanRate%)"
            Write-Info "→ Vérifier la cohérence des données de hiérarchie"
        }
        
        if ($workspaces.Count -gt 20) {
            Write-Warning "Grand nombre de workspaces ($($workspaces.Count))"
            Write-Info "→ Considérer la consolidation ou le nettoyage des workspaces inactifs"
        }
        
        return @{
            Success = $true
            TaskCount = $taskIds.Count
            WorkspaceCount = $workspaces.Count
            HierarchyRate = $hierarchyRate
            OrphanRate = $orphanRate
            Validation = $validation
        }
        
    } catch {
        Write-Error "Erreur lors du diagnostic : $($_.Exception.Message)"
        return @{
            Success = $false
            Reason = $_.Exception.Message
        }
    }
}

# Statut du cache
function Invoke-CacheStatus {
    Write-Host "📊 STATUT DU CACHE SKELETON" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Cyan
    Write-Host ""
    
    $cacheDir = Join-Path $ProjectRoot ".roo-state-manager"
    $cacheFile = Join-Path $cacheDir "skeleton-cache.json"
    
    Write-Info "Répertoire du cache : $cacheDir"
    Write-Info "Fichier du cache : $cacheFile"
    
    if (-not (Test-Path $cacheDir)) {
        Write-Warning "Répertoire du cache inexistant"
        Write-Info "Statut : NON CRÉÉ"
        return @{
            Exists = $false
            Status = "Not Created"
        }
    }
    
    if (-not (Test-Path $cacheFile)) {
        Write-Warning "Fichier de cache inexistant"
        Write-Info "Statut : VIDÉ"
        return @{
            Exists = $false
            Status = "Empty"
        }
    }
    
    try {
        $cacheFileObj = Get-Item $cacheFile
        $sizeMB = [math]::Round($cacheFileObj.Length / 1MB, 2)
        $sizeKB = [math]::Round($cacheFileObj.Length / 1KB, 0)
        $ageHours = (Get-Date) - $cacheFileObj.LastWriteTime | Select-Object TotalHours
        
        Write-Success "Cache trouvé"
        Write-Info "Taille : $sizeMB MB ($sizeKB KB)"
        Write-Info "Modifié : $($cacheFileObj.LastWriteTime)"
        Write-Info "Âge : $([math]::Round($ageHours.TotalHours, 1)) heures"
        
        # Comptage rapide des tâches
        try {
            $content = Get-Content $cacheFile -Raw | ConvertFrom-Json
            $taskCount = ($content | Get-Member -Type NoteProperty).Count
            Write-Info "Tâches : $taskCount"
            
            # Évaluation de l'âge
            if ($ageHours.TotalHours -gt 168) { # 7 jours
                Write-Warning "Cache âgé de plus d'une semaine"
                Write-Info "→ Considérer une reconstruction avec .\roo-cache.ps1 -Build"
            }
            
            return @{
                Exists = $true
                Status = "Valid"
                TaskCount = $taskCount
                Size = $sizeMB
                AgeHours = $ageHours.TotalHours
            }
        } catch {
            Write-Warning "Impossible de lire le contenu du cache"
            Write-Info "Statut : CORROMPU"
            return @{
                Exists = $true
                Status = "Corrupted"
                Size = $sizeMB
                AgeHours = $ageHours.TotalHours
            }
        }
        
    } catch {
        Write-Error "Erreur lors de la vérification du statut : $($_.Exception.Message)"
        return @{
            Exists = $false
            Status = "Error"
            Reason = $_.Exception.Message
        }
    }
}

# Point d'entrée principal
function Main {
    Write-Host "💾 SCRIPT UNIFIÉ DE GESTION CACHE - roo-state-manager" -ForegroundColor Cyan
    Write-Host "=====================================================" -ForegroundColor Cyan
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
                directory = "./cache-results"
                filename = "cache-{timestamp}"
            }
        }
    }
    
    Write-Info "Répertoire du projet : $ProjectRoot"
    Write-Info "Action : $Action"
    Write-Info "Force : $Force"
    Write-Host ""
    
    # Préparation de la sortie
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $outputFile = $config.output.directory + "/" + ($config.output.filename -replace '\{timestamp\}', $timestamp)
    
    # Créer le répertoire de sortie si nécessaire
    $outputDir = Split-Path $outputFile -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    
    # Exécution de l'action
    $result = $null
    
    switch ($Action) {
        "Build" {
            $result = Invoke-CacheBuild -Config $config
        }
        "Validate" {
            $result = Invoke-CacheValidate
        }
        "Clean" {
            $result = Invoke-CacheClean
        }
        "Diagnose" {
            $result = Invoke-CacheDiagnose
        }
        "Status" {
            $result = Invoke-CacheStatus
        }
        default {
            Write-Error "Action non reconnue : $Action"
            Show-Help
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
# Rapport de Gestion du Cache

**Action** : $Action  
**Timestamp** : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  
**Succès** : $(if ($result.Success) { 'Oui' } else { 'Non' })

## Résultats

```
$($result | ConvertTo-Json -Depth 5)
```

---

*Généré par roo-cache.ps1*
"@
        $markdown | Out-File -FilePath $markdownOutput -Encoding UTF8 -Force
        Write-Info "Rapport Markdown sauvegardé : $markdownOutput"
    }
    
    Write-Host ""
    if ($result.Success) {
        Write-Success "Opération terminée avec succès"
    } else {
        Write-Error "Opération échouée"
        if ($result.Recommendation) {
            Write-Info "Recommandation : $($result.Recommendation)"
        }
        exit 1
    }
}

# Exécution principale
Main