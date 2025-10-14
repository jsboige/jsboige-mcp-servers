# Script 03 - Validation de l'environnement Python pour MCP Jupyter Papermill
# Date: 2025-10-09
# Objectif: Vérifier la disponibilité de Python et du module papermill_mcp

Write-Host "[VALIDATION] Vérification de l'environnement Python..." -ForegroundColor Cyan

# 1. Vérifier Python
Write-Host "`n[1] Vérification de Python..." -ForegroundColor Yellow
$pythonPath = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($pythonPath) {
    Write-Host "   ✓ Python trouvé: $pythonPath" -ForegroundColor Green
    $pythonVersion = & python --version 2>&1
    Write-Host "   ✓ Version: $pythonVersion" -ForegroundColor Green
} else {
    Write-Host "   ✗ Python non trouvé dans le PATH" -ForegroundColor Red
    exit 1
}

# 2. Vérifier le module papermill_mcp
Write-Host "`n[2] Vérification du module papermill_mcp..." -ForegroundColor Yellow
$mcpDir = "D:/Dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server"
Push-Location $mcpDir

try {
    $testImport = & python -c "import sys; sys.path.insert(0, '.'); import papermill_mcp; print('Module OK')" 2>&1
    if ($testImport -match "Module OK") {
        Write-Host "   ✓ Module papermill_mcp accessible" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Erreur d'import: $testImport" -ForegroundColor Red
    }
} catch {
    Write-Host "   ✗ Erreur lors du test: $_" -ForegroundColor Red
} finally {
    Pop-Location
}

# 3. Vérifier les dépendances critiques
Write-Host "`n[3] Vérification des dépendances..." -ForegroundColor Yellow
$dependencies = @("mcp", "papermill", "jupyter_client", "nbformat")
foreach ($dep in $dependencies) {
    $check = & python -c "import $dep; print('OK')" 2>&1
    if ($check -match "OK") {
        Write-Host "   ✓ $dep installé" -ForegroundColor Green
    } else {
        Write-Host "   ✗ $dep manquant" -ForegroundColor Red
    }
}

# 4. Résumé de la configuration
Write-Host "`n[RÉSUMÉ] Configuration pour mcp_settings.json:" -ForegroundColor Cyan
Write-Host "   Command: cmd" -ForegroundColor White
Write-Host "   Args: /c, $pythonPath, -m, papermill_mcp.main" -ForegroundColor White
Write-Host "   CWD: $mcpDir" -ForegroundColor White

Write-Host "`n[VALIDATION] Terminée." -ForegroundColor Cyan