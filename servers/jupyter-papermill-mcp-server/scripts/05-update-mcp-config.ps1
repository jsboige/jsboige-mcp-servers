# Script 05 - Migration de la configuration MCP Jupyter (Node.js → Python/Papermill)
# Date: 2025-10-09
# Objectif: Remplacer la configuration Node.js par Python/Papermill avec coexistence temporaire

Write-Host "[MIGRATION] Mise à jour de mcp_settings.json..." -ForegroundColor Cyan

# Chemins
$configFile = "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json"

# Configuration Python/Papermill
$pythonPath = "C:\Python313\python.exe"
$mcpDir = "D:/Dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server"

# 1. Charger la configuration actuelle
Write-Host "`n[1] Chargement de la configuration actuelle..." -ForegroundColor Yellow
try {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    Write-Host "   ✓ Configuration chargée" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Erreur de chargement: $_" -ForegroundColor Red
    exit 1
}

# 2. Sauvegarder l'ancienne config Node.js
Write-Host "`n[2] Migration de la configuration Node.js..." -ForegroundColor Yellow
if ($config.mcpServers.jupyter) {
    # Renommer en jupyter-old pour coexistence
    $config.mcpServers | Add-Member -Name "jupyter-old" -Value $config.mcpServers.jupyter -MemberType NoteProperty -Force
    $config.mcpServers."jupyter-old".disabled = $true
    Write-Host "   ✓ Ancienne configuration sauvegardée en 'jupyter-old' (disabled)" -ForegroundColor Green
} else {
    Write-Host "   ⚠ Aucune configuration 'jupyter' existante" -ForegroundColor Yellow
}

# 3. Créer la nouvelle configuration Python/Papermill
Write-Host "`n[3] Création de la nouvelle configuration Python/Papermill..." -ForegroundColor Yellow

$newConfig = @{
    autoApprove = @()
    args = @("/c", $pythonPath, "-m", "papermill_mcp.main")
    alwaysAllow = @(
        # Outils Notebook
        "read_notebook",
        "write_notebook",
        "create_notebook",
        "add_cell",
        "remove_cell",
        "update_cell",
        # Outils Kernel
        "list_kernels",
        "start_kernel",
        "stop_kernel",
        "interrupt_kernel",
        "restart_kernel",
        "execute_cell",
        "execute_notebook",
        "execute_notebook_cell",
        # Outils Avancés
        "execute_notebook_papermill",
        "list_notebook_files",
        "get_notebook_info",
        "get_kernel_status",
        "cleanup_all_kernels",
        "start_jupyter_server",
        "stop_jupyter_server"
    )
    command = "cmd"
    transportType = "stdio"
    disabled = $false
    autoStart = $true
    description = "Serveur MCP Python/Papermill pour opérations Jupyter Notebook"
    options = @{
        cwd = $mcpDir
    }
}

# Convertir en objet PSCustomObject pour compatibilité JSON
$newConfigObj = [PSCustomObject]$newConfig

# Ajouter/Remplacer la configuration jupyter
$config.mcpServers | Add-Member -Name "jupyter" -Value $newConfigObj -MemberType NoteProperty -Force

Write-Host "   ✓ Nouvelle configuration créée" -ForegroundColor Green
Write-Host "   ✓ Command: cmd" -ForegroundColor Green
Write-Host "   ✓ Python: $pythonPath" -ForegroundColor Green
Write-Host "   ✓ Module: papermill_mcp.main" -ForegroundColor Green
Write-Host "   ✓ CWD: $mcpDir" -ForegroundColor Green
Write-Host "   ✓ Outils autorisés: $($newConfig.alwaysAllow.Count)" -ForegroundColor Green

# 4. Valider le JSON avant écriture
Write-Host "`n[4] Validation de la nouvelle configuration..." -ForegroundColor Yellow
try {
    $jsonString = $config | ConvertTo-Json -Depth 10
    $null = $jsonString | ConvertFrom-Json  # Test de parsing
    Write-Host "   ✓ JSON valide" -ForegroundColor Green
} catch {
    Write-Host "   ✗ JSON invalide: $_" -ForegroundColor Red
    exit 1
}

# 5. Écrire la nouvelle configuration
Write-Host "`n[5] Écriture de la nouvelle configuration..." -ForegroundColor Yellow
try {
    $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
    Write-Host "   ✓ Configuration mise à jour" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Erreur d'écriture: $_" -ForegroundColor Red
    exit 1
}

# 6. Vérification post-écriture
Write-Host "`n[6] Vérification de l'écriture..." -ForegroundColor Yellow
try {
    $verify = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($verify.mcpServers.jupyter -and $verify.mcpServers.jupyter.command -eq "cmd") {
        Write-Host "   ✓ Configuration vérifiée avec succès" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Vérification échouée" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "   ✗ Erreur de vérification: $_" -ForegroundColor Red
    exit 1
}

# 7. Résumé
Write-Host "`n[RÉSUMÉ] Migration réussie:" -ForegroundColor Cyan
Write-Host "   ✓ Ancienne config Node.js → 'jupyter-old' (disabled)" -ForegroundColor White
Write-Host "   ✓ Nouvelle config Python → 'jupyter' (active)" -ForegroundColor White
Write-Host "   ✓ Backup disponible pour rollback" -ForegroundColor White

Write-Host "`n[PROCHAINES ÉTAPES]" -ForegroundColor Yellow
Write-Host "   1. Redémarrer VS Code ou recharger la fenêtre:" -ForegroundColor Gray
Write-Host "      Ctrl+Shift+P → 'Developer: Reload Window'" -ForegroundColor Gray
Write-Host "   2. Vérifier les logs MCP pour confirmer le chargement" -ForegroundColor Gray
Write-Host "   3. Tester les outils du nouveau serveur MCP" -ForegroundColor Gray

Write-Host "`n[ROLLBACK] En cas de problème:" -ForegroundColor Yellow
Write-Host "   Restaurer le backup avec le script 04" -ForegroundColor Gray

Write-Host "`n[MIGRATION] Terminée." -ForegroundColor Cyan