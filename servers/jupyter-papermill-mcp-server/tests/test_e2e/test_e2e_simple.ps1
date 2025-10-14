# Script PowerShell simplifié pour exécuter les tests E2E avec timeout
param(
    [int]$TimeoutSeconds = 90,
    [switch]$Verbose
)

Write-Host "=== Tests E2E MCP Jupyter avec timeout ($TimeoutSeconds s) ===" -ForegroundColor Green

# Changer vers le répertoire du serveur MCP
$ServerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ServerDir
Write-Host "Répertoire de travail: $(Get-Location)" -ForegroundColor Cyan

# Fichiers temporaires pour capturer la sortie
$OutputFile = Join-Path $env:TEMP "pytest_output.txt"
$ErrorFile = Join-Path $env:TEMP "pytest_error.txt"

# Chemin vers l'environnement mcp-jupyter
$PythonExe = "C:/Users/jsboi/.conda/envs/mcp-jupyter/python.exe"
$TestArgs = "tests/test_e2e/ --tb=short --maxfail=3"
if ($Verbose) { $TestArgs += " -v" }

$Command = "$PythonExe -m pytest $TestArgs"
Write-Host "Commande: $Command" -ForegroundColor Cyan

try {
    # Lancer le processus avec timeout
    $Process = Start-Process -FilePath $PythonExe -ArgumentList @("-m", "pytest") + $TestArgs.Split(" ") -RedirectStandardOutput $OutputFile -RedirectStandardError $ErrorFile -PassThru -NoNewWindow
    
    Write-Host "Processus démarré (PID: $($Process.Id))" -ForegroundColor Yellow
    Write-Host "Attente max: $TimeoutSeconds secondes..." -ForegroundColor Yellow
    
    # Attendre avec timeout
    $Completed = $Process.WaitForExit($TimeoutSeconds * 1000)
    
    if (-not $Completed) {
        Write-Host "⏰ TIMEOUT - Arrêt du processus" -ForegroundColor Red
        $Process.Kill()
        $Process.WaitForExit(5000)
        Write-Host "Processus terminé" -ForegroundColor Yellow
    }
    
    # Lire et afficher les sorties
    Write-Host "`n=== SORTIE STANDARD ===" -ForegroundColor Green
    if (Test-Path $OutputFile) {
        Get-Content $OutputFile | ForEach-Object { Write-Host $_ }
    }
    
    Write-Host "`n=== ERREURS ===" -ForegroundColor Red
    if (Test-Path $ErrorFile) {
        Get-Content $ErrorFile | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    }
    
    $ExitCode = if ($Completed) { $Process.ExitCode } else { 124 }
    Write-Host "`n=== RÉSULTAT ===" -ForegroundColor Green
    Write-Host "Code de sortie: $ExitCode" -ForegroundColor $(if ($ExitCode -eq 0) { "Green" } else { "Red" })
    
    return $ExitCode
}
catch {
    Write-Host "Erreur: $($_.Exception.Message)" -ForegroundColor Red
    return 1
}
finally {
    # Nettoyage
    if (Test-Path $OutputFile) { Remove-Item $OutputFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path $ErrorFile) { Remove-Item $ErrorFile -Force -ErrorAction SilentlyContinue }
}