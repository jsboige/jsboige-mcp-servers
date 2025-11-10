# Script d'analyse des appels newTask dans ui_messages.json
param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

Write-Host "Analyse de: $FilePath" -ForegroundColor Cyan
Write-Host "Recherche des occurrences de {`"tool`":`"newTask`"..." -ForegroundColor Yellow
Write-Host ""

$newTaskCount = 0
$taskIds = @()
$lineNumber = 0

# Lecture ligne par ligne pour ne pas saturer la mémoire
Get-Content $FilePath | ForEach-Object {
    $lineNumber++
    $line = $_
    
    # Chercher {"tool":"newTask"
    if ($line -match '\{"tool"\s*:\s*"newTask"') {
        $newTaskCount++
        
        # Extraire le contexte autour (taskId si présent dans les lignes suivantes)
        # On va essayer de trouver le pattern taskId dans la même ligne ou proche
        if ($line -match '"taskId"\s*:\s*"([a-f0-9\-]+)"') {
            $taskId = $Matches[1]
            $taskIds += $taskId
            Write-Host "[$newTaskCount] Ligne $lineNumber : taskId = $taskId" -ForegroundColor Green
        } else {
            Write-Host "[$newTaskCount] Ligne $lineNumber : taskId non trouvé sur cette ligne" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "=== RÉSUMÉ ===" -ForegroundColor Cyan
Write-Host "Total newTask trouvés: $newTaskCount" -ForegroundColor Green
Write-Host "TaskIds identifiés: $($taskIds.Count)" -ForegroundColor Green

if ($taskIds.Count -gt 0) {
    Write-Host ""
    Write-Host "Liste des taskIds:" -ForegroundColor Cyan
    $taskIds | ForEach-Object { Write-Host "  - $_" -ForegroundColor White }
}