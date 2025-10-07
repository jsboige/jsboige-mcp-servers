#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Script PowerShell pour diagnostic SDDD complet - Validation hierarchique
.DESCRIPTION
    Encapsule les diagnostics Node.js et analyse les resultats pour Bloc 3
#>

param(
    [switch]$FullReport,
    [switch]$QuickTest,
    [string]$OutputPath = "./diagnosis-results.json"
)

Write-Host "[DIAGNOSTIC SDDD] VALIDATION SYSTEME HIERARCHIQUE" -ForegroundColor Cyan
Write-Host "   Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host ""

$DiagnosticResults = @{
    Timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
    TestResults = @{}
    Issues = @()
    Recommendations = @()
}

try {
    # ETAPE 1: Diagnostic principal
    Write-Host "[ETAPE 1] Execution diagnostic Node.js..." -ForegroundColor Yellow
    
    $nodeResult = & node scripts/direct-diagnosis.mjs 2>&1
    $exitCode = $LASTEXITCODE
    
    if ($exitCode -eq 0) {
        Write-Host "[SUCCESS] Diagnostic Node.js termine avec succes" -ForegroundColor Green
        
        # Parser les resultats du diagnostic
        $outputLines = $nodeResult | Where-Object { $_ -match "Total skeletons|Avec instructions|Avec parentTaskId" }
        
        foreach ($line in $outputLines) {
            if ($line -match "Total skeletons: (\d+)") {
                $DiagnosticResults.TestResults.TotalSkeletons = [int]$matches[1]
            }
            elseif ($line -match "Avec instructions newTask: (\d+)") {
                $DiagnosticResults.TestResults.WithInstructions = [int]$matches[1]
            }
            elseif ($line -match "Avec parentTaskId: (\d+)") {
                $DiagnosticResults.TestResults.WithParent = [int]$matches[1]
            }
        }
        
        # Analyser les problemes
        if ($DiagnosticResults.TestResults.WithParent -eq 0) {
            $DiagnosticResults.Issues += "CRITIQUE: RadixTree matching defaillant (0% relations)"
        }
        if ($DiagnosticResults.TestResults.WithInstructions -lt $DiagnosticResults.TestResults.TotalSkeletons * 0.5) {
            $DiagnosticResults.Issues += "PATTERN 5 extraction sous-optimale"
        }
        
    } else {
        Write-Host "[ERROR] Erreur diagnostic Node.js (code $exitCode)" -ForegroundColor Red
        $DiagnosticResults.Issues += "Echec execution diagnostic principal"
    }
    
    # ETAPE 2: Analyse specifique RadixTree si probleme detecte
    if ($DiagnosticResults.TestResults.WithParent -eq 0 -and $DiagnosticResults.TestResults.WithInstructions -gt 0) {
        Write-Host ""
        Write-Host "[ETAPE 2] Diagnostic RadixTree specifique..." -ForegroundColor Yellow
        
        $DiagnosticResults.Recommendations += "Corriger le matching RadixTree - 0% efficacite"
        $DiagnosticResults.Recommendations += "Verifier computeInstructionPrefix normalization"
        $DiagnosticResults.Recommendations += "Tester exact vs fuzzy matching"
    }
    
    # ETAPE 3: Resume et prochaines actions
    Write-Host ""
    Write-Host "[RESUME] DIAGNOSTIC SDDD:" -ForegroundColor Cyan
    Write-Host "   Skeletons generes: $($DiagnosticResults.TestResults.TotalSkeletons)" -ForegroundColor White
    Write-Host "   Instructions extraites: $($DiagnosticResults.TestResults.WithInstructions)" -ForegroundColor White
    Write-Host "   Relations hierarchiques: $($DiagnosticResults.TestResults.WithParent)" -ForegroundColor White
    
    if ($DiagnosticResults.Issues.Count -gt 0) {
        Write-Host ""
        Write-Host "[PROBLEMES] IDENTIFIES:" -ForegroundColor Red
        foreach ($issue in $DiagnosticResults.Issues) {
            Write-Host "   - $issue" -ForegroundColor Red
        }
    }
    
    if ($DiagnosticResults.Recommendations.Count -gt 0) {
        Write-Host ""
        Write-Host "[RECOMMANDATIONS] BLOC 3:" -ForegroundColor Green
        foreach ($rec in $DiagnosticResults.Recommendations) {
            Write-Host "   - $rec" -ForegroundColor Green
        }
    }
    
    # Sauvegarde des resultats
    if ($OutputPath) {
        $DiagnosticResults | ConvertTo-Json -Depth 3 | Out-File -FilePath $OutputPath -Encoding UTF8
        Write-Host ""
        Write-Host "[SAVE] Resultats sauvegardes: $OutputPath" -ForegroundColor Gray
    }
    
    # Actions suggerees pour Bloc 3
    Write-Host ""
    Write-Host "[ACTIONS] PROCHAINES ETAPES BLOC 3:" -ForegroundColor Yellow
    if ($DiagnosticResults.TestResults.WithParent -eq 0) {
        Write-Host "   1. Corriger RadixTree matching" -ForegroundColor White
        Write-Host "   2. Tester normalization prefix" -ForegroundColor White
        Write-Host "   3. Re-valider chaine complete" -ForegroundColor White
    } else {
        Write-Host "   1. Optimiser extraction PATTERN 5" -ForegroundColor White
        Write-Host "   2. Validation finale coverage" -ForegroundColor White
    }
    
} catch {
    Write-Host "[ERROR] CRITIQUE: $($_.Exception.Message)" -ForegroundColor Red
    $DiagnosticResults.Issues += "Exception: $($_.Exception.Message)"
    exit 1
}

Write-Host ""
Write-Host "[SUCCESS] Diagnostic SDDD termine - Pret pour Bloc 3" -ForegroundColor Green