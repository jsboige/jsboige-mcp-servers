# Script d'audit des fichiers markdown
# Usage: .\scripts\audit-markdown-files.ps1

Write-Host "=== AUDIT DES FICHIERS MARKDOWN ===" -ForegroundColor Cyan
Write-Host ""

# Fichiers .md à la racine
Write-Host "--- Fichiers .md à la racine ---" -ForegroundColor Yellow
$rootMdFiles = Get-ChildItem -Path . -Filter "*.md" -File
if ($rootMdFiles.Count -gt 0) {
    $rootMdFiles | Select-Object Name, @{Name='Taille';Expression={'{0:N0} octets' -f $_.Length}}, LastWriteTime | Format-Table -AutoSize
    Write-Host "Total: $($rootMdFiles.Count) fichiers" -ForegroundColor Green
} else {
    Write-Host "Aucun fichier .md trouvé à la racine (sauf README.md et CHANGELOG.md)" -ForegroundColor Gray
}
Write-Host ""

# Structure docs/
Write-Host "--- Structure du répertoire docs/ ---" -ForegroundColor Yellow
if (Test-Path "docs") {
    $docsMdFiles = Get-ChildItem -Path "docs" -Filter "*.md" -Recurse -File
    if ($docsMdFiles.Count -gt 0) {
        $docsMdFiles | Select-Object @{Name='Chemin';Expression={$_.FullName.Replace((Get-Location).Path + '\', '')}}, @{Name='Taille';Expression={'{0:N0} octets' -f $_.Length}} | Format-Table -AutoSize
        Write-Host "Total: $($docsMdFiles.Count) fichiers dans docs/" -ForegroundColor Green
    } else {
        Write-Host "Aucun fichier .md dans docs/" -ForegroundColor Gray
    }
} else {
    Write-Host "Le répertoire docs/ n'existe pas" -ForegroundColor Red
}
Write-Host ""

# Tous les fichiers .md (aperçu global)
Write-Host "--- Tous les fichiers .md du projet ---" -ForegroundColor Yellow
$allMdFiles = Get-ChildItem -Path . -Filter "*.md" -Recurse -File
$allMdFiles | Select-Object @{Name='Chemin';Expression={$_.FullName.Replace((Get-Location).Path + '\', '')}}, @{Name='Taille';Expression={'{0:N0} octets' -f $_.Length}} | Format-Table -AutoSize
Write-Host "Total général: $($allMdFiles.Count) fichiers .md" -ForegroundColor Green
Write-Host ""

# Résumé
Write-Host "=== RÉSUMÉ ===" -ForegroundColor Cyan
Write-Host "Racine: $($rootMdFiles.Count) fichiers"
if (Test-Path "docs") {
    Write-Host "Docs/: $($docsMdFiles.Count) fichiers"
}
Write-Host "Total: $($allMdFiles.Count) fichiers"
Write-Host ""