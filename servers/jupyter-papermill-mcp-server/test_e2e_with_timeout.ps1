# Script PowerShell pour exécuter les tests E2E avec timeout
# Évite les blocages lors des tests du serveur MCP Jupyter

param(
    [int]$TimeoutSeconds = 120,
    [string]$TestPath = "tests/test_e2e/",
    [switch]$Verbose
)

Write-Host "=== Tests E2E MCP Jupyter avec timeout ===" -ForegroundColor Green
Write-Host "Timeout: $TimeoutSeconds secondes" -ForegroundColor Yellow
Write-Host "Répertoire: $TestPath" -ForegroundColor Yellow

# Changer vers le répertoire du serveur MCP
$ServerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ServerDir
Write-Host "Répertoire de travail: $(Get-Location)" -ForegroundColor Cyan

# Chemin vers l'environnement mcp-jupyter
$PythonExe = "C:/Users/jsboi/.conda/envs/mcp-jupyter/python.exe"
$TestArgs = @("-m", "pytest", $TestPath, "--tb=short", "--maxfail=5")

if ($Verbose) {
    $TestArgs += "-v"
}

Write-Host "Commande: $PythonExe $($TestArgs -join ' ')" -ForegroundColor Cyan

# Créer le processus avec timeout
$ProcessStartInfo = New-Object System.Diagnostics.ProcessStartInfo
$ProcessStartInfo.FileName = $PythonExe
$ProcessStartInfo.Arguments = $TestArgs -join " "
$ProcessStartInfo.RedirectStandardOutput = $true
$ProcessStartInfo.RedirectStandardError = $true
$ProcessStartInfo.UseShellExecute = $false
$ProcessStartInfo.CreateNoWindow = $false

$Process = New-Object System.Diagnostics.Process
$Process.StartInfo = $ProcessStartInfo

# Handlers pour capturer la sortie
$OutputDataReceived = {
    param($sender, $e)
    if ($e.Data -ne $null) {
        Write-Host $e.Data
    }
}

$ErrorDataReceived = {
    param($sender, $e)
    if ($e.Data -ne $null) {
        Write-Host $e.Data -ForegroundColor Red
    }
}

# Attacher les handlers
$Process.add_OutputDataReceived($OutputDataReceived)
$Process.add_ErrorDataReceived($ErrorDataReceived)

try {
    Write-Host "`n--- Démarrage des tests ---" -ForegroundColor Green
    $Process.Start()
    $Process.BeginOutputReadLine()
    $Process.BeginErrorReadLine()
    
    # Attendre avec timeout
    $Completed = $Process.WaitForExit($TimeoutSeconds * 1000)
    
    if (-not $Completed) {
        Write-Host "`n⏰ TIMEOUT après $TimeoutSeconds secondes - Arrêt forcé du processus" -ForegroundColor Yellow
        $Process.Kill()
        $Process.WaitForExit(5000)
        Write-Host "✅ Processus arrêté" -ForegroundColor Green
        return 124  # Code de timeout
    }
    
    $ExitCode = $Process.ExitCode
    Write-Host "`n--- Fin des tests ---" -ForegroundColor Green
    Write-Host "Code de sortie: $ExitCode" -ForegroundColor $(if ($ExitCode -eq 0) { "Green" } else { "Red" })
    
    return $ExitCode
}
catch {
    Write-Host "Erreur lors de l'exécution: $($_.Exception.Message)" -ForegroundColor Red
    return 1
}
finally {
    if ($Process -and -not $Process.HasExited) {
        Write-Host "Nettoyage final du processus..." -ForegroundColor Yellow
        try {
            $Process.Kill()
            $Process.WaitForExit(2000)
        }
        catch {
            Write-Host "Impossible d'arrêter le processus proprement" -ForegroundColor Red
        }
    }
    if ($Process) {
        $Process.Dispose()
    }
}