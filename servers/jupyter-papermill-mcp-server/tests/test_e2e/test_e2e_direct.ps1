# Script PowerShell direct pour les tests E2E avec timeout
param([int]$TimeoutSeconds = 60)

Write-Host "=== Tests E2E MCP Jupyter (timeout: $TimeoutSeconds s) ===" -ForegroundColor Green

# Changer vers le répertoire du serveur MCP
$ServerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ServerDir
Write-Host "Répertoire: $(Get-Location)" -ForegroundColor Cyan

# Commande pytest
$PythonExe = "C:/Users/jsboi/.conda/envs/mcp-jupyter/python.exe"
$FullCommand = "$PythonExe -m pytest tests/test_e2e/ -v --tb=short --maxfail=3"
Write-Host "Exécution: $FullCommand" -ForegroundColor Yellow

# Exécution avec timeout via Start-Job
$Job = Start-Job -ScriptBlock {
    param($Command, $WorkingDir)
    Set-Location $WorkingDir
    Invoke-Expression $Command
} -ArgumentList $FullCommand, $ServerDir

# Attendre avec timeout
$JobCompleted = Wait-Job $Job -Timeout $TimeoutSeconds

if ($JobCompleted) {
    # Job terminé normalement
    $Output = Receive-Job $Job
    $ExitCode = 0
    
    Write-Host "`n=== SORTIE DES TESTS ===" -ForegroundColor Green
    $Output | ForEach-Object { 
        if ($_ -match "PASSED") { 
            Write-Host $_ -ForegroundColor Green 
        } elseif ($_ -match "FAILED") { 
            Write-Host $_ -ForegroundColor Red 
        } elseif ($_ -match "ERROR") { 
            Write-Host $_ -ForegroundColor Red 
        } else { 
            Write-Host $_ 
        }
    }
    
    # Analyser le résumé
    $PassedCount = ($Output | Select-String "PASSED").Count
    $FailedCount = ($Output | Select-String "FAILED").Count
    $ErrorCount = ($Output | Select-String "ERROR").Count
    
    Write-Host "`n=== RÉSUMÉ ===" -ForegroundColor Cyan
    Write-Host "✅ Tests PASSÉS: $PassedCount" -ForegroundColor Green
    Write-Host "❌ Tests ÉCHOUÉS: $FailedCount" -ForegroundColor Red
    Write-Host "⚠️  Tests ERREUR: $ErrorCount" -ForegroundColor Yellow
    
    $ExitCode = if ($FailedCount -eq 0 -and $ErrorCount -eq 0) { 0 } else { 1 }
} else {
    # Timeout
    Write-Host "`n⏰ TIMEOUT après $TimeoutSeconds secondes" -ForegroundColor Red
    Remove-Job $Job -Force
    $ExitCode = 124
}

Write-Host "`nCode de sortie: $ExitCode" -ForegroundColor $(if ($ExitCode -eq 0) { "Green" } else { "Red" })
exit $ExitCode