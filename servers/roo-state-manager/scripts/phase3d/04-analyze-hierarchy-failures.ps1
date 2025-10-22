# Phase 3D - Analyse SDDD des Échecs Hierarchy
# Analyse des 2 tests échouants et préparation des corrections

param(
    [string]$WorkspacePath = $PWD.Path
)

# Configuration SDDD
$ErrorActionPreference = "Stop"

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

function Get-HierarchyTestFailures {
    Write-SdddLog "=== ANALYSE SDDD DES ÉCHECS HIERARCHY ===" "SUCCESS"
    
    # Analyser les fichiers de test échouants
    $failedTests = @(
        @{
            File = "tests/unit/utils/controlled-hierarchy-reconstruction.test.ts"
            Test = "should export non-flat markdown with correct hierarchy depths"
            Line = 370
            Expected = 1
            Received = "undefined"
            Issue = "depthCounts[0] undefined"
        },
        @{
            File = "tests/integration/hierarchy-real-data.test.ts"
            Test = "should build correct depth hierarchy"
            Line = 138
            Expected = 0
            Received = "undefined"
            Issue = "depths[ROOT] undefined"
        }
    )
    
    Write-SdddLog "Tests échouants identifiés: $($failedTests.Count)" "WARN"
    
    foreach ($test in $failedTests) {
        Write-SdddLog "❌ $($test.File)" "WARN"
        Write-SdddLog "   Test: $($test.Test)" "WARN"
        Write-SdddLog "   Ligne: $($test.Line)" "WARN"
        Write-SdddLog "   Attendu: $($test.Expected)" "WARN"
        Write-SdddLog "   Reçu: $($test.Received)" "WARN"
        Write-SdddLog "   Problème: $($test.Issue)" "WARN"
        Write-SdddLog "" "INFO"
    }
    
    return $failedTests
}

function Test-FixtureLoading {
    Write-SdddLog "=== DIAGNOSTIC SDDD FIXTURE LOADING ===" "INFO"
    
    # Vérifier les fichiers de test et leur chargement
    $testFiles = @(
        "tests/unit/utils/controlled-hierarchy-reconstruction.test.ts",
        "tests/integration/hierarchy-real-data.test.ts"
    )
    
    foreach ($testFile in $testFiles) {
        Write-SdddLog "Analyse du fichier: $testFile" "INFO"
        
        if (Test-Path $testFile) {
            $content = Get-Content $testFile -Raw
            
            # Rechercher les patterns de chargement
            $loadPatterns = @(
                "loadControlledDataset",
                "buildSkeletonCache",
                "0 tâches",
                "Données de test"
            )
            
            foreach ($pattern in $loadPatterns) {
                if ($content -match $pattern) {
                    Write-SdddLog "  ✓ Pattern trouvé: $pattern" "SUCCESS"
                }
            }
            
            # Vérifier les mocks
            if ($content -match "vi\.mock") {
                Write-SdddLog "  ✓ Mock détecté" "SUCCESS"
            } else {
                Write-SdddLog "  ❌ Aucun mock détecté" "WARN"
            }
        } else {
            Write-SdddLog "  ❌ Fichier non trouvé" "ERROR"
        }
    }
}

function Get-HierarchyEngineAnalysis {
    Write-SdddLog "=== ANALYSE SDDD HIERARCHY ENGINE ===" "INFO"
    
    $engineFile = "src/utils/hierarchy-reconstruction-engine.ts"
    
    if (Test-Path $engineFile) {
        $content = Get-Content $engineFile -Raw
        
        # Analyser les méthodes critiques
        $methods = @(
            "parseInstructions",
            "buildTaskTree", 
            "calculateDepths",
            "exportMarkdown"
        )
        
        foreach ($method in $methods) {
            if ($content -match "function $method\(`$|async $method\(`$|$method\(`$") {
                Write-SdddLog "  ✓ Méthode trouvée: $method" "SUCCESS"
            } else {
                Write-SdddLog "  ❌ Méthode manquante: $method" "ERROR"
            }
        }
        
        # Vérifier les imports problématiques
        if ($content -match "import \* as fs from 'fs'") {
            Write-SdddLog "  ⚠️ Import fs détecté (problème de mock)" "WARN"
        }
        
        if ($content -match "import \* as path from 'path'") {
            Write-SdddLog "  ⚠️ Import path détecté" "WARN"
        }
    } else {
        Write-SdddLog "  ❌ Fichier engine non trouvé" "ERROR"
    }
}

# Script principal SDDD
try {
    Write-SdddLog "Démarrage de l'analyse SDDD des échecs hierarchy" "SUCCESS"
    
    # Étape 1: Analyser les tests échouants
    $failures = Get-HierarchyTestFailures
    
    # Étape 2: Diagnostic fixture loading
    Test-FixtureLoading
    
    # Étape 3: Analyse hierarchy engine
    Get-HierarchyEngineAnalysis
    
    # Étape 4: Créer le plan de correction SDDD
    Write-SdddLog "=== PLAN DE CORRECTION SDDD ===" "SUCCESS"
    
    $correctionPlan = @{
        "Step 1" = "Corriger le mock filesystem dans les tests d'intégration"
        "Step 2" = "Corriger le chargement des fixtures de données contrôlées"
        "Step 3" = "Corriger le calcul des profondeurs dans HierarchyEngine"
        "Step 4" = "Valider les corrections avec tests progressifs"
    }
    
    foreach ($step in $correctionPlan.Keys) {
        Write-SdddLog "$step : $($correctionPlan[$step])" "INFO"
    }
    
    # Sauvegarder l'analyse
    $analysis = @{
        timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        failedTests = $failures
        correctionPlan = $correctionPlan
        nextSteps = @(
            "Correction mock filesystem",
            "Correction fixture loading", 
            "Correction depth calculation",
            "Validation SDDD"
        )
    }
    
    $analysis | ConvertTo-Json -Depth 10 | Out-File -FilePath "hierarchy-sddd-failures-analysis.json" -Encoding UTF8
    Write-SdddLog "Analyse sauvegardée dans: hierarchy-sddd-failures-analysis.json" "SUCCESS"
    
    Write-SdddLog "=== ANALYSE SDDD TERMINÉE ===" "SUCCESS"
}
catch {
    Write-SdddLog "Erreur critique: $($_.Exception.Message)" "ERROR"
    exit 1
}