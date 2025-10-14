# Script d'Analyse des Dependances - Phase 1b
# Date: 2025-10-14
# Objectif: Analyser les dependances avec madge

$ErrorActionPreference = "Stop"
$rootPath = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $rootPath "src"
$outputPath = $PSScriptRoot

Write-Host "=== ANALYSE DES DEPENDANCES - MADGE ===" -ForegroundColor Cyan
Write-Host "Repertoire source: $srcPath" -ForegroundColor Gray
Write-Host "Repertoire sortie: $outputPath" -ForegroundColor Gray
Write-Host ""

# ============================================
# 1. VERIFICATION MADGE
# ============================================
Write-Host "[1/5] Verification installation madge..." -ForegroundColor Yellow

try {
    $madgeVersion = npx madge --version 2>&1
    Write-Host "  OK madge installe: $madgeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERREUR: madge non disponible" -ForegroundColor Red
    Write-Host "  Installez avec: npm install --save-dev madge" -ForegroundColor Yellow
    exit 1
}

# ============================================
# 2. DETECTION IMPORTS CIRCULAIRES
# ============================================
Write-Host "`n[2/5] Detection des imports circulaires..." -ForegroundColor Yellow

$circularFile = Join-Path $outputPath "circular-dependencies.txt"

Push-Location $rootPath
try {
    $circularOutput = npx madge --circular --extensions ts src/ 2>&1 | Out-String
    $circularOutput | Set-Content -Path $circularFile -Encoding UTF8
    
    if ($circularOutput -match "No circular dependency found") {
        Write-Host "  OK Aucune dependance circulaire detectee" -ForegroundColor Green
        $circularCount = 0
    } else {
        $circularLines = ($circularOutput -split "`n" | Where-Object { $_ -match "->" }).Count
        Write-Host "  ATTENTION: $circularLines dependances circulaires detectees" -ForegroundColor Yellow
        Write-Host "  Voir: $circularFile" -ForegroundColor Gray
        $circularCount = $circularLines
    }
} catch {
    Write-Host "  ERREUR lors de l'analyse: $_" -ForegroundColor Red
    $circularCount = -1
} finally {
    Pop-Location
}

# ============================================
# 3. GENERATION GRAPHE JSON
# ============================================
Write-Host "`n[3/5] Generation du graphe de dependances JSON..." -ForegroundColor Yellow

$jsonFile = Join-Path $outputPath "dependencies.json"

Push-Location $rootPath
try {
    npx madge --json src/ | Out-File -FilePath $jsonFile -Encoding UTF8
    Write-Host "  OK Graphe JSON genere: $jsonFile" -ForegroundColor Green
    
    # Analyser la taille du graphe
    $jsonContent = Get-Content $jsonFile -Raw | ConvertFrom-Json
    $moduleCount = ($jsonContent.PSObject.Properties).Count
    Write-Host "  Modules analyses: $moduleCount" -ForegroundColor Cyan
} catch {
    Write-Host "  ERREUR lors de la generation JSON: $_" -ForegroundColor Red
} finally {
    Pop-Location
}

# ============================================
# 4. GENERATION GRAPHE SVG (optionnel)
# ============================================
Write-Host "`n[4/5] Generation du graphe SVG (peut prendre du temps)..." -ForegroundColor Yellow

$svgFile = Join-Path $outputPath "dependencies.svg"

Push-Location $rootPath
try {
    # Limiter aux modules principaux pour eviter graphe trop large
    Write-Host "  Generation en cours..." -ForegroundColor Gray
    npx madge --image $svgFile src/ 2>&1 | Out-Null
    
    if (Test-Path $svgFile) {
        $svgSize = (Get-Item $svgFile).Length / 1KB
        Write-Host "  OK Graphe SVG genere: $svgFile ($([math]::Round($svgSize, 1)) KB)" -ForegroundColor Green
    } else {
        Write-Host "  ATTENTION: Graphe SVG non genere (graphe trop large?)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ATTENTION: Impossible de generer le SVG (graphe trop complexe)" -ForegroundColor Yellow
} finally {
    Pop-Location
}

# ============================================
# 5. ANALYSE MODULES HAUTEMENT COUPLES
# ============================================
Write-Host "`n[5/5] Analyse des modules hautement couples..." -ForegroundColor Yellow

if (Test-Path $jsonFile) {
    $dependencies = Get-Content $jsonFile -Raw | ConvertFrom-Json
    
    # Compter les dependances entrantes pour chaque module
    $incomingDeps = @{}
    
    foreach ($module in $dependencies.PSObject.Properties) {
        $moduleName = $module.Name
        $deps = $module.Value
        
        foreach ($dep in $deps) {
            if (-not $incomingDeps.ContainsKey($dep)) {
                $incomingDeps[$dep] = 0
            }
            $incomingDeps[$dep]++
        }
    }
    
    # Top 10 modules les plus dependus
    $topDependencies = $incomingDeps.GetEnumerator() | 
        Sort-Object -Property Value -Descending | 
        Select-Object -First 10
    
    Write-Host "  Top 10 modules les plus utilises:" -ForegroundColor Cyan
    foreach ($dep in $topDependencies) {
        Write-Host "    - $($dep.Key): $($dep.Value) dependances entrantes" -ForegroundColor Gray
    }
    
    # Identifier modules hautement couples (> 10 dependances)
    $highlyCoupled = $incomingDeps.GetEnumerator() | 
        Where-Object { $_.Value -gt 10 } | 
        Sort-Object -Property Value -Descending
    
    if ($highlyCoupled) {
        Write-Host "`n  ATTENTION: $($highlyCoupled.Count) modules hautement couples (>10 deps):" -ForegroundColor Yellow
        foreach ($module in $highlyCoupled) {
            Write-Host "    - $($module.Key): $($module.Value) dependances" -ForegroundColor Yellow
        }
    } else {
        Write-Host "`n  OK Aucun module hautement couple detecte" -ForegroundColor Green
    }
}

# ============================================
# 6. GENERATION RAPPORT JSON
# ============================================
Write-Host "`n[6/6] Generation du rapport d'analyse dependances..." -ForegroundColor Yellow

$report = @{
    timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    circularDependencies = @{
        count = $circularCount
        found = $circularCount -gt 0
        file = if ($circularCount -gt 0) { $circularFile } else { $null }
    }
    dependencyGraph = @{
        modulesAnalyzed = if ($moduleCount) { $moduleCount } else { 0 }
        jsonFile = $jsonFile
        svgFile = if (Test-Path $svgFile) { $svgFile } else { $null }
    }
    highlyCoupledModules = if ($highlyCoupled) {
        $highlyCoupled | ForEach-Object {
            @{
                module = $_.Key
                incomingDependencies = $_.Value
            }
        }
    } else { @() }
    topDependencies = if ($topDependencies) {
        $topDependencies | ForEach-Object {
            @{
                module = $_.Key
                incomingDependencies = $_.Value
            }
        }
    } else { @() }
}

$reportFile = Join-Path $outputPath "dependencies-report.json"
$report | ConvertTo-Json -Depth 10 | Set-Content -Path $reportFile -Encoding UTF8

Write-Host "  OK Rapport genere: $reportFile" -ForegroundColor Green

# ============================================
# RESUME FINAL
# ============================================
Write-Host ""
Write-Host "=== ANALYSE DEPENDANCES COMPLETE ===" -ForegroundColor Green
Write-Host ""
Write-Host "Fichiers generes:" -ForegroundColor Cyan
Write-Host "  - $reportFile" -ForegroundColor Gray
Write-Host "  - $jsonFile" -ForegroundColor Gray
if (Test-Path $svgFile) {
    Write-Host "  - $svgFile" -ForegroundColor Gray
}
if ($circularCount -gt 0) {
    Write-Host "  - $circularFile" -ForegroundColor Gray
}
Write-Host ""
Write-Host "Resultats:" -ForegroundColor Cyan
Write-Host "  - Modules analyses: $moduleCount" -ForegroundColor Gray
Write-Host "  - Dependances circulaires: $circularCount" -ForegroundColor $(if ($circularCount -eq 0) { "Green" } else { "Yellow" })
Write-Host "  - Modules hautement couples: $($highlyCoupled.Count)" -ForegroundColor $(if ($highlyCoupled.Count -eq 0) { "Green" } else { "Yellow" })
Write-Host ""
Write-Host "Prochaine etape: Consolider les rapports et commiter" -ForegroundColor Yellow