# Test direct de l'outil build_skeleton_cache via MCP
# Valide la réduction des logs après corrections

Write-Host "=== TEST build_skeleton_cache ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Parameters: { force_rebuild: true }" -ForegroundColor Yellow
Write-Host "Expected: ~15-20 lines (aggregate logs only)" -ForegroundColor Yellow
Write-Host "---" -ForegroundColor Gray
Write-Host ""

# Capturer le timestamp de début
$startTime = Get-Date

# Exécuter l'outil via node et capturer STDOUT + STDERR
$output = node build/index.js build_skeleton_cache --force_rebuild true 2>&1 | Out-String

# Capturer le timestamp de fin
$endTime = Get-Date
$duration = ($endTime - $startTime).TotalSeconds

Write-Host "---" -ForegroundColor Gray
Write-Host ""
Write-Host "=== OUTPUT ===" -ForegroundColor Cyan
Write-Host $output

Write-Host ""
Write-Host "=== VALIDATION ===" -ForegroundColor Cyan
Write-Host ""

# Compter les lignes de logs
$logLines = ($output -split "`n").Count
Write-Host "📊 Total log lines: $logLines" -ForegroundColor Yellow

# Vérifier présence des résumés agrégés attendus
$hasSummary = $output -match "Build Statistics"
$hasBuiltCount = $output -match "Built="
$hasSkippedCount = $output -match "Skipped="

Write-Host ""
Write-Host "Checklist validation:" -ForegroundColor White
Write-Host "  [$(if($hasSummary){'✅'}else{'❌'})] Résumé agrégé présent (Build Statistics)" -ForegroundColor $(if($hasSummary){'Green'}else{'Red'})
Write-Host "  [$(if($hasBuiltCount){'✅'}else{'❌'})] Compteur Built= présent" -ForegroundColor $(if($hasBuiltCount){'Green'}else{'Red'})
Write-Host "  [$(if($hasSkippedCount){'✅'}else{'❌'})] Compteur Skipped= présent" -ForegroundColor $(if($hasSkippedCount){'Green'}else{'Red'})

# Vérifier absence de logs individuels verbeux (preuve de réduction)
$hasVerboseLogs = $output -match "Processing file:" -or $output -match "Analyzing conversation"
Write-Host "  [$(if(-not $hasVerboseLogs){'✅'}else{'❌'})] Logs individuels ABSENTS (réduits)" -ForegroundColor $(if(-not $hasVerboseLogs){'Green'}else{'Red'})

Write-Host ""
Write-Host "⏱️  Duration: $([math]::Round($duration, 2))s" -ForegroundColor Cyan

# Verdict final
$isSuccess = $hasSummary -and $hasBuiltCount -and $hasSkippedCount -and (-not $hasVerboseLogs) -and ($logLines -lt 50)

Write-Host ""
if ($isSuccess) {
    Write-Host "✅ TEST PASSED - Logs agrégés validés !" -ForegroundColor Green
    exit 0
} else {
    Write-Host "❌ TEST FAILED - Logs toujours trop verbeux ou résumé manquant" -ForegroundColor Red
    exit 1
}