# run-sk-agent.ps1 - Wrapper robuste pour démarrer sk-agent MCP
# Détecte automatiquement Python (venv > conda > system)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Priorité 1: venv local
$VenvPython = Join-Path $ScriptDir "venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
    & $VenvPython (Join-Path $ScriptDir "sk_agent.py")
    exit $LASTEXITCODE
}

# Priorité 2: miniconda3
$CondaPython = Join-Path $env:USERPROFILE "miniconda3\python.exe"
if (Test-Path $CondaPython) {
    & $CondaPython (Join-Path $ScriptDir "sk_agent.py")
    exit $LASTEXITCODE
}

# Priorité 3: Python dans PATH
$SystemPython = Get-Command python -ErrorAction SilentlyContinue
if ($SystemPython) {
    & python (Join-Path $ScriptDir "sk_agent.py")
    exit $LASTEXITCODE
}

# Échec: aucun Python trouvé - écrire sur stderr uniquement
[Console]::Error.WriteLine("ERROR: Python not found in venv, conda, or PATH")
exit 1
