# deploy-sk-agent.ps1 - Déploiement automatisé sk-agent
#
# Issue #475 : sk-agent déploiement + tests intégration 6 machines
#
# Usage : .\deploy-sk-agent.ps1 [-MachineId <string>]
#
# Ce script déploie sk-agent sur la machine locale avec toutes les dépendances.

param(
    [string]$MachineId = $env:COMPUTERNAME.ToLower(),
    [switch]$SkipVenv = $false,
    [switch]$SkipConfig = $false
)

$ErrorActionPreference = "Stop"

# Configuration
$RepoRoot = "C:\dev\roo-extensions"
$SkAgentDir = "$RepoRoot\mcps\internal\servers\sk-agent"
$VenvDir = "$SkAgentDir\venv"
$ConfigFile = "$SkAgentDir\sk_agent_config.json"
$WrapperFile = "$SkAgentDir\sk_agent.ps1"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " sk-agent Deployment - $MachineId" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Vérifier Python
Write-Host "[1/5] Checking Python..." -ForegroundColor Yellow
try {
    $pythonVersion = python --version 2>&1
    Write-Host "  ✓ Python: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Error "Python not found. Please install Python 3.11+"
    exit 1
}

# 2. Créer venv si nécessaire
if (-not $SkipVenv) {
    Write-Host "[2/5] Setting up virtual environment..." -ForegroundColor Yellow
    if (-not (Test-Path $VenvDir)) {
        Write-Host "  Creating venv..." -ForegroundColor Cyan
        python -m venv $VenvDir
        Write-Host "  ✓ Venv created" -ForegroundColor Green
    } else {
        Write-Host "  ✓ Venv already exists" -ForegroundColor Green
    }
} else {
    Write-Host "[2/5] Skipping venv creation (-SkipVenv)" -ForegroundColor Gray
}

# 3. Installer les dépendances
Write-Host "[3/5] Installing dependencies..." -ForegroundColor Yellow
$pip = "$VenvDir\Scripts\pip.exe"

# Vérifier si semantic-kernel est installé
$skCheck = & $pip show semantic-kernel 2>$null
if ($skCheck) {
    Write-Host "  ✓ semantic-kernel already installed: $($skCheck.Version)" -ForegroundColor Green
} else {
    Write-Host "  Installing semantic-kernel..." -ForegroundColor Cyan
    & $pip install "semantic-kernel[mcp]>=1.39" "mcp>=1.7" "openai>=1.109" "Pillow>=10.0" "httpx>=0.27" "qdrant-client"
    Write-Host "  ✓ Dependencies installed" -ForegroundColor Green
}

# 4. Créer la config si nécessaire
if (-not $SkipConfig) {
    Write-Host "[4/5] Setting up configuration..." -ForegroundColor Yellow

    # Template de config (les clés API doivent être fournies)
    $ConfigTemplate = @{
        default_ask_model = "glm-5"
        default_vision_model = "glm-4.6v"
        max_recursion_depth = 2
        models = @(
            @{
                id = "glm-4.6v"
                enabled = $true
                base_url = "https://api.z.ai/api/coding/paas/v4"
                api_key = ""  # À remplir
                model_id = "glm-4.6v"
                vision = $true
                description = "Vision model (GLM-4.6V via z.ai)"
                context_window = 128000
            },
            @{
                id = "glm-5"
                enabled = $true
                base_url = "https://api.z.ai/api/coding/paas/v4"
                api_key = ""  # À remplir
                model_id = "glm-5"
                vision = $false
                description = "Text model (GLM-5 via z.ai)"
                context_window = 200000
            },
            @{
                id = "zwz-8b"
                enabled = $true
                base_url = "https://api.mini.text-generation-webui.myia.io/v1"
                api_key = ""  # À remplir
                model_id = "zwz-8b"
                vision = $false
                description = "Fast local text (myia.io)"
                context_window = 8192
            },
            @{
                id = "glm-4.7-flash"
                enabled = $true
                base_url = "https://api.mini.text-generation-webui.myia.io/v1"
                api_key = ""  # À remplir
                model_id = "glm-4.7-flash"
                vision = $false
                description = "Fast local text (myia.io)"
                context_window = 8192
            }
        )
    }

    if (-not (Test-Path $ConfigFile)) {
        Write-Host "  Creating config template..." -ForegroundColor Cyan
        $ConfigTemplate | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile -Encoding UTF8
        Write-Host "  ⚠ Config created - PLEASE EDIT API KEYS: $ConfigFile" -ForegroundColor Yellow
    } else {
        Write-Host "  ✓ Config already exists" -ForegroundColor Green
    }
} else {
    Write-Host "[4/5] Skipping config creation (-SkipConfig)" -ForegroundColor Gray
}

# 5. Créer le wrapper PowerShell si nécessaire
Write-Host "[5/5] Setting up PowerShell wrapper..." -ForegroundColor Yellow

$WrapperContent = @'
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
'@

if (-not (Test-Path $WrapperFile)) {
    Write-Host "  Creating wrapper..." -ForegroundColor Cyan
    Set-Content $WrapperFile $WrapperContent -Encoding UTF8
    Write-Host "  ✓ Wrapper created" -ForegroundColor Green
} else {
    Write-Host "  ✓ Wrapper already exists" -ForegroundColor Green
}

# Résumé
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Deployment Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Machine: $MachineId" -ForegroundColor White
Write-Host "Sk-agent dir: $SkAgentDir" -ForegroundColor White
Write-Host "Venv: $VenvDir" -ForegroundColor White
Write-Host "Config: $ConfigFile" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Edit API keys in: $ConfigFile" -ForegroundColor White
Write-Host "2. Add to ~/.claude.json:" -ForegroundColor White
Write-Host '   "sk-agent": {' -ForegroundColor Gray
Write-Host '     "command": "C:\\dev\\roo-extensions\\mcps\\internal\\servers\\sk-agent\\venv\\Scripts\\python.exe",' -ForegroundColor Gray
Write-Host '     "args": ["C:\\dev\\roo-extensions\\mcps\\internal\\servers\\sk-agent\\sk_agent.py"],' -ForegroundColor Gray
Write-Host '     "env": { "SK_AGENT_CONFIG": "C:\\dev\\roo-extensions\\mcps\\internal\\servers\\sk-agent\\sk_agent_config.json" }' -ForegroundColor Gray
Write-Host '   }' -ForegroundColor Gray
Write-Host "3. Restart VS Code" -ForegroundColor White
Write-Host ""
