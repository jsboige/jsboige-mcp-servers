# ✅ SCRIPT DE VALIDATION RÉORGANISATION DOCUMENTATION
# ====================================================
# Valide automatiquement la conformité de la réorganisation de la documentation
# Usage: .\validate-docs-reorganization.ps1

param(
    [switch]$Fix = $false,  # Corrige automatiquement les problèmes détectés
    [switch]$Detailed = $false
)

$DocsPath = Join-Path $PSScriptRoot ".." "docs"
$ArchivesPath = Join-Path $DocsPath "archives"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Write-Host "✅ VALIDATION RÉORGANISATION DOCUMENTATION - $Timestamp" -ForegroundColor Green
Write-Host "=" * 65

$ValidationErrors = @()
$ValidationWarnings = @()
$ValidationSuccess = @()

# 1. Vérification structure de base
Write-Host "`n🏗️ VALIDATION STRUCTURE DE BASE:" -ForegroundColor Cyan

$RequiredDirs = @("archives", "active", "templates")
foreach ($dir in $RequiredDirs) {
    $dirPath = Join-Path $DocsPath $dir
    if (Test-Path $dirPath) {
        $ValidationSuccess += "✅ Répertoire '$dir' présent"
        Write-Host "  ✅ $dir" -ForegroundColor Green
    } else {
        $ValidationErrors += "❌ Répertoire '$dir' manquant"
        Write-Host "  ❌ $dir MANQUANT" -ForegroundColor Red
        
        if ($Fix) {
            New-Item -Path $dirPath -ItemType Directory -Force | Out-Null
            Write-Host "    🔧 Répertoire '$dir' créé" -ForegroundColor Yellow
        }
    }
}

# 2. Validation des fichiers actifs requis
Write-Host "`n📋 VALIDATION FICHIERS ACTIFS:" -ForegroundColor Cyan

$RequiredActiveFiles = @(
    "README-STATUS.md",
    "INDEX-DOCUMENTATION.md"
)

$activePath = Join-Path $DocsPath "active"
foreach ($file in $RequiredActiveFiles) {
    $filePath = Join-Path $activePath $file
    if (Test-Path $filePath) {
        $ValidationSuccess += "✅ Fichier actif '$file' présent"
        Write-Host "  ✅ $file" -ForegroundColor Green
    } else {
        $ValidationErrors += "❌ Fichier actif '$file' manquant"
        Write-Host "  ❌ $file MANQUANT" -ForegroundColor Red
    }
}

# 3. Validation convention de nommage des archives
Write-Host "`n📏 VALIDATION CONVENTIONS DE NOMMAGE:" -ForegroundColor Cyan

$ConventionPattern = '^202\d-\d{2}-\d{2}-\d{2}-[A-Z-]+-.+\.md$'
$TotalFiles = 0
$CompliantFiles = 0
$NonCompliantFiles = @()

if (Test-Path $ArchivesPath) {
    $allArchiveFiles = Get-ChildItem $ArchivesPath -Recurse -File -Filter "*.md"
    foreach ($file in $allArchiveFiles) {
        $TotalFiles++
        if ($file.Name -match $ConventionPattern) {
            $CompliantFiles++
            if ($Detailed) {
                Write-Host "  ✅ $($file.Name)" -ForegroundColor Green
            }
        } else {
            $NonCompliantFiles += $file.Name
            Write-Host "  ❌ $($file.Name) - Non conforme" -ForegroundColor Red
        }
    }
    
    $ComplianceRate = if ($TotalFiles -gt 0) { 
        [math]::Round(($CompliantFiles / $TotalFiles) * 100, 1) 
    } else { 
        0 
    }
    
    Write-Host "  📊 Conformité : $CompliantFiles/$TotalFiles ($ComplianceRate%)" -ForegroundColor $(if ($ComplianceRate -ge 90) { "Green" } elseif ($ComplianceRate -ge 70) { "Yellow" } else { "Red" })
    
    if ($ComplianceRate -lt 90) {
        $ValidationWarnings += "⚠️ Taux de conformité des noms insuffisant ($ComplianceRate%)"
    } else {
        $ValidationSuccess += "✅ Taux de conformité excellent ($ComplianceRate%)"
    }
}

# 4. Validation organisation chronologique
Write-Host "`n📅 VALIDATION ORGANISATION CHRONOLOGIQUE:" -ForegroundColor Cyan

if (Test-Path $ArchivesPath) {
    $monthlyDirs = Get-ChildItem $ArchivesPath -Directory | Sort-Object Name
    $previousDate = $null
    
    foreach ($monthDir in $monthlyDirs) {
        if ($monthDir.Name -match '^202\d-\d{2}$') {
            $currentDate = [DateTime]::ParseExact($monthDir.Name + "-01", "yyyy-MM-dd", $null)
            
            if ($previousDate -and $currentDate -lt $previousDate) {
                $ValidationWarnings += "⚠️ Ordre chronologique incorrect : $($monthDir.Name)"
                Write-Host "  ⚠️ $($monthDir.Name) - Ordre chronologique incorrect" -ForegroundColor Yellow
            } else {
                Write-Host "  ✅ $($monthDir.Name)" -ForegroundColor Green
            }
            
            $previousDate = $currentDate
            
            # Vérifier les fichiers dans ce mois
            $monthFiles = Get-ChildItem $monthDir.FullName -File | Sort-Object Name
            $dailySequences = @{}
            
            foreach ($file in $monthFiles) {
                if ($file.BaseName -match '^(202\d-\d{2}-\d{2})-(\d{2})-') {
                    $date = $matches[1]
                    $sequence = [int]$matches[2]
                    
                    if (-not $dailySequences.ContainsKey($date)) {
                        $dailySequences[$date] = @()
                    }
                    $dailySequences[$date] += $sequence
                }
            }
            
            # Vérifier les séquences quotidiennes
            foreach ($date in $dailySequences.Keys) {
                $sequences = $dailySequences[$date] | Sort-Object
                $expected = 1
                foreach ($seq in $sequences) {
                    if ($seq -ne $expected) {
                        $ValidationWarnings += "⚠️ Séquence incorrecte pour $date : attendu $expected, trouvé $seq"
                    }
                    $expected++
                }
            }
        } else {
            $ValidationWarnings += "⚠️ Nom de répertoire mensuel non conforme : $($monthDir.Name)"
            Write-Host "  ⚠️ $($monthDir.Name) - Format incorrect" -ForegroundColor Yellow
        }
    }
}

# 5. Vérification des anciens répertoires (doivent être supprimés)
Write-Host "`n🗑️ VALIDATION NETTOYAGE:" -ForegroundColor Cyan

$OldDirs = @("debug", "implementation", "parsing", "reports", "tests")
$oldDirsFound = @()

foreach ($oldDir in $OldDirs) {
    $oldDirPath = Join-Path $DocsPath $oldDir
    if (Test-Path $oldDirPath) {
        $oldDirsFound += $oldDir
        $ValidationWarnings += "⚠️ Ancien répertoire '$oldDir' encore présent"
        Write-Host "  ⚠️ $oldDir - Ancien répertoire présent" -ForegroundColor Yellow
        
        if ($Fix) {
            $filesCount = (Get-ChildItem $oldDirPath -Recurse -File | Measure-Object).Count
            if ($filesCount -eq 0) {
                Remove-Item $oldDirPath -Recurse -Force
                Write-Host "    🔧 Répertoire vide '$oldDir' supprimé" -ForegroundColor Yellow
            } else {
                Write-Host "    ⚠️ Répertoire '$oldDir' contient $filesCount fichiers - suppression manuelle requise" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "  ✅ $oldDir (supprimé)" -ForegroundColor Green
    }
}

# 6. Génération du rapport final
Write-Host "`n📊 RAPPORT DE VALIDATION:" -ForegroundColor Yellow
Write-Host "-" * 30

Write-Host "✅ SUCCÈS ($($ValidationSuccess.Count)):" -ForegroundColor Green
$ValidationSuccess | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }

if ($ValidationWarnings.Count -gt 0) {
    Write-Host "`n⚠️ AVERTISSEMENTS ($($ValidationWarnings.Count)):" -ForegroundColor Yellow
    $ValidationWarnings | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

if ($ValidationErrors.Count -gt 0) {
    Write-Host "`n❌ ERREURS ($($ValidationErrors.Count)):" -ForegroundColor Red
    $ValidationErrors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
}

# Calcul du score de qualité
$TotalChecks = $ValidationSuccess.Count + $ValidationWarnings.Count + $ValidationErrors.Count
$QualityScore = if ($TotalChecks -gt 0) {
    [math]::Round((($ValidationSuccess.Count + $ValidationWarnings.Count * 0.5) / $TotalChecks) * 100, 1)
} else { 
    100 
}

Write-Host "`n🎯 SCORE DE QUALITÉ : $QualityScore%" -ForegroundColor $(
    if ($QualityScore -ge 95) { "Green" }
    elseif ($QualityScore -ge 85) { "Yellow" }
    else { "Red" }
)

# Recommandations
Write-Host "`n💡 RECOMMANDATIONS:" -ForegroundColor Magenta
if ($ValidationErrors.Count -gt 0) {
    Write-Host "  🔧 Corriger les erreurs critiques avant de continuer"
}
if ($NonCompliantFiles.Count -gt 0) {
    Write-Host "  📏 Renommer les fichiers non conformes à la convention"
}
if ($oldDirsFound.Count -gt 0) {
    Write-Host "  🗑️ Supprimer les anciens répertoires après vérification du contenu"
}
if ($QualityScore -ge 95) {
    Write-Host "  🎉 Réorganisation excellente ! Prêt pour la production."
}

Write-Host "`n" + ("=" * 65)
Write-Host "✅ Validation terminée - Score: $QualityScore%" -ForegroundColor Green