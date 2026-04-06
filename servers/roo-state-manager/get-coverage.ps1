# Script PowerShell pour obtenir la couverture des tests
cd "D:/dev/roo-extensions/.claude/worktrees/wt-worker-myia-po-2025-20260405-172150/mcps/internal/servers/roo-state-manager"

# Exécuter les tests avec coverage
npx vitest run --coverage

# Vérifier si le rapport de couverture existe
if (Test-Path "coverage/index.html") {
    Write-Host "Rapport de couverture généré: coverage/index.html"

    # Extraire les statistiques de couverture depuis lcov.info
    if (Test-Path "coverage/lcov.info") {
        Write-Host "Analyse de lcov.info..."

        # Compter les lignes couvertes et totales
        $coveredLines = 0
        $totalLines = 0

        Get-Content "coverage/lcov.info" | ForEach-Object {
            if ($_ -like "SF:*") {
                $currentFile = $_
            } elseif ($_ -like "DA:*") {
                $parts = $_ -split ','
                if ($parts[2] -eq "1") {
                    $coveredLines++
                }
                $totalLines++
            }
        }

        $coveragePercent = if ($totalLines -gt 0) { [math]::Round(($coveredLines / $totalLines) * 100, 2) } else { 0 }

        Write-Host "Lignes couvertes: $coveredLines / $totalLines"
        Write-Host "Couverture totale: $coveragePercent%"
    }
} else {
    Write-Host "Aucun rapport de couverture trouvé"
}

# Attendre une seconde pour laisser le temps au rapport d'être généré
Start-Sleep -Seconds 2