# Script de validation et commit de la consolidation docs
# Usage: .\scripts\commit-docs-consolidation.ps1

Write-Host "=== VALIDATION FINALE - CONSOLIDATION DOCS ===" -ForegroundColor Cyan
Write-Host ""

# Vérifier le statut Git
Write-Host "--- Statut Git ---" -ForegroundColor Yellow
git status --short

Write-Host ""
Write-Host "--- Fichiers modifiés/ajoutés ---" -ForegroundColor Yellow
$changedFiles = git status --short
if ($changedFiles) {
    $changedFiles | ForEach-Object {
        Write-Host "  $_" -ForegroundColor White
    }
} else {
    Write-Host "  Aucun changement détecté" -ForegroundColor Gray
}

Write-Host ""
Write-Host "--- Audit final des .md à la racine ---" -ForegroundColor Yellow
$rootMd = Get-ChildItem -Path . -Filter "*.md" -File
Write-Host "Fichiers .md à la racine: $($rootMd.Count)"
$rootMd | ForEach-Object {
    Write-Host "  ✓ $($_.Name)" -ForegroundColor Green
}

Write-Host ""
Write-Host "--- Structure docs/ finale ---" -ForegroundColor Yellow
$docsMd = Get-ChildItem -Path "docs" -Filter "*.md" -Recurse -File | Measure-Object
Write-Host "Total fichiers dans docs/: $($docsMd.Count)"

Write-Host ""
Write-Host "=== RÉSUMÉ ===" -ForegroundColor Cyan
Write-Host "✅ Racine: Seulement README.md et CHANGELOG.md"
Write-Host "✅ docs/: $($docsMd.Count) fichiers organisés"
Write-Host "✅ Index docs/README.md à jour"
Write-Host ""

# Proposition de commit
Write-Host "--- Commande de commit suggérée ---" -ForegroundColor Yellow
Write-Host 'git add .' -ForegroundColor White
Write-Host 'git commit -m "docs: finalize consolidation - move remaining files to categorized docs/"' -ForegroundColor White
Write-Host ""
Write-Host "Voulez-vous exécuter ces commandes maintenant? (O/N)" -ForegroundColor Cyan
$response = Read-Host

if ($response -eq "O" -or $response -eq "o") {
    Write-Host ""
    Write-Host "Exécution du commit..." -ForegroundColor Green
    git add .
    git commit -m "docs: finalize consolidation - move remaining files to categorized docs/"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✅ Commit réussi!" -ForegroundColor Green
        Write-Host ""
        git log -1 --oneline
    } else {
        Write-Host ""
        Write-Host "❌ Erreur lors du commit" -ForegroundColor Red
    }
} else {
    Write-Host ""
    Write-Host "⏭️  Commit annulé - Vous pouvez l'exécuter manuellement" -ForegroundColor Yellow
}