# Script de finalisation de la consolidation des docs
# Déplace les 3 derniers fichiers .md à la racine de docs/ vers leurs catégories

param(
    [switch]$DryRun
)

Write-Host "=== FINALISATION CONSOLIDATION DOCS ===" -ForegroundColor Cyan
Write-Host ""

$basePath = "docs"
$moves = @(
    @{
        Source = "$basePath\2025-09-28_validation_tests_unitaires_reconstruction_hierarchique.md"
        Target = "$basePath\tests\2025-09-28_validation_tests_unitaires_reconstruction_hierarchique.md"
        Category = "tests"
    },
    @{
        Source = "$basePath\ARBRE_CONVERSATION_CLUSTER.md"
        Target = "$basePath\parsing\ARBRE_CONVERSATION_CLUSTER.md"
        Category = "parsing"
    },
    @{
        Source = "$basePath\HARMONISATION_PARENTIDS_COMPLETE.md"
        Target = "$basePath\parsing\HARMONISATION_PARENTIDS_COMPLETE.md"
        Category = "parsing"
    }
)

if ($DryRun) {
    Write-Host "MODE DRY-RUN (simulation uniquement)" -ForegroundColor Yellow
    Write-Host ""
}

$moved = 0
$skipped = 0

foreach ($move in $moves) {
    if (-not (Test-Path $move.Source)) {
        Write-Host "⏭️  SKIP: $($move.Source) n'existe pas" -ForegroundColor Gray
        $skipped++
        continue
    }

    Write-Host "📄 $($move.Source)" -ForegroundColor White
    Write-Host "   → $($move.Target)" -ForegroundColor Green

    if (-not $DryRun) {
        Move-Item -Path $move.Source -Destination $move.Target -Force
        Write-Host "   ✅ Déplacé" -ForegroundColor Green
    } else {
        Write-Host "   [DRY-RUN] Serait déplacé" -ForegroundColor Yellow
    }
    
    $moved++
    Write-Host ""
}

Write-Host "=== RÉSUMÉ ===" -ForegroundColor Cyan
Write-Host "Fichiers déplacés: $moved"
Write-Host "Fichiers ignorés: $skipped"

if ($DryRun) {
    Write-Host ""
    Write-Host "⚠️  SIMULATION - Aucun fichier n'a été réellement déplacé" -ForegroundColor Yellow
    Write-Host "Exécutez sans -DryRun pour effectuer les déplacements" -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "✅ Consolidation finalisée!" -ForegroundColor Green
}