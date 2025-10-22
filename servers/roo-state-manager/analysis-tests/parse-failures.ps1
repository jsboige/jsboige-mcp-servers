# Script de parsing des échecs de tests - Analyse forensique
# Extrait et catégorise les 65 tests échoués depuis test-results.json

param(
    [string]$JsonFile = "../test-results.json",
    [string]$OutputCsv = "test-failures-detailed.csv"
)

Write-Host "🔍 Parsing des résultats de tests..." -ForegroundColor Cyan

# Vérifier que le fichier JSON existe
if (-not (Test-Path $JsonFile)) {
    Write-Error "❌ Fichier JSON introuvable: $JsonFile"
    exit 1
}

# Lire et parser le JSON
Write-Host "📖 Lecture de $JsonFile..." -ForegroundColor Yellow
$jsonContent = Get-Content $JsonFile -Raw
$results = $jsonContent | ConvertFrom-Json

Write-Host "✅ JSON parsé avec succès" -ForegroundColor Green
Write-Host "📊 Statistiques globales:" -ForegroundColor Cyan
Write-Host "   Total tests: $($results.numTotalTests)"
Write-Host "   Tests passés: $($results.numPassedTests)"
Write-Host "   Tests échoués: $($results.numFailedTests)"
Write-Host "   Tests pending: $($results.numPendingTests)"

# Extraire tous les tests échoués
$failedTests = @()
$fileStats = @{}

foreach ($testResult in $results.testResults) {
    $file = $testResult.name
    $fileFailures = 0
    
    foreach ($assertion in $testResult.assertionResults) {
        if ($assertion.status -eq "failed") {
            $fileFailures++
            
            # Extraire le message d'erreur principal
            $errorMessage = ""
            $errorType = "Unknown"
            
            if ($assertion.failureMessages -and $assertion.failureMessages.Count -gt 0) {
                $fullError = $assertion.failureMessages[0]
                
                # Catégoriser par type d'erreur
                if ($fullError -match "^(TypeError|ReferenceError|AssertionError|Error|RooSyncServiceError|McpError):") {
                    $errorType = $matches[1]
                    $errorMessage = ($fullError -split "`n")[0]
                } elseif ($fullError -match "Cannot find module") {
                    $errorType = "ImportError"
                    $errorMessage = ($fullError -split "`n")[0]
                } elseif ($fullError -match "expected.*to") {
                    $errorType = "AssertionError"
                    $errorMessage = ($fullError -split "`n")[0]
                } elseif ($fullError -match "promise resolved.*instead of rejecting") {
                    $errorType = "UnexpectedResolve"
                    $errorMessage = "Promise resolved instead of rejecting"
                } else {
                    $errorMessage = ($fullError -split "`n")[0]
                }
                
                # Limiter la longueur du message
                if ($errorMessage.Length -gt 150) {
                    $errorMessage = $errorMessage.Substring(0, 147) + "..."
                }
            }
            
            $failedTests += [PSCustomObject]@{
                File = $file -replace '.*roo-state-manager[/\\]', ''
                TestSuite = $assertion.ancestorTitles -join " > "
                TestName = $assertion.title
                FullName = $assertion.fullName
                ErrorType = $errorType
                ErrorMessage = $errorMessage
                Duration = [math]::Round($assertion.duration, 2)
            }
        }
    }
    
    if ($fileFailures -gt 0) {
        $shortFile = $file -replace '.*roo-state-manager[/\\]', ''
        $fileStats[$shortFile] = $fileFailures
    }
}

Write-Host "`n📋 Résumé des échecs par fichier:" -ForegroundColor Cyan
$fileStats.GetEnumerator() | 
    Sort-Object Value -Descending | 
    ForEach-Object {
        Write-Host "   $($_.Key): $($_.Value) échec(s)" -ForegroundColor Yellow
    }

# Statistiques par type d'erreur
Write-Host "`n🔬 Distribution par type d'erreur:" -ForegroundColor Cyan
$errorTypeStats = $failedTests | Group-Object ErrorType | Sort-Object Count -Descending
foreach ($errorType in $errorTypeStats) {
    $percentage = [math]::Round(($errorType.Count / $failedTests.Count) * 100, 1)
    Write-Host "   $($errorType.Name): $($errorType.Count) ($percentage%)" -ForegroundColor Yellow
}

# Exporter en CSV
Write-Host "`n💾 Export vers CSV..." -ForegroundColor Cyan
$failedTests | Export-Csv $OutputCsv -NoTypeInformation -Encoding UTF8
Write-Host "✅ Fichier CSV créé: $OutputCsv" -ForegroundColor Green

# Créer un rapport résumé
$summaryFile = "test-failures-summary.txt"
$summary = @"
═══════════════════════════════════════════════════════════════
  RAPPORT D'ANALYSE - TESTS ÉCHOUÉS (65 tests)
═══════════════════════════════════════════════════════════════

📊 VUE D'ENSEMBLE
─────────────────────────────────────────────────────────────
Total tests: $($results.numTotalTests)
Tests passés: $($results.numPassedTests) ($([math]::Round(($results.numPassedTests/$results.numTotalTests)*100, 1))%)
Tests échoués: $($results.numFailedTests) ($([math]::Round(($results.numFailedTests/$results.numTotalTests)*100, 1))%)
Tests pending: $($results.numPendingTests)

🔥 TOP 5 FICHIERS AVEC LE PLUS D'ÉCHECS
─────────────────────────────────────────────────────────────
$($fileStats.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 | ForEach-Object { "  $($_.Key): $($_.Value) échecs" } | Out-String)

🔬 DISTRIBUTION PAR TYPE D'ERREUR
─────────────────────────────────────────────────────────────
$($errorTypeStats | ForEach-Object { 
    $pct = [math]::Round(($_.Count / $failedTests.Count) * 100, 1)
    "  $($_.Name): $($_.Count) tests ($pct%)"
} | Out-String)

📝 DÉTAILS DES ÉCHECS
─────────────────────────────────────────────────────────────
Consultez le fichier CSV pour les détails complets:
- $OutputCsv

═══════════════════════════════════════════════════════════════
"@

$summary | Out-File $summaryFile -Encoding UTF8
Write-Host "OK Rapport resume cree: $summaryFile" -ForegroundColor Green

Write-Host "`nAnalyse terminee avec succes!" -ForegroundColor Green
Write-Host "Fichiers generes:" -ForegroundColor Cyan
Write-Host "   - $OutputCsv (details complets)" -ForegroundColor White
Write-Host "   - $summaryFile (resume)" -ForegroundColor White