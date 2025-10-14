<#
.SYNOPSIS
    Supprime les répertoires de checkpoints obsolètes des tâches de Roo.

.DESCRIPTION
    Ce script parcourt les sous-répertoires de C:/Users/jsboi/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks
    et supprime le sous-répertoire `checkpoints` de chaque tâche.

    Il inclut des mesures de sécurité pour éviter la suppression accidentelle. Par défaut, il s'exécute en mode DryRun.
    La suppression réelle n'a lieu que si le paramètre -Force est utilisé.

.PARAMETER DryRun
    Si ce switch est présent, le script listera les répertoires qui seraient supprimés et affichera un résumé
    sans effectuer de suppression. C'est le comportement par défaut si -Force n'est pas spécifié.

.PARAMETER Force
    Si ce switch est présent, le script procédera à la suppression des répertoires de checkpoints identifiés.
    Sans ce paramètre, aucune suppression ne sera effectuée.

.EXAMPLE
    PS> .\cleanup_obsolete_checkpoints.ps1
    Exécute le script en mode DryRun (par défaut), affichant les répertoires à supprimer et un résumé.

.EXAMPLE
    PS> .\cleanup_obsolete_checkpoints.ps1 -DryRun
    Exécute explicitement le script en mode DryRun.

.EXAMPLE
    PS> .\cleanup_obsolete_checkpoints.ps1 -Force
    Supprime réellement les répertoires de checkpoints obsolètes. Une confirmation sera demandée.

.NOTES
    Auteur: Roo
    Version: 2.0
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param (
    [Switch]$DryRun,
    [Switch]$Force
)

# Chemin du répertoire des tâches
$tasksPath = Join-Path $env:APPDATA "Code\User\globalStorage\rooveterinaryinc.roo-cline\tasks"

if (-not (Test-Path -Path $tasksPath)) {
    Write-Error "Le répertoire des tâches n'a pas été trouvé à l'emplacement '$tasksPath'."
    return
}

Write-Verbose "Début du scan du répertoire : $tasksPath"

# Récupérer tous les sous-répertoires de premier niveau dans le dossier des tâches
$taskSubdirectories = Get-ChildItem -Path $tasksPath -Directory

$directoriesToDelete = @()
$totalSize = 0

foreach ($taskDir in $taskSubdirectories) {
    Write-Verbose "Scan du répertoire de tâche : $($taskDir.FullName)"
    $checkpointDir = Join-Path -Path $taskDir.FullName -ChildPath "checkpoints"

    if (Test-Path -Path $checkpointDir -PathType Container) {
        $directoriesToDelete += $checkpointDir
        $dirSize = (Get-ChildItem $checkpointDir -Recurse | Measure-Object -Property Length -Sum).Sum
        $totalSize += $dirSize
    }
}

# Déterminer si une action doit être effectuée en fonction des paramètres
# Le mode DryRun est actif si -DryRun est spécifié OU si -Force n'est PAS spécifié.
$isDryRun = $DryRun.IsPresent -or (-not $Force.IsPresent)

if ($isDryRun) {
    Write-Host "--- Mode DryRun ---"
    Write-Host "Les répertoires suivants seraient supprimés :"
    $directoriesToDelete | ForEach-Object { Write-Host "- $_" }
    
    $totalSizeMB = if ($totalSize -gt 0) { [Math]::Round($totalSize / 1MB, 2) } else { 0 }
    
    Write-Host "`n--- Résumé ---"
    Write-Host "Nombre de répertoires à supprimer : $($directoriesToDelete.Count)"
    Write-Host "Taille totale des répertoires : $totalSizeMB MB"
    Write-Host "Pour supprimer ces répertoires, exécutez le script avec le paramètre -Force."
}
else {
    # -Force est présent, on procède à la suppression
    if ($directoriesToDelete.Count -eq 0) {
        Write-Host "Aucun répertoire de checkpoint à supprimer."
        return
    }

    Write-Host "Début de la suppression des répertoires de checkpoint..."
    
    $deletedCount = 0
    $deletedSize = 0

    $totalToDelete = $directoriesToDelete.Count
    for ($i = 0; $i -lt $totalToDelete; $i++) {
        $dir = $directoriesToDelete[$i]
        $progress = "($($i + 1)/$totalToDelete)"
        Write-Host "$progress Suppression de $dir..."
        try {
            $dirSize = (Get-ChildItem $dir -Recurse -Force | Measure-Object -Property Length -Sum).Sum
            Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
            $deletedCount++
            $deletedSize += $dirSize
        }
        catch {
            Write-Error "$progress Erreur lors de la suppression du répertoire ${dir}: $_"
        }
    }

    $deletedSizeMB = if ($deletedSize -gt 0) { [Math]::Round($deletedSize / 1MB, 2) } else { 0 }

    Write-Host "`n--- Résumé de la suppression ---"
    Write-Host "Nombre de répertoires supprimés : $deletedCount"
    Write-Host "Espace libéré : $deletedSizeMB MB"
}

Write-Verbose "Script terminé."