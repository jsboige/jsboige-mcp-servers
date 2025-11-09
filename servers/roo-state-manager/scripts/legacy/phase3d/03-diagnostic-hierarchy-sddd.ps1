# Phase 3D - Diagnostic SDDD Précis des Tests Hierarchy
# Méthodologie SDDD : Single Direction, Deterministic, Debuggable

param(
    [string]$WorkspacePath = $PWD.Path,
    [switch]$Verbose = $false
)

# Configuration SDDD
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Fonctions SDDD
function Write-SdddLog {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    $color = switch ($Level) {
        "ERROR" { "Red" }
        "WARN" { "Yellow" }
        "SUCCESS" { "Green" }
        default { "White" }
    }
    Write-Host "[$timestamp] [SDDD-$Level] $Message" -ForegroundColor $color
}

function Invoke-SdddTest {
    param([string]$TestPattern, [string]$OutputFile)
    
    Write-SdddLog "Exécution des tests avec pattern: $TestPattern" "INFO"
    
    $testCommand = "npm test -- --reporter=verbose --testNamePattern=`"$TestPattern`" --no-coverage"
    Write-SdddLog "Commande: $testCommand" "INFO"
    
    try {
        $result = Invoke-Expression "$testCommand 2>&1" | Tee-Object -FilePath $OutputFile
        Write-SdddLog "Tests terminés. Résultat sauvegardé dans: $OutputFile" "SUCCESS"
        return $result
    }
    catch {
        Write-SdddLog "Erreur lors de l'exécution des tests: $($_.Exception.Message)" "ERROR"
        throw
    }
}

function Get-SdddTestAnalysis {
    param([string]$LogFile)
    
    Write-SdddLog "Analyse SDDD du fichier: $LogFile" "INFO"
    
    if (-not (Test-Path $LogFile)) {
        Write-SdddLog "Fichier de log non trouvé: $LogFile" "ERROR"
        throw "Fichier de log non trouvé"
    }
    
    $content = Get-Content $LogFile -Raw
    $lines = $content -split "`n"
    
    Write-SdddLog "=== DIAGNOSTIC SDDD ===" "INFO"
    
    # Extraire les informations structurées
    $testResults = @()
    $currentTest = $null
    $inErrorBlock = $false
    
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        
        # Début d'un test
        if ($line -match "●|FAIL") {
            if ($currentTest) {
                $testResults += $currentTest
            }
            
            $currentTest = @{
                Name = $line.Trim()
                LineNumber = $i + 1
                Errors = @()
                Stack = @()
                Context = @()
            }
            $inErrorBlock = $true
        }
        # Ligne d'erreur
        elseif ($inErrorBlock -and ($line -match "Error:|Cannot|expect")) {
            if ($currentTest) {
                $currentTest.Errors += @{
                    Line = $i + 1
                    Content = $line.Trim()
                }
            }
        }
        # Stack trace
        elseif ($inErrorBlock -and $line -match "at ") {
            if ($currentTest) {
                $currentTest.Stack += @{
                    Line = $i + 1
                    Content = $line.Trim()
                }
            }
        }
        # Fin du bloc d'erreur
        elseif ($inErrorBlock -and [string]::IsNullOrWhiteSpace($line.Trim())) {
            $inErrorBlock = $false
        }
    }
    
    if ($currentTest) {
        $testResults += $currentTest
    }
    
    Write-SdddLog "Total tests échouants: $($testResults.Count)" "INFO"
    
    # Analyse SDDD par catégorie
    $categories = @{
        'Fixture Loading' = @()
        'Hierarchy Reconstruction' = @()
        'Depth Calculation' = @()
        'Type Errors' = @()
        'Reference Errors' = @()
        'Other' = @()
    }
    
    foreach ($test in $testResults) {
        $errorText = ($test.Errors | ForEach-Object { $_.Content }) -join " "
        $errorText = $errorText.ToLower()
        
        if ($errorText -match "fixture|load|0 tâches") {
            $categories['Fixture Loading'] += $test
        }
        elseif ($errorText -match "hierarchy|reconstruction|parent") {
            $categories['Hierarchy Reconstruction'] += $test
        }
        elseif ($errorText -match "depth|profondeur|undefined") {
            $categories['Depth Calculation'] += $test
        }
        elseif ($errorText -match "typeerror") {
            $categories['Type Errors'] += $test
        }
        elseif ($errorText -match "referenceerror") {
            $categories['Reference Errors'] += $test
        }
        else {
            $categories['Other'] += $test
        }
    }
    
    Write-SdddLog "=== CATÉGORIES SDDD ===" "INFO"
    foreach ($cat in $categories.Keys) {
        $tests = $categories[$cat]
        if ($tests.Count -gt 0) {
            Write-SdddLog "$cat`: $($tests.Count) tests" "INFO"
            foreach ($test in $tests) {
                Write-SdddLog "  ❌ $($test.Name)" "WARN"
                if ($test.Errors.Count -gt 0) {
                    $errorMsg = $test.Errors[0].Content
                    if ($errorMsg.Length -gt 100) {
                        $errorMsg = $errorMsg.Substring(0, 100) + "..."
                    }
                    Write-SdddLog "     Erreur: $errorMsg" "WARN"
                }
            }
        }
    }
    
    # Créer l'objet d'analyse SDDD
    $analysis = @{
        timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        totalFailed = $testResults.Count
        categories = $categories
        tests = $testResults
    }
    
    # Sauvegarder analyse SDDD
    $analysisFile = "hierarchy-sddd-analysis.json"
    $analysis | ConvertTo-Json -Depth 10 | Out-File -FilePath $analysisFile -Encoding UTF8
    Write-SdddLog "Analyse SDDD sauvegardée dans: $analysisFile" "SUCCESS"
    
    return $analysis
}

function Test-SdddFixtures {
    Write-SdddLog "Audit des fixtures SDDD" "INFO"
    
    # Vérifier l'existence des fixtures
    $fixtureFiles = @()
    Get-ChildItem -Path "tests" -Recurse -File | Where-Object {
        $_.Name -match "fixture|data" -and $_.Name -match "hierarchy"
    } | ForEach-Object {
        $fixtureFiles += $_.FullName
    }
    
    Write-SdddLog "Fichiers de fixtures trouvés: $($fixtureFiles.Count)" "INFO"
    foreach ($file in $fixtureFiles) {
        Write-SdddLog "  - $file" "INFO"
    }
    
    # Examiner le contenu des fixtures
    $testFiles = @(
        "tests/unit/services/controlled-hierarchy-reconstruction.test.ts",
        "tests/unit/services/hierarchy-real-data.test.ts",
        "tests/unit/services/hierarchy-reconstruction-engine.test.ts"
    )
    
    foreach ($testFile in $testFiles) {
        if (Test-Path $testFile) {
            Write-SdddLog "=== Analyse du fichier: $testFile ===" "INFO"
            $content = Get-Content $testFile -Raw
            
            # Rechercher les patterns de fixture loading
            $loadPatterns = @(
                "vi\.mock\(.*fs.*\}",
                "beforeEach.*?fixture",
                "readFile.*?fixture",
                "load.*?data"
            )
            
            foreach ($pattern in $loadPatterns) {
                if ($content -match $pattern) {
                    Write-SdddLog "Pattern trouvé: $($pattern.Substring(0, 100))..." "INFO"
                }
            }
        }
    }
}

# Script principal SDDD
try {
    Write-SdddLog "=== DÉBUT DU DIAGNOSTIC SDDD HIERARCHY ===" "SUCCESS"
    Write-SdddLog "Workspace: $WorkspacePath" "INFO"
    Write-SdddLog "Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')" "INFO"
    
    # Étape 1: Exécuter les tests hierarchy
    Write-SdddLog "ÉTAPE 1: Exécution des tests hierarchy" "INFO"
    $testOutput = Invoke-SdddTest -TestPattern "hierarchy" -OutputFile "hierarchy-sddd-verbose.txt"
    
    # Étape 2: Analyser les résultats
    Write-SdddLog "ÉTAPE 2: Analyse des résultats SDDD" "INFO"
    $analysis = Get-SdddTestAnalysis -LogFile "hierarchy-sddd-verbose.txt"
    
    # Étape 3: Audit des fixtures
    Write-SdddLog "ÉTAPE 3: Audit des fixtures SDDD" "INFO"
    Test-SdddFixtures
    
    # Étape 4: Résumé SDDD
    Write-SdddLog "=== RÉSUMÉ SDDD ===" "SUCCESS"
    Write-SdddLog "Tests échouants: $($analysis.totalFailed)" "INFO"
    Write-SdddLog "Catégories identifiées: $($analysis.categories.Keys.Count)" "INFO"
    
    $totalIssues = 0
    foreach ($cat in $analysis.categories.Keys) {
        $count = $analysis.categories[$cat].Count
        if ($count -gt 0) {
            Write-SdddLog "$cat`: $count tests" "WARN"
            $totalIssues += $count
        }
    }
    
    Write-SdddLog "Total problèmes identifiés: $totalIssues" "INFO"
    
    if ($totalIssues -eq 0) {
        Write-SdddLog "✅ Aucun problème détecté (SDDD)" "SUCCESS"
    } else {
        Write-SdddLog "⚠️ Problèmes détectés, correction nécessaire" "WARN"
    }
    
    Write-SdddLog "=== DIAGNOSTIC SDDD TERMINÉ ===" "SUCCESS"
    
    # Exporter les résultats pour la suite
    $analysis | ConvertTo-Json -Depth 10 | Out-File -FilePath "hierarchy-sddd-results.json" -Encoding UTF8
    
}
catch {
    Write-SdddLog "Erreur critique dans le diagnostic SDDD: $($_.Exception.Message)" "ERROR"
    Write-SdddLog "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    exit 1
}