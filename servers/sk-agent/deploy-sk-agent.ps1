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

# Configuration — dérivés de l'emplacement du script, jamais d'un chemin fixe
# (le clone peut vivre hors C:\dev : D:\dev\roo-extensions, seats cloud, etc.)
$SkAgentDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
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

# Vérifier si semantic-kernel est installé. PS 5.1 : un redirect 2>$null sur un
# exe natif qui écrit sur stderr (pip show -> "WARNING: Package(s) not found")
# lève une NativeCommandError TERMINANTE sous $ErrorActionPreference='Stop'
# (#3411, mesuré po-2028) — on baisse l'EAP le temps de l'appel et on décide
# sur $LASTEXITCODE, pas sur la forme de la sortie.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$skCheck = & $pip show semantic-kernel 2>$null
$skInstalled = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEap
if ($skInstalled) {
    $skVersion = ($skCheck | Where-Object { $_ -match '^Version:\s*(.+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
    Write-Host "  ✓ semantic-kernel already installed: $skVersion" -ForegroundColor Green
} else {
    Write-Host "  Installing semantic-kernel..." -ForegroundColor Cyan
    & $pip install "semantic-kernel[mcp]>=1.39" "mcp>=1.26,<2" "openai>=1.109" "Pillow>=10.0" "httpx>=0.27" "qdrant-client"
    Write-Host "  ✓ Dependencies installed" -ForegroundColor Green
}

# 3b. Venv dédié markitdown (#3411) — markitdown-mcp exige mcp>=2.1.1 ; le venv
# principal reste sous mcp<2 (sk_agent.py utilise l'API mcp 1.x,
# mcp.server.fastmcp, retirée en 2.x — plafond explicite dans requirements.txt).
# Serveur stdio séparé : aucune bibliothèque partagée, l'isolement ne coûte rien.
$MarkitdownVenv = "$SkAgentDir\venv-markitdown"
if (-not $SkipVenv) {
    # pip.exe (pas le répertoire) : un venv cassé en cours de création doit se refaire
    if (-not (Test-Path "$MarkitdownVenv\Scripts\pip.exe")) {
        Write-Host "  Creating venv-markitdown..." -ForegroundColor Cyan
        python -m venv $MarkitdownVenv --clear
        if ($LASTEXITCODE -ne 0) { throw "venv-markitdown creation failed (exit $LASTEXITCODE)" }
    }
    & "$MarkitdownVenv\Scripts\pip.exe" install -q -r "$SkAgentDir\requirements-markitdown.txt"
    if ($LASTEXITCODE -ne 0) { throw "venv-markitdown pip install failed (exit $LASTEXITCODE)" }
    Write-Host "  ✓ venv-markitdown ready (markitdown MCP)" -ForegroundColor Green
}

# 4. Créer la config si nécessaire
if (-not $SkipConfig) {
    Write-Host "[4/5] Setting up configuration..." -ForegroundColor Yellow

    # ms#1519: source de vérité unique — servir le template TRACKÉ quand il est présent.
    # Avant : hash inline figé à l'ère glm-4.6v, un siège neuf démarrait avec des modèles
    # obsolètes sans que personne ne le voie.
    $TemplateFile = Join-Path $SkAgentDir "sk_agent_config.template.json"

    # Repli inline DERNIER RECOURS (template absent) — roster courant aligné sur le template
    # v2 (ms#1519 : directive user 25/10 — pas de vieux noms de modèles qui traînent).
    $ConfigTemplate = @{
        default_ask_model = "glm-5.3"
        default_vision_model = "swift-1.5-27b"
        max_recursion_depth = 2
        models = @(
            @{
                id = "glm-5.3"
                enabled = $true
                base_url = "http://192.168.0.50:3000/v1"
                api_key = ""  # À remplir
                model_id = "glm-5.3"
                vision = $false
                description = "Text model (GLM-5.3 via routeur myia)"
                context_window = 200000
            },
            @{
                id = "glm-5.3-flash"
                enabled = $true
                base_url = "http://192.168.0.50:3000/v1"
                api_key = ""  # À remplir
                model_id = "glm-5.3-flash"
                vision = $false
                description = "Fast text (GLM-5.3-flash via routeur myia)"
                context_window = 131072
            },
            @{
                id = "swift-1.5-27b"
                enabled = $true
                base_url = "https://api.medium.text-generation-webui.myia.io/v1"
                api_key = ""  # À remplir
                model_id = "swift-1.5-27b"
                vision = $true
                description = "Vision model (Swift-1.5-27B via myia.io)"
                context_window = 262144
            },
            @{
                id = "qwen3.6-35b-a3b"
                enabled = $true
                base_url = "https://api.medium.text-generation-webui.myia.io/v1"
                api_key = ""  # À remplir
                model_id = "qwen3.6-35b-a3b"
                vision = $true
                description = "Vision/text (Qwen3.6-35B-A3B via myia.io)"
                context_window = 262144
            }
        )
    }

    if (Test-Path $ConfigFile) {
        Write-Host "  ✓ Config already exists" -ForegroundColor Green
    } elseif (Test-Path $TemplateFile) {
        Write-Host "  Creating config from tracked template..." -ForegroundColor Cyan
        Copy-Item -Path $TemplateFile -Destination $ConfigFile
        Write-Host "  ⚠ Config created from template - PLEASE EDIT API KEYS: $ConfigFile" -ForegroundColor Yellow
    } else {
        Write-Host "  ⚠ sk_agent_config.template.json ABSENT - using refreshed inline fallback (ms#1519)" -ForegroundColor Yellow
        $ConfigTemplate | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile -Encoding UTF8
        Write-Host "  ⚠ Config created (inline fallback) - PLEASE EDIT API KEYS: $ConfigFile" -ForegroundColor Yellow
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
# Chemins réels du déploiement, backslashes doublés pour JSON valide
$SampleCommand = ("$VenvDir\Scripts\python.exe").Replace('\', '\\')
$SampleArgs = ("$SkAgentDir\sk_agent.py").Replace('\', '\\')
$SampleConfig = ("$ConfigFile").Replace('\', '\\')
Write-Host '   "sk-agent": {' -ForegroundColor Gray
Write-Host "     `"command`": `"$SampleCommand`"," -ForegroundColor Gray
Write-Host "     `"args`": [`"$SampleArgs`"]," -ForegroundColor Gray
Write-Host "     `"env`": { `"SK_AGENT_CONFIG`": `"$SampleConfig`" }" -ForegroundColor Gray
Write-Host '   }' -ForegroundColor Gray
Write-Host "3. Restart VS Code" -ForegroundColor White
Write-Host ""
