# sk_agent.ps1 - Wrapper PowerShell pour sk-agent
# Évite la pollution stdout qui casse le handshake MCP

$ErrorActionPreference = "Stop"

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $scriptPath "venv\Scripts\python.exe"
$skAgentPy = Join-Path $scriptPath "sk_agent.py"

if (-not (Test-Path $pythonExe)) {
    Write-Error "Python venv not found at: $pythonExe"
    exit 1
}

# Exécuter sk-agent en redirigeant stdout vers stderr pour les logs
& $pythonExe $skAgentPy @args 2>&1 | ForEach-Object {
    if ($_ -is [string]) {
        # Les messages JSON vont sur stdout, les logs sur stderr
        if ($_.StartsWith('{') -or $_.StartsWith('[')) {
            Write-Output $_  # stdout pour JSON-RPC
        } else {
            Write-Error $_  # stderr pour les logs
        }
    } else {
        Write-Output $_
    }
}
