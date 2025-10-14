# Script d'Analyse de Consolidation - Phase 1
# Date: 2025-10-14
# Objectif: Analyser l'architecture pour identifier les redondances

$ErrorActionPreference = "Stop"
$rootPath = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $rootPath "src"
$outputPath = $PSScriptRoot

Write-Host "=== ANALYSE DE CONSOLIDATION - PHASE 1 ===" -ForegroundColor Cyan
Write-Host "Repertoire source: $srcPath" -ForegroundColor Gray
Write-Host "Repertoire sortie: $outputPath" -ForegroundColor Gray
Write-Host ""

# ============================================
# 1. METRIQUES GLOBALES
# ============================================
Write-Host "[1/6] Collecte des metriques globales..." -ForegroundColor Yellow

$allTsFiles = Get-ChildItem -Path $srcPath -Filter *.ts -Recurse -File | 
    Where-Object { 
        $_.Name -notmatch '\.d\.ts$' -and 
        $_.Name -notmatch '\.test\.ts$' -and
        $_.Name -notmatch '\.spec\.ts$'
    }

$totalFiles = $allTsFiles.Count
$totalLines = ($allTsFiles | Get-Content | Measure-Object -Line).Lines

Write-Host "  OK Fichiers TypeScript: $totalFiles" -ForegroundColor Green
Write-Host "  OK Lignes de code: $totalLines" -ForegroundColor Green

# ============================================
# 2. ANALYSE PAR MODULE
# ============================================
Write-Host "`n[2/6] Analyse par module..." -ForegroundColor Yellow

$moduleStats = @()
$directories = @("tools", "services", "utils", "types", "config", "models", "gateway", "interfaces", "validation")

foreach ($dir in $directories) {
    $dirPath = Join-Path $srcPath $dir
    if (Test-Path $dirPath) {
        $files = Get-ChildItem -Path $dirPath -Filter *.ts -Recurse -File | 
            Where-Object { $_.Name -notmatch '\.d\.ts$' -and $_.Name -notmatch '\.test\.ts$' }
        $fileCount = $files.Count
        $lineCount = if ($fileCount -gt 0) { ($files | Get-Content | Measure-Object -Line).Lines } else { 0 }
        
        $moduleStats += [PSCustomObject]@{
            Module = $dir
            Files = $fileCount
            Lines = $lineCount
            AvgLinesPerFile = if ($fileCount -gt 0) { [math]::Round($lineCount / $fileCount, 0) } else { 0 }
        }
        
        Write-Host "  OK $dir : $fileCount fichiers, $lineCount lignes" -ForegroundColor Green
    }
}

# ============================================
# 3. PATTERNS COMMUNS - GESTION D'ERREUR
# ============================================
Write-Host "`n[3/6] Identification des patterns de gestion d'erreur..." -ForegroundColor Yellow

$errorPatterns = @{}
$errorPatterns["isError_true"] = 0
$errorPatterns["CallToolResult"] = 0
$errorPatterns["try_block"] = 0
$errorPatterns["catch_block"] = 0
$errorPatterns["throw_error"] = 0

$toolsPath = Join-Path $srcPath "tools"
$toolsFiles = Get-ChildItem -Path $toolsPath -Filter *.ts -Recurse -File

foreach ($file in $toolsFiles) {
    $content = Get-Content $file.FullName -Raw
    
    $errorPatterns["isError_true"] += ([regex]::Matches($content, "isError:\s*true")).Count
    $errorPatterns["CallToolResult"] += ([regex]::Matches($content, "CallToolResult")).Count
    $errorPatterns["try_block"] += ([regex]::Matches($content, "try\s*\{")).Count
    $errorPatterns["catch_block"] += ([regex]::Matches($content, "catch\s*[\(\{]")).Count
    $errorPatterns["throw_error"] += ([regex]::Matches($content, "throw new Error")).Count
}

Write-Host "  Pattern 'isError: true': $($errorPatterns['isError_true']) occurrences" -ForegroundColor Cyan
Write-Host "  Pattern 'CallToolResult': $($errorPatterns['CallToolResult']) occurrences" -ForegroundColor Cyan
Write-Host "  Pattern 'try': $($errorPatterns['try_block']) blocs" -ForegroundColor Cyan
Write-Host "  Pattern 'catch': $($errorPatterns['catch_block']) blocs" -ForegroundColor Cyan
Write-Host "  Pattern 'throw new Error': $($errorPatterns['throw_error']) occurrences" -ForegroundColor Cyan

# ============================================
# 4. PATTERNS COMMUNS - FORMATAGE
# ============================================
Write-Host "`n[4/6] Identification des patterns de formatage..." -ForegroundColor Yellow

$formatPatterns = @{}
$formatPatterns["JSON_stringify"] = 0
$formatPatterns["map_method"] = 0
$formatPatterns["filter_method"] = 0
$formatPatterns["content_array"] = 0

foreach ($file in $toolsFiles) {
    $content = Get-Content $file.FullName -Raw
    
    $formatPatterns["JSON_stringify"] += ([regex]::Matches($content, "JSON\.stringify")).Count
    $formatPatterns["map_method"] += ([regex]::Matches($content, "\.map\(")).Count
    $formatPatterns["filter_method"] += ([regex]::Matches($content, "\.filter\(")).Count
    $formatPatterns["content_array"] += ([regex]::Matches($content, "content:\s*\[\{")).Count
}

Write-Host "  Pattern 'JSON.stringify': $($formatPatterns['JSON_stringify']) occurrences" -ForegroundColor Cyan
Write-Host "  Pattern '.map(': $($formatPatterns['map_method']) occurrences" -ForegroundColor Cyan
Write-Host "  Pattern '.filter(': $($formatPatterns['filter_method']) occurrences" -ForegroundColor Cyan
Write-Host "  Pattern 'content: [{': $($formatPatterns['content_array']) occurrences" -ForegroundColor Cyan

# ============================================
# 5. ANALYSE DES IMPORTS
# ============================================
Write-Host "`n[5/6] Analyse des imports communs..." -ForegroundColor Yellow

$imports = @{}

foreach ($file in $allTsFiles) {
    $lines = Get-Content $file.FullName
    foreach ($line in $lines) {
        if ($line -match "^import .* from ['`"](.*)['`"]") {
            $importPath = $matches[1]
            if ($imports.ContainsKey($importPath)) {
                $imports[$importPath]++
            } else {
                $imports[$importPath] = 1
            }
        }
    }
}

$topImports = $imports.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 15

Write-Host "  Top 15 imports les plus utilises:" -ForegroundColor Cyan
foreach ($import in $topImports) {
    Write-Host "    - $($import.Key): $($import.Value) fois" -ForegroundColor Gray
}

# ============================================
# 6. GENERATION DU RAPPORT JSON
# ============================================
Write-Host "`n[6/6] Generation du rapport JSON..." -ForegroundColor Yellow

$report = @{
    timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    summary = @{
        totalFiles = $totalFiles
        totalLines = $totalLines
        avgLinesPerFile = [math]::Round($totalLines / $totalFiles, 0)
    }
    modules = $moduleStats
    patterns = @{
        errorHandling = $errorPatterns
        formatting = $formatPatterns
    }
    topImports = $topImports | ForEach-Object { 
        @{
            path = $_.Key
            count = $_.Value
        }
    }
    estimatedImpact = @{
        errorLinesFactorizable = [math]::Round($errorPatterns['isError_true'] * 3, 0)
        formatLinesFactorizable = [math]::Round($formatPatterns['JSON_stringify'] * 2, 0)
        totalFactorizableLines = [math]::Round(($errorPatterns['isError_true'] * 3) + ($formatPatterns['JSON_stringify'] * 2), 0)
        reductionPercentage = [math]::Round((($errorPatterns['isError_true'] * 3) + ($formatPatterns['JSON_stringify'] * 2)) / $totalLines * 100, 1)
        filesImpacted = [math]::Round($totalFiles * 0.4, 0)
    }
}

$jsonPath = Join-Path $outputPath "analysis-report.json"
$report | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

Write-Host "  OK Rapport JSON genere: $jsonPath" -ForegroundColor Green

# ============================================
# RESUME FINAL
# ============================================
Write-Host ""
Write-Host "=== ANALYSE COMPLETE ===" -ForegroundColor Green
Write-Host ""
Write-Host "Fichier genere:" -ForegroundColor Cyan
Write-Host "  - $jsonPath" -ForegroundColor Gray
Write-Host ""
Write-Host "Metriques cles:" -ForegroundColor Cyan
Write-Host "  - $totalFiles fichiers TypeScript" -ForegroundColor Gray
Write-Host "  - $totalLines lignes de code" -ForegroundColor Gray
Write-Host "  - ~$($report.estimatedImpact.reductionPercentage)% de code potentiellement factorizable" -ForegroundColor Gray
Write-Host "  - ~$($report.estimatedImpact.totalFactorizableLines) lignes factorisables" -ForegroundColor Gray
Write-Host ""
Write-Host "Prochaines etapes:" -ForegroundColor Yellow
Write-Host "  1. Executer '02-generate-markdown.ps1' pour le rapport Markdown" -ForegroundColor Gray
Write-Host "  2. Analyser les dependances avec madge (script 03)" -ForegroundColor Gray