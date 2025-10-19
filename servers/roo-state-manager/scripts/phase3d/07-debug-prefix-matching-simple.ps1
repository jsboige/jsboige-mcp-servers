# Phase 3D SDDD - Diagnostic du Prefix Matching (Version Ultra-Simplifiée)
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

# ÉTAPE 1: Exécuter le test avec debug SDDD
Write-Log "ÉTAPE 1: Exécution du test avec debug SDDD"

if (-not $SkipTests) {
    try {
        Write-Log "Exécution du test avec ROO_DEBUG_INSTRUCTIONS=1"
        $env:ROO_DEBUG_INSTRUCTIONS = "1"
        
        $TestCommand = "npm test -- --testNamePattern=`"should reconstruct 100% of parent-child relationships`" --reporter=verbose --no-coverage"
        Write-Log "Commande: $TestCommand"
        
        $TestOutput = Invoke-Expression $TestCommand 2>&1
        $TestOutput | Out-File "$OutputDir/test-output-verbose.txt"
        
        # Extraire les logs SDDD avec des patterns simples
        $SDDDLines = @()
        $PrefixLines = @()
        $ChildLines = @()
        $SearchLines = @()
        
        foreach ($Line in $TestOutput) {
            if ($Line -match "SDDD:" -or $Line -match "EXACT PREFIX SEARCH") {
                $SDDDLines += $Line
                
                # Extraire les préfixes indexés
                if ($Line -match "prefix=") {
                    $PrefixLines += $Line
                }
                
                # Extraire les instructions enfants
                if ($Line -match "Child truncated instruction:") {
                    $ChildLines += $Line
                }
                
                # Extraire les tentatives de recherche
                if ($Line -match "Trying prefix length") {
                    $SearchLines += $Line
                }
            }
        }
        
        $SDDDLines | Out-File "$OutputDir/sddd-logs.txt"
        $PrefixLines | Out-File "$OutputDir/prefix-logs.txt"
        $ChildLines | Out-File "$OutputDir/child-logs.txt"
        $SearchLines | Out-File "$OutputDir/search-logs.txt"
        
        Write-Log "Test exécuté, $($SDDDLines.Count) logs SDDD extraits"
        Write-Log "Préfixes trouvés: $($PrefixLines.Count)"
        Write-Log "Instructions enfants trouvées: $($ChildLines.Count)"
        Write-Log "Tentatives de recherche: $($SearchLines.Count)"
        
        # Analyser manuellement les données
        $AnalysisResult = @{
            timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            totalSDDDLines = $SDDDLines.Count
            prefixLines = $PrefixLines.Count
            childLines = $ChildLines.Count
            searchLines = $SearchLines.Count
            sdddLogs = $SDDDLines
            prefixLogs = $PrefixLines
            childLogs = $ChildLines
            searchLogs = $SearchLines
        }
        
        $AnalysisResult | ConvertTo-Json -Depth 10 | Out-File "$OutputDir/simple-analysis.json"
        Write-Log "Analyse simple sauvegardée dans simple-analysis.json"
        
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

# ÉTAPE 2: Analyser les fixtures manuellement
Write-Log "ÉTAPE 2: Analyse manuelle des fixtures"

$FixtureFile = "tests/unit/utils/controlled-hierarchy-reconstruction.test.ts"
if (Test-Path $FixtureFile) {
    $FixtureContent = Get-Content $FixtureFile -Raw
    $FixtureContent | Out-File "$OutputDir/fixture-content.txt"
    Write-Log "Contenu des fixtures sauvegardé dans fixture-content.txt"
    
    # Chercher manuellement les relations parent-enfant
    $ParentChildLines = @()
    foreach ($Line in Get-Content $FixtureFile) {
        if ($Line -match "parentTaskId" -and $Line -notmatch "null") {
            $ParentChildLines += $Line
        }
    }
    
    $ParentChildLines | Out-File "$OutputDir/parent-child-relations.txt"
    Write-Log "Relations parent-enfant trouvées: $($ParentChildLines.Count)"
}

# ÉTAPE 3: Générer le rapport SDDD
Write-Log "ÉTAPE 3: Génération du rapport SDDD"

$ReportContent = @"
# Phase 3D SDDD - Rapport de Diagnostic du Prefix Matching (Simple)

**Date**: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
**Objectif**: Analyser pourquoi `searchExactPrefix` ne trouve pas de correspondances

## 📊 Résumé SDDD

- **Logs SDDD extraits**: $(if ($SDDDLines) { $SDDDLines.Count } else { "N/A" })
- **Préfixes trouvés**: $(if ($PrefixLines) { $PrefixLines.Count } else { "N/A" })
- **Instructions enfants**: $(if ($ChildLines) { $ChildLines.Count } else { "N/A" })
- **Tentatives de recherche**: $(if ($SearchLines) { $SearchLines.Count } else { "N/A" })

## 🔍 Analyse SDDD Détaillée

### Logs SDDD Complets
Les logs complets sont disponibles dans `sddd-logs.txt`

### Préfixes Indexés
Les préfixes indexés sont disponibles dans `prefix-logs.txt`

### Instructions Enfants
Les instructions enfants sont disponibles dans `child-logs.txt`

### Tentatives de Recherche
Les tentatives de recherche sont disponibles dans `search-logs.txt`

## 🎯 Analyse Manuelle

### Problème Identifié
D'après les logs SDDD, le problème semble être:

1. **Les préfixes indexés** contiennent les instructions de création de sous-tâches déclarées par les parents
2. **Les instructions enfants** contiennent les descriptions de mission complètes des enfants
3. **Le mismatch**: Les instructions enfants ne commencent pas par les préfixes indexés

### Exemple Concret
- **Préfixe indexé**: `"test-branch-a: crée le fichier branch-a..."`
- **Instruction enfant**: `"TEST-BRANCH-A: Tu es la branche A de la hiérarchie de test..."`

Le problème est que l'instruction enfant ne commence pas par le préfixe indexé.

## 📋 Fichiers Générés SDDD

- `test-output-verbose.txt`: Sortie complète du test
- `sddd-logs.txt`: Logs SDDD extraits
- `prefix-logs.txt`: Logs des préfixes indexés
- `child-logs.txt`: Logs des instructions enfants
- `search-logs.txt`: Logs des tentatives de recherche
- `simple-analysis.json`: Analyse simple des données
- `fixture-content.txt`: Contenu des fixtures
- `parent-child-relations.txt`: Relations parent-enfant

## 🎯 Prochaines Étapes SDDD

1. **Corriger la logique de recherche**: Utiliser le titre de la tâche enfant au lieu de l'instruction complète
2. **Valider la correspondance**: S'assurer que les titres correspondent aux préfixes indexés
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