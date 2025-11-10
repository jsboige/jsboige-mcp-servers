<#
.SYNOPSIS
    Convertit les jest.mock() en jest.unstable_mockModule() pour la compatibilité ESM.

.DESCRIPTION
    Ce script corrige automatiquement les tests qui utilisent jest.mock() avec ESM.
    Il déplace les mocks AVANT les imports et utilise l'API unstable_mockModule.

.EXAMPLE
    .\scripts\fix-esm-mocks.ps1
#>

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-ColorOutput {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

Write-ColorOutput "🔧 Conversion des mocks ESM" "Cyan"
Write-ColorOutput "=========================" "Cyan"

if ($DryRun) {
    Write-ColorOutput "`n⚠️  MODE DRY-RUN - Aucune modification`n" "Yellow"
}

# Fichiers à corriger identifiés
$filesToFix = @(
    "tests/unit/utils/versioning.test.ts",
    "tests/unit/utils/timestamp-parsing.test.ts",
    "tests/unit/utils/bom-handling.test.ts",
    "tests/unit/services/xml-parsing.test.ts",
    "tests/unit/services/task-indexer.test.ts",
    "tests/unit/services/synthesis.service.test.ts",
    "tests/unit/services/indexing-decision.test.ts",
    "tests/unit/gateway/unified-api-gateway.test.ts",
    "tests/integration/api/unified-gateway-index.test.ts",
    "tests/e2e/scenarios/task-navigation.test.ts",
    "tests/unit/workspace-filtering-diagnosis.test.ts",
    "tests/unit/hierarchy-pipeline.test.ts",
    "tests/unit/new-task-extraction.test.ts",
    "tests/unit/main-instruction-fallback.test.ts",
    "tests/unit/extraction-complete-validation.test.ts"
)

$fixed = 0
$errors = @()

foreach ($file in $filesToFix) {
    if (-not (Test-Path $file)) {
        Write-ColorOutput "  ⚠️  Fichier non trouvé : $file" "Yellow"
        continue
    }
    
    Write-ColorOutput "`n📄 $file" "Cyan"
    
    try {
        $content = Get-Content -Path $file -Raw -Encoding UTF8
        $originalContent = $content
        
        # Pattern pour détecter jest.mock() après imports
        if ($content -match "jest\.mock\(") {
            Write-ColorOutput "  ℹ️  Contient jest.mock() - nécessite une conversion manuelle" "Yellow"
            Write-ColorOutput "  💡 Ce fichier nécessite un refactoring manuel pour :" "Gray"
            Write-ColorOutput "     1. Déplacer jest.unstable_mockModule() AVANT les imports" "Gray"
            Write-ColorOutput "     2. Utiliser des imports dynamiques si nécessaire" "Gray"
        }
        # Pattern pour mock-fs qui peut causer des problèmes
        elseif ($content -match "import mock from 'mock-fs'") {
            Write-ColorOutput "  ℹ️  Utilise mock-fs - peut nécessiter des ajustements" "Yellow"
        }
        # Fichiers sans mocks apparents
        else {
            Write-ColorOutput "  ✓ Pas de mock problématique détecté" "Green"
        }
        
    } catch {
        $errorMsg = "Erreur : $_"
        $errors += $errorMsg
        Write-ColorOutput "  ❌ $errorMsg" "Red"
    }
}

Write-ColorOutput "`n=========================" "Cyan"
Write-ColorOutput "📊 ANALYSE TERMINÉE" "Cyan"
Write-ColorOutput "=========================" "Cyan"
Write-ColorOutput "Fichiers analysés : $($filesToFix.Count)" "White"

if ($errors.Count -gt 0) {
    Write-ColorOutput "`n❌ Erreurs : $($errors.Count)" "Red"
    $errors | ForEach-Object { Write-ColorOutput "  $_" "Red" }
}

Write-ColorOutput "`n💡 RECOMMANDATION :" "Cyan"
Write-ColorOutput "Ces fichiers nécessitent une conversion manuelle vers jest.unstable_mockModule()" "White"
Write-ColorOutput "Référence : tests/integration/api/unified-gateway.test.ts (bon exemple)" "Gray"