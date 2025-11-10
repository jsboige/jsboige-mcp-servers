# 📊 SCRIPT DE RAPPORT STATUT DOCUMENTATION
# ================================================
# Génère un rapport automatique de l'état de la documentation réorganisée
# Usage: .\docs-status-report.ps1

param(
    [switch]$Detailed = $false,
    [switch]$ExportCsv = $false
)

$DocsPath = Join-Path $PSScriptRoot ".." "docs"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Write-Host "📊 RAPPORT STATUT DOCUMENTATION - $Timestamp" -ForegroundColor Green
Write-Host "=" * 60

# 1. Structure générale
Write-Host "`n🗂️ STRUCTURE GÉNÉRALE:" -ForegroundColor Cyan
$directories = Get-ChildItem $DocsPath -Directory | Sort-Object Name
foreach ($dir in $directories) {
    $fileCount = (Get-ChildItem $dir.FullName -Recurse -File | Measure-Object).Count
    Write-Host "  📁 $($dir.Name) : $fileCount fichiers"
}

# 2. Archives par mois
Write-Host "`n📅 ARCHIVES CHRONOLOGIQUES:" -ForegroundColor Cyan
$archivesPath = Join-Path $DocsPath "archives"
if (Test-Path $archivesPath) {
    $monthlyArchives = Get-ChildItem $archivesPath -Directory | Sort-Object Name
    $totalArchived = 0
    foreach ($month in $monthlyArchives) {
        $count = (Get-ChildItem $month.FullName -File | Measure-Object).Count
        $totalArchived += $count
        Write-Host "  📆 $($month.Name) : $count documents"
        
        if ($Detailed) {
            $files = Get-ChildItem $month.FullName -File | Sort-Object Name
            foreach ($file in $files) {
                $type = ($file.BaseName -split '-')[4]
                Write-Host "    • $($file.BaseName) [$type]" -ForegroundColor Gray
            }
        }
    }
    Write-Host "  🎯 Total archivé : $totalArchived documents" -ForegroundColor Yellow
}

# 3. Fichiers actifs
Write-Host "`n🟢 DOCUMENTS ACTIFS:" -ForegroundColor Cyan
$activePath = Join-Path $DocsPath "active"
if (Test-Path $activePath) {
    $activeFiles = Get-ChildItem $activePath -File
    foreach ($file in $activeFiles) {
        $size = [math]::Round($file.Length / 1KB, 1)
        Write-Host "  📄 $($file.Name) ($size KB)"
    }
}

# 4. Fichiers racine
Write-Host "`n📋 FICHIERS RACINE:" -ForegroundColor Cyan
$rootFiles = Get-ChildItem $DocsPath -File
foreach ($file in $rootFiles) {
    $age = (Get-Date) - $file.LastWriteTime
    Write-Host "  📄 $($file.Name) (modifié il y a $($age.Days) jours)"
}

# 5. Conventions de nommage
Write-Host "`n✅ VALIDATION CONVENTIONS:" -ForegroundColor Cyan
$conventionCompliant = 0
$conventionTotal = 0

if (Test-Path $archivesPath) {
    $allArchiveFiles = Get-ChildItem $archivesPath -Recurse -File
    foreach ($file in $allArchiveFiles) {
        $conventionTotal++
        # Pattern: YYYY-MM-DD-XX-TYPE-DESCRIPTIF.md
        if ($file.BaseName -match '^202\d-\d{2}-\d{2}-\d{2}-[A-Z-]+-.+$') {
            $conventionCompliant++
        }
    }
    $complianceRate = [math]::Round(($conventionCompliant / $conventionTotal) * 100, 1)
    Write-Host "  📏 Conformité convention : $conventionCompliant/$conventionTotal ($complianceRate%)"
}

# 6. Export CSV optionnel
if ($ExportCsv) {
    $csvData = @()
    if (Test-Path $archivesPath) {
        $allFiles = Get-ChildItem $archivesPath -Recurse -File
        foreach ($file in $allFiles) {
            $parts = $file.BaseName -split '-'
            $csvData += [PSCustomObject]@{
                FileName = $file.Name
                Date = if ($parts.Length -ge 3) { "$($parts[0])-$($parts[1])-$($parts[2])" } else { "Unknown" }
                Sequence = if ($parts.Length -ge 4) { $parts[3] } else { "Unknown" }
                Type = if ($parts.Length -ge 5) { $parts[4] } else { "Unknown" }
                Size_KB = [math]::Round($file.Length / 1KB, 1)
                LastModified = $file.LastWriteTime
            }
        }
    }
    $csvPath = Join-Path $PSScriptRoot "docs-inventory-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv"
    $csvData | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
    Write-Host "`n💾 Export CSV généré : $csvPath" -ForegroundColor Green
}

Write-Host "`n🎯 RÉSUMÉ RAPIDE:" -ForegroundColor Yellow
Write-Host "  • Structure : 4 répertoires principaux (archives/, active/, templates/, ...)"
Write-Host "  • Archives : $totalArchived documents organisés chronologiquement" 
Write-Host "  • Conformité : $complianceRate% des documents suivent la convention"
Write-Host "  • Dernier rapport : $Timestamp"

Write-Host "`n✅ Rapport terminé !" -ForegroundColor Green