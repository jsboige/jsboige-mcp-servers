<#
.SYNOPSIS
    Script d'audit complet de l'arborescence des tests
.DESCRIPTION
    Analyse tous les fichiers de tests et collecte leurs métadonnées
#>

param(
    [string]$OutputFile = "AUDIT-TESTS-LAYOUT.md"
)

$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "[AUDIT] Analyse de l'arborescence des tests..." -ForegroundColor Cyan
Write-Host ""

# Fonction pour compter les tests dans un fichier
function Count-Tests {
    param([string]$FilePath)
    
    if (-not (Test-Path $FilePath)) {
        return 0
    }
    
    $content = Get-Content $FilePath -Raw -ErrorAction SilentlyContinue
    if (-not $content) {
        return 0
    }
    
    # Compter les patterns de tests Jest/Mocha
    $testCount = ([regex]::Matches($content, "(?:it|test)\s*\(")).Count
    $describeCount = ([regex]::Matches($content, "describe\s*\(")).Count
    
    return @{
        Tests = $testCount
        Suites = $describeCount
    }
}

# Fonction pour déterminer le statut
function Get-TestStatus {
    param(
        [string]$FilePath,
        [System.IO.FileInfo]$FileInfo
    )
    
    $content = Get-Content $FilePath -Raw -ErrorAction SilentlyContinue
    if (-not $content) {
        return "VIDE"
    }
    
    # Vérifier si disabled
    if ($FilePath -match "\.disabled$") {
        return "DÉSACTIVÉ"
    }
    
    # Vérifier si tous les tests sont skip
    if ($content -match "\.skip\(" -and -not ($content -match "(?:it|test)\s*\((?!\s*\.skip)")) {
        return "TOUS_SKIP"
    }
    
    # Vérifier la date de modification (si > 30 jours, potentiellement obsolète)
    $daysSinceModified = (Get-Date) - $FileInfo.LastWriteTime
    if ($daysSinceModified.TotalDays -gt 90) {
        return "ANCIEN (>90j)"
    } elseif ($daysSinceModified.TotalDays -gt 30) {
        return "ANCIEN (>30j)"
    }
    
    return "ACTIF"
}

# Collecter tous les fichiers de tests
Write-Host "[INFO] Recherche des fichiers de tests..." -ForegroundColor Yellow

$testFiles = @()

# Dans tests/
$testFiles += Get-ChildItem -Path "tests" -Recurse -Include "*.test.ts","*.test.js","*.test.d.ts" -File -ErrorAction SilentlyContinue

# Dans src/ (y compris __tests__)
$testFiles += Get-ChildItem -Path "src" -Recurse -Include "*.test.ts","*.test.js" -File -ErrorAction SilentlyContinue

# Dans src/ (fichiers de test non standard)
$testFiles += Get-ChildItem -Path "src" -Recurse -Include "test-*.ts","test-*.js","*-test.ts","*-test.js" -File -ErrorAction SilentlyContinue

Write-Host "[INFO] Trouvé $($testFiles.Count) fichiers de tests" -ForegroundColor Green
Write-Host ""

# Analyser chaque fichier
$results = @()
$totalTests = 0
$totalSuites = 0

foreach ($file in $testFiles) {
    $relativePath = $file.FullName.Replace($ProjectRoot + "\", "").Replace("\", "/")
    $counts = Count-Tests -FilePath $file.FullName
    $status = Get-TestStatus -FilePath $file.FullName -FileInfo $file
    
    $totalTests += $counts.Tests
    $totalSuites += $counts.Suites
    
    $results += [PSCustomObject]@{
        Path = $relativePath
        Size = [math]::Round($file.Length / 1KB, 2)
        Tests = $counts.Tests
        Suites = $counts.Suites
        Modified = $file.LastWriteTime.ToString("yyyy-MM-dd")
        Status = $status
        Directory = Split-Path $relativePath -Parent
    }
}

# Trier par répertoire puis par nom
$results = $results | Sort-Object Directory, Path

# Générer le rapport Markdown
$markdown = @"
# Audit Complet de l'Arborescence des Tests

**Date d'audit** : $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")  
**Répertoire analysé** : ``$ProjectRoot``

---

## 📊 Statistiques Globales

| Métrique | Valeur |
|----------|--------|
| **Fichiers de tests totaux** | $($results.Count) |
| **Tests individuels** | $totalTests |
| **Suites de tests** | $totalSuites |
| **Taille totale** | $([math]::Round(($results | Measure-Object -Property Size -Sum).Sum / 1024, 2)) MB |

---

## 📁 Répartition par Répertoire

"@

# Grouper par répertoire
$byDirectory = $results | Group-Object Directory | Sort-Object Name

foreach ($group in $byDirectory) {
    $dirTests = ($group.Group | Measure-Object -Property Tests -Sum).Sum
    $dirSuites = ($group.Group | Measure-Object -Property Suites -Sum).Sum
    $dirSize = [math]::Round(($group.Group | Measure-Object -Property Size -Sum).Sum, 2)
    
    $markdown += @"

### 📂 ``$($group.Name)``

**Fichiers** : $($group.Count) | **Tests** : $dirTests | **Suites** : $dirSuites | **Taille** : $dirSize KB

| Fichier | Tests | Suites | Taille (KB) | Dernière Modif | Statut |
|---------|-------|--------|-------------|----------------|--------|

"@
    
    foreach ($file in $group.Group) {
        $fileName = Split-Path $file.Path -Leaf
        $statusEmoji = switch ($file.Status) {
            "ACTIF" { "✅" }
            "DÉSACTIVÉ" { "❌" }
            "VIDE" { "⚠️" }
            "TOUS_SKIP" { "⏭️" }
            default { "🕒" }
        }
        
        $markdown += "| ``$fileName`` | $($file.Tests) | $($file.Suites) | $($file.Size) | $($file.Modified) | $statusEmoji $($file.Status) |`n"
    }
}

# Analyse des statuts
$markdown += @"

---

## 🔍 Analyse des Statuts

"@

$statusGroups = $results | Group-Object Status | Sort-Object Count -Descending

foreach ($statusGroup in $statusGroups) {
    $percentage = [math]::Round(($statusGroup.Count / $results.Count) * 100, 1)
    $markdown += "- **$($statusGroup.Name)** : $($statusGroup.Count) fichiers ($percentage%)`n"
}

# Fichiers problématiques
$markdown += @"

---

## ⚠️ Fichiers Nécessitant Attention

### Fichiers Vides ou Sans Tests

"@

$emptyFiles = $results | Where-Object { $_.Tests -eq 0 -or $_.Status -eq "VIDE" }
if ($emptyFiles.Count -gt 0) {
    foreach ($file in $emptyFiles) {
        $markdown += "- ``$($file.Path)`` - Status: $($file.Status)`n"
    }
} else {
    $markdown += "*Aucun fichier vide détecté*`n"
}

$markdown += @"

### Fichiers Anciens (>90 jours sans modification)

"@

$oldFiles = $results | Where-Object { $_.Status -match "ANCIEN.*90" }
if ($oldFiles.Count -gt 0) {
    foreach ($file in $oldFiles) {
        $markdown += "- ``$($file.Path)`` - Modifié: $($file.Modified)`n"
    }
} else {
    $markdown += "*Aucun fichier ancien détecté*`n"
}

$markdown += @"

### Fichiers Désactivés

"@

$disabledFiles = $results | Where-Object { $_.Status -eq "DÉSACTIVÉ" }
if ($disabledFiles.Count -gt 0) {
    foreach ($file in $disabledFiles) {
        $markdown += "- ``$($file.Path)``n"
    }
} else {
    $markdown += "*Aucun fichier désactivé détecté*`n"
}

# Recommandations
$markdown += @"

---

## 💡 Recommandations

### Organisation Actuelle

**Points Positifs** :
- Existence d'une structure partielle (tests/, tests/unit/, tests/e2e/)
- Fixtures bien organisés (tests/fixtures/)
- Tests critiques bien identifiés

**Points d'Amélioration** :
1. **Tests dispersés** : Certains tests sont à la racine de tests/ alors qu'ils pourraient être catégorisés
2. **Tests dans src/** : Présence de fichiers test-*.ts qui devraient être dans tests/
3. **Fichiers compilés** : Présence de .js et .d.ts compilés dans tests/ (pollution)
4. **Nomenclature** : Mélange de conventions (.test.ts vs test-*.ts)

### Actions Recommandées

1. **Nettoyer les fichiers compilés** : Déplacer build vers un répertoire séparé
2. **Consolider les tests** : Déplacer tous les tests de src/ vers tests/
3. **Standardiser la nomenclature** : Utiliser uniquement *.test.ts
4. **Archiver les tests obsolètes** : Créer tests/archive/ pour les anciens tests
5. **Améliorer la catégorisation** : Utiliser tests/unit/, tests/integration/, tests/e2e/ de manière systématique

---

## 📋 Liste Complète des Fichiers

"@

# Table complète
$markdown += @"

| # | Chemin Complet | Tests | Suites | Taille | Modif | Statut |
|---|----------------|-------|--------|--------|-------|--------|

"@

$index = 1
foreach ($file in $results) {
    $statusEmoji = switch ($file.Status) {
        "ACTIF" { "✅" }
        "DÉSACTIVÉ" { "❌" }
        "VIDE" { "⚠️" }
        "TOUS_SKIP" { "⏭️" }
        default { "🕒" }
    }
    
    $markdown += "| $index | ``$($file.Path)`` | $($file.Tests) | $($file.Suites) | $($file.Size) KB | $($file.Modified) | $statusEmoji $($file.Status) |`n"
    $index++
}

$markdown += @"

---

**Fin du rapport d'audit**
"@

# Sauvegarder
$outputPath = Join-Path $ProjectRoot $OutputFile
$markdown | Out-File -FilePath $outputPath -Encoding UTF8 -Force

Write-Host ""
Write-Host "[SUCCESS] Rapport d'audit généré : $OutputFile" -ForegroundColor Green
Write-Host "[INFO] Fichiers analysés : $($results.Count)" -ForegroundColor Cyan
Write-Host "[INFO] Tests totaux : $totalTests" -ForegroundColor Cyan
Write-Host "[INFO] Suites totales : $totalSuites" -ForegroundColor Cyan
Write-Host ""