# run-sk-agent.ps1 - Wrapper robuste pour démarrer sk-agent MCP
# Détecte automatiquement Python (venv > conda > system)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Priorité 1: venv local
$VenvPython = Join-Path $ScriptDir "venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
    Write-Host "Using venv Python: $VenvPython" -ForegroundColor Green
    & $VenvPython (Join-Path $ScriptDir "sk_agent.py")
    exit $LASTEXITCODE
}

# Priorité 2: miniconda3
$CondaPython = Join-Path $env:USERPROFILE "miniconda3\python.exe"
if (Test-Path $CondaPython) {
    Write-Host "Using conda Python: $CondaPython" -ForegroundColor Yellow
    & $CondaPython (Join-Path $ScriptDir "sk_agent.py")
    exit $LASTEXITCODE
}

# Priorité 3: Python dans PATH
$SystemPython = Get-Command python -ErrorAction SilentlyContinue
if ($SystemPython) {
    Write-Host "Using system Python: $($SystemPython.Source)" -ForegroundColor Cyan
    & python (Join-Path $ScriptDir "sk_agent.py")
    exit $LASTEXITCODE
}

# Échec: aucun Python trouvé
Write-Host "ERROR: Python not found. Please install:" -ForegroundColor Red
Write-Host "  1. Create venv: python -m venv venv" -ForegroundColor Red
Write-Host "  2. OR install miniconda3" -ForegroundColor Red
Write-Host "  3. OR add Python to PATH" -ForegroundColor Red
exit 1
