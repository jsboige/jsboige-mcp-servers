#!/usr/bin/env powershell
#
# 📊 DIAGNOSTIC CACHE SKELETON
# Script de vérification état et contenu du cache skeleton
#

param(
    [switch]$Detailed = $false,
    [switch]$SampleTasks = $false
)

Write-Host "📊 DIAGNOSTIC CACHE SKELETON" -ForegroundColor Yellow
Write-Host "=============================" -ForegroundColor Yellow
Write-Host ""

$basePath = Split-Path -Parent $PSScriptRoot
$cachePath = Join-Path $basePath ".roo-state-manager/skeleton-cache.json"

Write-Host "Chemin cache: $cachePath" -ForegroundColor Cyan

if (-not (Test-Path $cachePath)) {
    Write-Host "❌ CACHE SKELETON MANQUANT!" -ForegroundColor Red
    Write-Host "   → Exécuter: build_skeleton_cache" -ForegroundColor Yellow
    exit 1
}

# Taille fichier
$cacheFile = Get-Item $cachePath
$sizeMB = [math]::Round($cacheFile.Length / 1MB, 2)
$sizeKB = [math]::Round($cacheFile.Length / 1KB, 0)

Write-Host "✅ Cache trouvé" -ForegroundColor Green
Write-Host "   Taille: $sizeMB MB ($sizeKB KB)" -ForegroundColor Cyan
Write-Host "   Modifié: $($cacheFile.LastWriteTime)" -ForegroundColor Gray

try {
    Write-Host ""
    Write-Host "🔍 Analyse contenu..." -ForegroundColor Yellow
    
    $content = Get-Content $cachePath -Raw | ConvertFrom-Json
    $taskIds = $content | Get-Member -Type NoteProperty | Select-Object -ExpandProperty Name
    $taskCount = $taskIds.Count
    
    Write-Host "📈 STATISTIQUES GÉNÉRALES" -ForegroundColor Green
    Write-Host "   Total tâches: $taskCount" -ForegroundColor Cyan
    
    if ($taskCount -eq 0) {
        Write-Host "❌ CACHE VIDE!" -ForegroundColor Red
        exit 1
    }
    
    # Analyser workspaces
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
        Write-Host "   $($ws.Name): $($ws.Value) tâches ($percent%)" -ForegroundColor Cyan
    }
    
    if ($workspaces.Count -gt 10) {
        $remaining = $workspaces.Count - 10
        Write-Host "   ... et $remaining autres workspaces" -ForegroundColor Gray
    }
    
    Write-Host ""
    Write-Host "🔗 HIÉRARCHIE" -ForegroundColor Green
    $hierarchyRate = [math]::Round(($hierarchyStats.withChildren / $taskCount) * 100, 1)
    $parentRate = [math]::Round(($hierarchyStats.withParents / $taskCount) * 100, 1)
    $rootRate = [math]::Round(($hierarchyStats.roots / $taskCount) * 100, 1)
    $orphanRate = [math]::Round(($hierarchyStats.orphans / $taskCount) * 100, 1)
    
    Write-Host "   Avec enfants: $($hierarchyStats.withChildren) ($hierarchyRate%)" -ForegroundColor Cyan
    Write-Host "   Avec parents: $($hierarchyStats.withParents) ($parentRate%)" -ForegroundColor Cyan
    Write-Host "   Racines: $($hierarchyStats.roots) ($rootRate%)" -ForegroundColor Cyan
    Write-Host "   Orphelines: $($hierarchyStats.orphans) ($orphanRate%)" -ForegroundColor Cyan
    
    # Évaluation système
    Write-Host ""
    Write-Host "📊 ÉVALUATION SYSTÈME" -ForegroundColor Yellow
    if ($hierarchyRate -ge 70) {
        Write-Host "✅ EXCELLENT: Système hiérarchique très performant" -ForegroundColor Green
    } elseif ($hierarchyRate -ge 50) {
        Write-Host "✅ BON: Performance hiérarchique satisfaisante" -ForegroundColor Green
    } elseif ($hierarchyRate -ge 30) {
        Write-Host "⚠️ MOYEN: Amélioration possible" -ForegroundColor Yellow
    } else {
        Write-Host "❌ FAIBLE: Investigation requise" -ForegroundColor Red
    }
    
    if ($SampleTasks -and $taskCount -gt 0) {
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
            
            Write-Host "   $shortId ($($task.workspace)): $childCount enfants" -ForegroundColor Cyan
            if ($instruction) {
                Write-Host "      → $instruction" -ForegroundColor Gray
            }
        }
    }
    
    Write-Host ""
    Write-Host "✅ Diagnostic terminé - Cache opérationnel" -ForegroundColor Green
    
} catch {
    Write-Host "❌ ERREUR: Impossible d'analyser le cache" -ForegroundColor Red
    $errorMsg = $_.Exception.Message
    Write-Host "   $errorMsg" -ForegroundColor Gray
    exit 1
}