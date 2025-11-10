# Phase 3D SDDD - Diagnostic du Prefix Matching (Version Simplifiée)
# Date: 2025-10-19
# Objectif: Analyser pourquoi searchExactPrefix ne trouve pas de correspondances

param(
    [string]$OutputDir = "output/$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [switch]$SkipTests = $false
)

# Configuration SDDD
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Write-Host "🔍 Phase 3D SDDD - Diagnostic du Prefix Matching" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

# Créer le répertoire de sortie
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$LogFile = "$OutputDir/prefix-matching-sddd.log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogEntry = "[$Timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $LogEntry
    Write-Host $LogEntry
}

Write-Log "Début du diagnostic SDDD du prefix matching"

# ÉTAPE 1: Analyser les fixtures de test
Write-Log "ÉTAPE 1: Analyse des fixtures de test controlled-hierarchy"

$FixtureFile = "tests/unit/utils/controlled-hierarchy-reconstruction.test.ts"
if (Test-Path $FixtureFile) {
    $FixtureContent = Get-Content $FixtureFile -Raw
    Write-Log "Fichier de fixture trouvé: $FixtureFile"
    
    # Sauvegarder le contenu brut pour analyse
    $FixtureContent | Out-File "$OutputDir/fixture-content-raw.txt"
    
    # Extraire les données de test avec une approche plus simple
    $TestData = @()
    $TestLines = Get-Content $FixtureFile
    
    $CurrentTest = $null
    $InTestData = $false
    
    foreach ($Line in $TestLines) {
        if ($Line -match "testData\.push") {
            $InTestData = $true
            $CurrentTest = @{
                taskId = ""
                parentTaskId = ""
                title = ""
                truncatedInstruction = ""
            }
        }
        elseif ($InTestData -and $Line -match "taskId:") {
            $Pattern = "taskId:\s*'([^']*)'"
            if ($Line -match $Pattern) {
                $CurrentTest.taskId = $matches[1]
            }
        }
        elseif ($InTestData -and $Line -match "parentTaskId:") {
            $Pattern = "parentTaskId:\s*'([^']*)'"
            if ($Line -match $Pattern) {
                $CurrentTest.parentTaskId = $matches[1]
            }
        }
        elseif ($InTestData -and $Line -match "title:") {
            $Pattern = "title:\s*'([^']*)'"
            if ($Line -match $Pattern) {
                $CurrentTest.title = $matches[1]
            }
        }
        elseif ($InTestData -and $Line -match "truncatedInstruction:") {
            $Pattern = "truncatedInstruction:\s*'([^']*)'"
            if ($Line -match $Pattern) {
                $CurrentTest.truncatedInstruction = $matches[1]
            }
        }
        elseif ($InTestData -and $Line -match "\);") {
            $InTestData = $false
            if ($CurrentTest.taskId) {
                $TestData += $CurrentTest
                Write-Log "Test extrait: $($CurrentTest.taskId)"
            }
        }
    }
    
    Write-Log "Trouvé $($TestData.Count) entrées de test"
    
    # Analyser les relations parent-enfant attendues
    $ExpectedRelations = @()
    foreach ($Test in $TestData) {
        if ($Test.parentTaskId -and $Test.parentTaskId -ne "null") {
            $ExpectedRelations += @{
                ChildId = $Test.taskId
                ChildTitle = $Test.title
                ChildInstruction = $Test.truncatedInstruction
                ParentId = $Test.parentTaskId
            }
        }
    }
    
    Write-Log "Relations parent-enfant attendues: $($ExpectedRelations.Count)"
    
    # Sauvegarder l'analyse des fixtures
    $FixtureAnalysis = @{
        timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        totalTests = $TestData.Count
        expectedRelationsCount = $ExpectedRelations.Count
        testData = $TestData
        expectedRelations = $ExpectedRelations
    }
    
    $FixtureAnalysis | ConvertTo-Json -Depth 10 | Out-File "$OutputDir/fixture-analysis.json"
    Write-Log "Analyse des fixtures sauvegardée dans fixture-analysis.json"
}

# ÉTAPE 2: Exécuter le test avec debug SDDD
Write-Log "ÉTAPE 2: Exécution du test avec debug SDDD"

if (-not $SkipTests) {
    try {
        Write-Log "Exécution du test avec ROO_DEBUG_INSTRUCTIONS=1"
        $env:ROO_DEBUG_INSTRUCTIONS = "1"
        
        $TestCommand = "npm test -- --testNamePattern=`"should reconstruct 100% of parent-child relationships`" --reporter=verbose --no-coverage"
        Write-Log "Commande: $TestCommand"
        
        $TestOutput = Invoke-Expression $TestCommand 2>&1
        $TestOutput | Out-File "$OutputDir/test-output-verbose.txt"
        
        # Extraire les logs SDDD
        $SDDDLines = @()
        foreach ($Line in $TestOutput) {
            if ($Line -match "SDDD:" -or $Line -match "EXACT PREFIX SEARCH") {
                $SDDDLines += $Line
            }
        }
        $SDDDLines | Out-File "$OutputDir/sddd-logs.txt"
        
        Write-Log "Test exécuté, $($SDDDLines.Count) logs SDDD extraits"
        
        # Analyser les logs SDDD
        $PrefixAnalysis = @{
            indexedPrefixes = @()
            childInstructions = @()
            searchAttempts = @()
        }
        
        foreach ($Line in $SDDDLines) {
            # Utiliser des patterns plus simples
            if ($Line -match 'prefix="([^"]+)"') {
                $PrefixAnalysis.indexedPrefixes += $matches[1]
                Write-Log "Préfixe indexé: $($matches[1])"
            }
            if ($Line -match 'Child truncated instruction: "([^"]+)"') {
                $PrefixAnalysis.childInstructions += $matches[1]
                Write-Log "Instruction enfant: $($matches[1])"
            }
            if ($Line -match 'Trying prefix length (\d+): "([^"]+)"') {
                $PrefixAnalysis.searchAttempts += @{
                    length = [int]$matches[1]
                    prefix = $matches[2]
                }
                Write-Log "Tentative de recherche: longueur=$($matches[1]), préfixe=$($matches[2])"
            }
        }
        
        $PrefixAnalysis | ConvertTo-Json -Depth 10 | Out-File "$OutputDir/prefix-analysis.json"
        Write-Log "Analyse des préfixes sauvegardée dans prefix-analysis.json"
        
        # Nettoyer l'environnement
        Remove-Item env:ROO_DEBUG_INSTRUCTIONS -ErrorAction SilentlyContinue
        
    } catch {
        Write-Log "Erreur lors de l'exécution du test: $($_.Exception.Message)" -Level "ERROR"
        $TestOutput = $_.Exception.Message
        $TestOutput | Out-File "$OutputDir/test-error.txt"
        
        # Nettoyer l'environnement
        Remove-Item env:ROO_DEBUG_INSTRUCTIONS -ErrorAction SilentlyContinue
    }
}

# ÉTAPE 3: Analyse comparative SDDD
Write-Log "ÉTAPE 3: Analyse comparative SDDD"

if (Test-Path "$OutputDir/prefix-analysis.json") {
    $PrefixData = Get-Content "$OutputDir/prefix-analysis.json" | ConvertFrom-Json
    $FixtureData = Get-Content "$OutputDir/fixture-analysis.json" | ConvertFrom-Json
    
    $ComparativeAnalysis = @{
        mismatchAnalysis = @()
        potentialMatches = @()
        recommendations = @()
    }
    
    # Analyser chaque instruction enfant contre les préfixes indexés
    foreach ($Child in $PrefixData.childInstructions) {
        $ChildAnalysis = @{
            childInstruction = $Child
            childPrefix = ""
            potentialParents = @()
            matchingIssues = @()
        }
        
        # Générer le préfixe de l'enfant (même logique que searchExactPrefix)
        if ($Child.Length -gt 192) {
            $ChildAnalysis.childPrefix = $Child.Substring(0, 192)
        } else {
            $ChildAnalysis.childPrefix = $Child
        }
        
        Write-Log "Analyse de l'instruction enfant: $($ChildAnalysis.childPrefix)"
        
        # Chercher des correspondances potentielles
        foreach ($IndexedPrefix in $PrefixData.indexedPrefixes) {
            $Similarity = 0
            $Reason = ""
            
            if ($ChildAnalysis.childPrefix.StartsWith($IndexedPrefix)) {
                $Similarity = 100
                $Reason = "Exact prefix match"
            } elseif ($IndexedPrefix.Length -gt 0 -and $ChildAnalysis.childPrefix.StartsWith($IndexedPrefix.Substring(0, [Math]::Min(50, $IndexedPrefix.Length)))) {
                $Similarity = 75
                $Reason = "Child starts with indexed prefix"
            } elseif ($IndexedPrefix.Length -gt 30 -and $ChildAnalysis.childPrefix -match [regex]::Escape($IndexedPrefix.Substring(0, 30))) {
                $Similarity = 50
                $Reason = "Partial match"
            }
            
            if ($Similarity -gt 0) {
                $ChildAnalysis.potentialParents += @{
                    prefix = $IndexedPrefix
                    similarity = $Similarity
                    reason = $Reason
                }
                Write-Log "  Correspondance potentielle: similarité=$Similarity, raison=$Reason"
            }
        }
        
        if ($ChildAnalysis.potentialParents.Count -eq 0) {
            $ChildAnalysis.matchingIssues += "No potential parents found"
            Write-Log "  Aucune correspondance trouvée"
        }
        
        $ComparativeAnalysis.mismatchAnalysis += $ChildAnalysis
    }
    
    # Générer des recommandations SDDD
    $TotalChildren = $PrefixData.childInstructions.Count
    $ChildrenWithMatches = 0
    
    foreach ($Analysis in $ComparativeAnalysis.mismatchAnalysis) {
        if ($Analysis.potentialParents.Count -gt 0) {
            $ChildrenWithMatches++
        }
    }
    
    $MatchingRate = if ($TotalChildren -gt 0) { [Math]::Round($ChildrenWithMatches/$TotalChildren*100, 1) } else { 0 }
    
    $Priority = if ($MatchingRate -lt 50) { "HIGH" } elseif ($MatchingRate -lt 80) { "MEDIUM" } else { "LOW" }
    
    $ComparativeAnalysis.recommendations += @{
        type = "matching_rate"
        description = "Matching rate: $ChildrenWithMatches/$TotalChildren ($MatchingRate%)"
        priority = $Priority
    }
    
    if ($ChildrenWithMatches -lt $TotalChildren) {
        $ComparativeAnalysis.recommendations += @{
            type = "prefix_generation"
            description = "Review prefix generation logic - child instructions don't match indexed prefixes"
            priority = "HIGH"
        }
    }
    
    $ComparativeAnalysis | ConvertTo-Json -Depth 10 | Out-File "$OutputDir/comparative-analysis.json"
    Write-Log "Analyse comparative sauvegardée dans comparative-analysis.json"
}

# ÉTAPE 4: Générer le rapport SDDD
Write-Log "ÉTAPE 4: Génération du rapport SDDD"

$ReportContent = @"
# Phase 3D SDDD - Rapport de Diagnostic du Prefix Matching

**Date**: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
**Objectif**: Analyser pourquoi `searchExactPrefix` ne trouve pas de correspondances

## 📊 Résumé SDDD

- **Tests analysés**: $(if ($TestData) { $TestData.Count } else { "N/A" })
- **Relations attendues**: $(if ($ExpectedRelations) { $ExpectedRelations.Count } else { "N/A" })
- **Préfixes indexés**: $(if ($PrefixData) { $PrefixData.indexedPrefixes.Count } else { "N/A" })
- **Instructions enfants**: $(if ($PrefixData) { $PrefixData.childInstructions.Count } else { "N/A" })

## 🔍 Analyse SDDD Détaillée

### Préfixes Indexés
$(if ($PrefixData) { 
    ($PrefixData.indexedPrefixes | ForEach-Object { "- `"$_`"" }) -join "`n"
} else { 
    "Données non disponibles"
})

### Instructions Enfants
$(if ($PrefixData) { 
    ($PrefixData.childInstructions | ForEach-Object { "- `"$_`"" }) -join "`n"
} else { 
    "Données non disponibles"
})

### Problèmes Identifiés SDDD
$(if ($ComparativeAnalysis) {
    $Issues = $ComparativeAnalysis.mismatchAnalysis | Where-Object { $_.potentialParents.Count -eq 0 }
    if ($Issues.Count -gt 0) {
        $IssueList = @()
        foreach ($Child in $Issues) {
            $IssueList += "- **Enfant**: `"$($Child.childInstruction)`"`n  **Préfixe**: `"$($Child.childPrefix)`"`n  **Problèmes**: $($Child.matchingIssues -join ', ')"
        }
        $IssueList -join "`n`n"
    } else {
        "Toutes les instructions enfants ont des correspondances potentielles"
    }
} else {
    "Analyse comparative non disponible"
})

### Recommandations SDDD
$(if ($ComparativeAnalysis) {
    ($ComparativeAnalysis.recommendations | ForEach-Object { "- **$($_.type)** (Priorité: $($_.priority)): $($_.description)" }) -join "`n"
} else {
    "Recommandations non disponibles"
})

## 📋 Fichiers Générés SDDD

- `fixture-analysis.json`: Analyse des fixtures de test
- `prefix-analysis.json`: Analyse des préfixes et instructions
- `comparative-analysis.json`: Analyse comparative détaillée
- `test-output-verbose.txt`: Sortie complète du test
- `sddd-logs.txt`: Logs SDDD extraits

## 🎯 Prochaines Étapes SDDD

1. **Corriger la génération de préfixes**: Assurer que les instructions enfants correspondent aux préfixes indexés
2. **Valider la logique de matching**: Vérifier que `searchExactPrefix` utilise la bonne stratégie
3. **Tester les corrections**: Valider chaque modification avec les tests SDDD

---

**Méthodologie**: SDDD (Single Direction, Deterministic, Debuggable)
**Status**: Diagnostic complété
"@

$ReportContent | Out-File "$OutputDir/prefix-matching-report.md" -Encoding UTF8
Write-Log "Rapport SDDD généré dans $OutputDir/prefix-matching-report.md"

# Résumé final
Write-Host ""
Write-Host "✅ Diagnostic SDDD du prefix matching terminé" -ForegroundColor Green
Write-Host "📁 Répertoire de sortie: $OutputDir" -ForegroundColor Yellow
Write-Host "📄 Rapport principal: $OutputDir/prefix-matching-report.md" -ForegroundColor Yellow
Write-Host ""

Write-Log "Diagnostic SDDD terminé avec succès"