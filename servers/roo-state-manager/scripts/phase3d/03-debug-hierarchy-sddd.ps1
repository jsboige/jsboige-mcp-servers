# Script de débogage SDDD pour la reconstruction hiérarchique
# Phase 3D - Étape 3 : Correction SDDD Hierarchy Reconstruction

param(
    [string]$TestName = "should export non-flat markdown with correct hierarchy depths",
    [switch]$Verbose = $false
)

# Configuration
$ProjectRoot = "D:\dev\roo-extensions"
$ServerDir = "$ProjectRoot\mcps\internal\servers\roo-state-manager"
$LogFile = "$ServerDir\logs\hierarchy-sddd-debug-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

# Créer le répertoire de logs si nécessaire
if (!(Test-Path "$ServerDir\logs")) {
    New-Item -ItemType Directory -Path "$ServerDir\logs" -Force | Out-Null
}

Write-Host "🔍 DÉBOGAGE SDDD - Reconstruction Hiérarchique" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test cible: $TestName" -ForegroundColor Yellow
Write-Host "Fichier de log: $LogFile" -ForegroundColor Yellow
Write-Host ""

# Étape 1: Exécuter le test avec debug activé
Write-Host "📋 ÉTAPE 1: Exécution du test avec debug SDDD" -ForegroundColor Green
Write-Host "-------------------------------------------------" -ForegroundColor Green

$env:ROO_DEBUG_INSTRUCTIONS = "1"

try {
    Push-Location $ServerDir
    
    $TestCommand = "npm test -- --testNamePattern=`"$TestName`" --reporter=verbose --no-coverage"
    
    Write-Host "Commande: $TestCommand" -ForegroundColor Gray
    Write-Host ""
    
    $TestOutput = Invoke-Expression $TestCommand 2>&1
    
    # Sauvegarder la sortie complète
    $TestOutput | Out-File -FilePath $LogFile -Encoding UTF8
    
    Write-Host "✅ Test exécuté. Logs sauvegardés dans $LogFile" -ForegroundColor Green
    Write-Host ""
    
    # Étape 2: Analyser les logs SDDD
    Write-Host "🔬 ÉTAPE 2: Analyse des logs SDDD" -ForegroundColor Green
    Write-Host "-----------------------------------" -ForegroundColor Green
    
    # Extraire les informations clés des logs
    $DebugLines = $TestOutput | Where-Object { $_ -match "\[EXACT PREFIX SEARCH\]|\[FIX-RÉGRESSION\]|\[EXTRACTION\]|STRICT MODE" }
    
    if ($DebugLines.Count -gt 0) {
        Write-Host "📊 Lignes de debug pertinentes trouvées:" -ForegroundColor Yellow
        Write-Host ""
        
        foreach ($Line in $DebugLines) {
            if ($Line -match "\[EXACT PREFIX SEARCH\].*Searching for:") {
                Write-Host "🔍 RECHERCHE: $Line" -ForegroundColor Cyan
            }
            elseif ($Line -match "\[EXACT PREFIX SEARCH\].*Found exact match:") {
                Write-Host "✅ MATCH TROUVÉ: $Line" -ForegroundColor Green
            }
            elseif ($Line -match "\[EXACT PREFIX SEARCH\].*SDDD:.*Trying prefix length") {
                Write-Host "🔧 TENTATIVE PRÉFIXE: $Line" -ForegroundColor Yellow
            }
            elseif ($Line -match "\[EXACT PREFIX SEARCH\].*SDDD:.*No match found") {
                Write-Host "❌ PAS DE MATCH: $Line" -ForegroundColor Red
            }
            elseif ($Line -match "STRICT MODE: no exact parent match") {
                Write-Host "🚨 ERREUR STRICT MODE: $Line" -ForegroundColor Red
            }
            elseif ($Line -match "\[FIX-RÉGRESSION\].*sous-instructions extraites") {
                Write-Host "📋 INDEXATION: $Line" -ForegroundColor Magenta
            }
            elseif ($Line -match "\[EXTRACTION\].*Found.*instruction") {
                Write-Host "📝 EXTRACTION: $Line" -ForegroundColor Blue
            }
            else {
                if ($Verbose) {
                    Write-Host "ℹ️  AUTRE: $Line" -ForegroundColor Gray
                }
            }
        }
    }
    else {
        Write-Host "⚠️  Aucune ligne de debug pertinente trouvée dans les logs" -ForegroundColor Yellow
    }
    
    Write-Host ""
    
    # Étape 3: Analyse des échecs
    Write-Host "📉 ÉTAPE 3: Analyse des échecs SDDD" -ForegroundColor Green
    Write-Host "------------------------------------" -ForegroundColor Green
    
    $FailedTests = $TestOutput | Where-Object { $_ -match "FAIL|×" -and $_ -match "hierarchy" }
    
    if ($FailedTests.Count -gt 0) {
        Write-Host "❌ Tests échouants détectés:" -ForegroundColor Red
        Write-Host ""
        
        foreach ($FailedTest in $FailedTests) {
            Write-Host "   $FailedTest" -ForegroundColor Red
        }
        
        Write-Host ""
        
        # Analyser les erreurs spécifiques
        $ErrorLines = $TestOutput | Where-Object { $_ -match "AssertionError|expected.*to be" }
        
        if ($ErrorLines.Count -gt 0) {
            Write-Host "🔍 Détails des erreurs d'assertion:" -ForegroundColor Yellow
            Write-Host ""
            
            foreach ($ErrorLine in $ErrorLines) {
                Write-Host "   $ErrorLine" -ForegroundColor Yellow
            }
        }
    }
    else {
        Write-Host "✅ Aucun test échouant détecté" -ForegroundColor Green
    }
    
    Write-Host ""
    
    # Étape 4: Recommandations SDDD
    Write-Host "💡 ÉTAPE 4: Recommandations SDDD" -ForegroundColor Green
    Write-Host "--------------------------------" -ForegroundColor Green
    
    # Analyser les patterns d'échec
    $NoMatchCount = ($DebugLines | Where-Object { $_ -match "No match found" }).Count
    $StrictModeErrors = ($DebugLines | Where-Object { $_ -match "STRICT MODE: no exact parent match" }).Count
    
    if ($NoMatchCount -gt 0 -or $StrictModeErrors -gt 0) {
        Write-Host "🔧 PROBLÈME IDENTIFIÉ: Échec de correspondance en mode strict" -ForegroundColor Red
        Write-Host ""
        Write-Host "Actions recommandées:" -ForegroundColor Yellow
        Write-Host "1. Vérifier la cohérence des chaînes de caractères indexées vs recherchées" -ForegroundColor White
        Write-Host "2. Analyser la fonction computeInstructionPrefix pour les incohérences" -ForegroundColor White
        Write-Host "3. Examiner les fixtures de test pour s'assurer qu'elles contiennent les bonnes déclarations" -ForegroundColor White
        Write-Host "4. Considérer l'ajout de logs supplémentaires dans addParentTaskWithSubInstructions" -ForegroundColor White
    }
    else {
        Write-Host "✅ Aucun problème évident détecté dans les logs" -ForegroundColor Green
        Write-Host "Le problème pourrait être ailleurs dans le pipeline" -ForegroundColor Yellow
    }
    
    Write-Host ""
    
    # Étape 5: Générer un rapport résumé
    Write-Host "📊 ÉTAPE 5: Rapport résumé SDDD" -ForegroundColor Green
    Write-Host "------------------------------" -ForegroundColor Green
    
    $Summary = @{
        Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        TestName = $TestName
        LogFile = $LogFile
        DebugLinesFound = $DebugLines.Count
        FailedTests = $FailedTests.Count
        StrictModeErrors = $StrictModeErrors
        NoMatchErrors = $NoMatchCount
        Status = if ($FailedTests.Count -gt 0) { "FAILED" } else { "PASSED" }
    }
    
    Write-Host "📋 Résumé de l'analyse SDDD:" -ForegroundColor Cyan
    Write-Host "   Timestamp: $($Summary.Timestamp)" -ForegroundColor White
    Write-Host "   Test: $($Summary.TestName)" -ForegroundColor White
    Write-Host "   Status: $($Summary.Status)" -ForegroundColor $(if ($Summary.Status -eq "PASSED") { "Green" } else { "Red" })
    Write-Host "   Debug lines: $($Summary.DebugLinesFound)" -ForegroundColor White
    Write-Host "   Failed tests: $($Summary.FailedTests)" -ForegroundColor White
    Write-Host "   Strict mode errors: $($Summary.StrictModeErrors)" -ForegroundColor White
    Write-Host "   No match errors: $($Summary.NoMatchErrors)" -ForegroundColor White
    Write-Host "   Log file: $($Summary.LogFile)" -ForegroundColor White
    
    # Sauvegarder le résumé
    $SummaryFile = $LogFile -replace '\.log$', '-summary.json'
    $Summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $SummaryFile -Encoding UTF8
    
    Write-Host ""
    Write-Host "✅ Rapport SDDD généré: $SummaryFile" -ForegroundColor Green
}
catch {
    Write-Host "❌ Erreur lors de l'exécution du script: $_" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Gray
}
finally {
    # Nettoyer l'environnement
    Remove-Item Env:ROO_DEBUG_INSTRUCTIONS -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ""
Write-Host "🏁 Script de débogage SDDD terminé" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan