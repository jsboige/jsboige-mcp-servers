# Script de débogage SDDD simplifié pour la reconstruction hiérarchique
# Phase 3D - Étape 3 : Correction SDDD Hierarchy Reconstruction

param(
    [string]$TestName = "should export non-flat markdown with correct hierarchy depths"
)

# Configuration
$ProjectRoot = "D:\dev\roo-extensions"
$ServerDir = "$ProjectRoot\mcps\internal\servers\roo-state-manager"
$LogFile = "$ServerDir\logs\hierarchy-sddd-debug-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

# Creer le repertoire de logs si necessaire
if (!(Test-Path "$ServerDir\logs")) {
    New-Item -ItemType Directory -Path "$ServerDir\logs" -Force | Out-Null
}

Write-Host "🔍 DEBOGAGE SDDD - Reconstruction Hierarchique" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test cible: $TestName" -ForegroundColor Yellow
Write-Host "Fichier de log: $LogFile" -ForegroundColor Yellow
Write-Host ""

# Etape 1: Executer le test avec debug active
Write-Host "📋 ETAPE 1: Execution du test avec debug SDDD" -ForegroundColor Green
Write-Host "-------------------------------------------------" -ForegroundColor Green

$env:ROO_DEBUG_INSTRUCTIONS = "1"

try {
    Push-Location $ServerDir
    
    $TestCommand = "npm test -- --testNamePattern=`"$TestName`" --reporter=verbose --no-coverage"
    
    Write-Host "Commande: $TestCommand" -ForegroundColor Gray
    Write-Host ""
    
    $TestOutput = Invoke-Expression $TestCommand 2>&1
    
    # Sauvegarder la sortie complete
    $TestOutput | Out-File -FilePath $LogFile -Encoding UTF8
    
    Write-Host "✅ Test execute. Logs sauvegardes dans $LogFile" -ForegroundColor Green
    Write-Host ""
    
    # Etape 2: Analyser les logs SDDD
    Write-Host "🔬 ETAPE 2: Analyse des logs SDDD" -ForegroundColor Green
    Write-Host "-----------------------------------" -ForegroundColor Green
    
    # Extraire les informations cles des logs
    $DebugLines = $TestOutput | Where-Object { $_ -match "EXACT PREFIX SEARCH|FIX-REGRESSION|EXTRACTION|STRICT MODE" }
    
    if ($DebugLines.Count -gt 0) {
        Write-Host "📊 Lignes de debug pertinentes trouvees:" -ForegroundColor Yellow
        Write-Host ""
        
        foreach ($Line in $DebugLines) {
            if ($Line -match "Searching for:") {
                Write-Host "🔍 RECHERCHE: $Line" -ForegroundColor Cyan
            }
            elseif ($Line -match "Found exact match:") {
                Write-Host "✅ MATCH TROUVE: $Line" -ForegroundColor Green
            }
            elseif ($Line -match "No match found") {
                Write-Host "❌ PAS DE MATCH: $Line" -ForegroundColor Red
            }
            elseif ($Line -match "STRICT MODE: no exact parent match") {
                Write-Host "🚨 ERREUR STRICT MODE: $Line" -ForegroundColor Red
            }
            elseif ($Line -match "sous-instructions extraites") {
                Write-Host "📋 INDEXATION: $Line" -ForegroundColor Magenta
            }
            else {
                Write-Host "ℹ️  AUTRE: $Line" -ForegroundColor Gray
            }
        }
    }
    else {
        Write-Host "⚠️  Aucune ligne de debug pertinente trouvee dans les logs" -ForegroundColor Yellow
    }
    
    Write-Host ""
    
    # Etape 3: Analyse des echecs
    Write-Host "📉 ETAPE 3: Analyse des echecs SDDD" -ForegroundColor Green
    Write-Host "------------------------------------" -ForegroundColor Green
    
    $FailedTests = $TestOutput | Where-Object { $_ -match "FAIL|×" -and $_ -match "hierarchy" }
    
    if ($FailedTests.Count -gt 0) {
        Write-Host "❌ Tests echouants detectes:" -ForegroundColor Red
        Write-Host ""
        
        foreach ($FailedTest in $FailedTests) {
            Write-Host "   $FailedTest" -ForegroundColor Red
        }
        
        Write-Host ""
        
        # Analyser les erreurs specifiques
        $ErrorLines = $TestOutput | Where-Object { $_ -match "AssertionError|expected.*to be" }
        
        if ($ErrorLines.Count -gt 0) {
            Write-Host "🔍 Details des erreurs d'assertion:" -ForegroundColor Yellow
            Write-Host ""
            
            foreach ($ErrorLine in $ErrorLines) {
                Write-Host "   $ErrorLine" -ForegroundColor Yellow
            }
        }
    }
    else {
        Write-Host "✅ Aucun test echouant detecte" -ForegroundColor Green
    }
    
    Write-Host ""
    
    # Etape 4: Recommandations SDDD
    Write-Host "💡 ETAPE 4: Recommandations SDDD" -ForegroundColor Green
    Write-Host "--------------------------------" -ForegroundColor Green
    
    # Analyser les patterns d'echec
    $NoMatchCount = ($DebugLines | Where-Object { $_ -match "No match found" }).Count
    $StrictModeErrors = ($DebugLines | Where-Object { $_ -match "STRICT MODE: no exact parent match" }).Count
    
    if ($NoMatchCount -gt 0 -or $StrictModeErrors -gt 0) {
        Write-Host "🔧 PROBLEME IDENTIFIE: Echec de correspondance en mode strict" -ForegroundColor Red
        Write-Host ""
        Write-Host "Actions recommandees:" -ForegroundColor Yellow
        Write-Host "1. Verifier la coherence des chaines de caracteres indexees vs recherchees" -ForegroundColor White
        Write-Host "2. Analyser la fonction computeInstructionPrefix pour les incoherences" -ForegroundColor White
        Write-Host "3. Examiner les fixtures de test pour s'assurer qu'elles contiennent les bonnes declarations" -ForegroundColor White
        Write-Host "4. Considérer l'ajout de logs supplementaires dans addParentTaskWithSubInstructions" -ForegroundColor White
    }
    else {
        Write-Host "✅ Aucun probleme evident detecte dans les logs" -ForegroundColor Green
        Write-Host "Le probleme pourrait etre ailleurs dans le pipeline" -ForegroundColor Yellow
    }
    
    Write-Host ""
    
    # Etape 5: Generer un rapport resume
    Write-Host "📊 ETAPE 5: Rapport resume SDDD" -ForegroundColor Green
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
    
    Write-Host "📋 Resume de l'analyse SDDD:" -ForegroundColor Cyan
    Write-Host "   Timestamp: $($Summary.Timestamp)" -ForegroundColor White
    Write-Host "   Test: $($Summary.TestName)" -ForegroundColor White
    Write-Host "   Status: $($Summary.Status)" -ForegroundColor $(if ($Summary.Status -eq "PASSED") { "Green" } else { "Red" })
    Write-Host "   Debug lines: $($Summary.DebugLinesFound)" -ForegroundColor White
    Write-Host "   Failed tests: $($Summary.FailedTests)" -ForegroundColor White
    Write-Host "   Strict mode errors: $($Summary.StrictModeErrors)" -ForegroundColor White
    Write-Host "   No match errors: $($Summary.NoMatchErrors)" -ForegroundColor White
    Write-Host "   Log file: $($Summary.LogFile)" -ForegroundColor White
    
    # Sauvegarder le resume
    $SummaryFile = $LogFile -replace '\.log$', '-summary.json'
    $Summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $SummaryFile -Encoding UTF8
    
    Write-Host ""
    Write-Host "✅ Rapport SDDD genere: $SummaryFile" -ForegroundColor Green
}
catch {
    Write-Host "❌ Erreur lors de l'execution du script: $_" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Gray
}
finally {
    # Nettoyer l'environnement
    Remove-Item Env:ROO_DEBUG_INSTRUCTIONS -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ""
Write-Host "🏁 Script de debogage SDDD termine" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan