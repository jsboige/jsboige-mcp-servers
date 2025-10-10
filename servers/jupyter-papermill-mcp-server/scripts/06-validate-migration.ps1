# Script 06 - Validation de la migration MCP Jupyter
# Date: 2025-10-09
# Objectif: Valider que la migration Node.js → Python/Papermill est correcte

Write-Host "[VALIDATION] Vérification de la migration..." -ForegroundColor Cyan

$configFile = "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json"
$allChecksPass = $true

# 1. Vérifier que le fichier existe et est valide
Write-Host "`n[1] Vérification du fichier de configuration..." -ForegroundColor Yellow
if (Test-Path $configFile) {
    Write-Host "   ✓ Fichier trouvé" -ForegroundColor Green
    try {
        $config = Get-Content $configFile -Raw | ConvertFrom-Json
        Write-Host "   ✓ JSON valide" -ForegroundColor Green
    } catch {
        Write-Host "   ✗ JSON invalide: $_" -ForegroundColor Red
        $allChecksPass = $false
    }
} else {
    Write-Host "   ✗ Fichier introuvable" -ForegroundColor Red
    $allChecksPass = $false
    exit 1
}

# 2. Vérifier la nouvelle configuration Python
Write-Host "`n[2] Vérification de la configuration 'jupyter' (Python/Papermill)..." -ForegroundColor Yellow
if ($config.mcpServers.jupyter) {
    $jupyterConfig = $config.mcpServers.jupyter
    
    # Vérifier la commande
    if ($jupyterConfig.command -eq "cmd") {
        Write-Host "   ✓ Command: cmd" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Command incorrecte: $($jupyterConfig.command)" -ForegroundColor Red
        $allChecksPass = $false
    }
    
    # Vérifier les args
    if ($jupyterConfig.args -contains "C:\Python313\python.exe") {
        Write-Host "   ✓ Python path: C:\Python313\python.exe" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Python path manquant ou incorrect" -ForegroundColor Red
        $allChecksPass = $false
    }
    
    if ($jupyterConfig.args -contains "papermill_mcp.main") {
        Write-Host "   ✓ Module: papermill_mcp.main" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Module manquant ou incorrect" -ForegroundColor Red
        $allChecksPass = $false
    }
    
    # Vérifier le CWD
    $expectedCwd = "D:/Dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server"
    if ($jupyterConfig.options.cwd -eq $expectedCwd) {
        Write-Host "   ✓ CWD: $expectedCwd" -ForegroundColor Green
        
        # Vérifier que le répertoire existe
        if (Test-Path $expectedCwd) {
            Write-Host "   ✓ Répertoire CWD existe" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Répertoire CWD introuvable" -ForegroundColor Red
            $allChecksPass = $false
        }
    } else {
        Write-Host "   ✗ CWD incorrect: $($jupyterConfig.options.cwd)" -ForegroundColor Red
        $allChecksPass = $false
    }
    
    # Vérifier l'état
    if ($jupyterConfig.disabled -eq $false) {
        Write-Host "   ✓ État: activé" -ForegroundColor Green
    } else {
        Write-Host "   ✗ État: désactivé" -ForegroundColor Red
        $allChecksPass = $false
    }
    
    # Vérifier les outils autorisés
    $toolCount = $jupyterConfig.alwaysAllow.Count
    Write-Host "   ✓ Outils autorisés: $toolCount" -ForegroundColor Green
    
    # Vérifier quelques outils clés
    $keyTools = @("execute_notebook_papermill", "list_kernels", "read_notebook")
    foreach ($tool in $keyTools) {
        if ($jupyterConfig.alwaysAllow -contains $tool) {
            Write-Host "     ✓ $tool" -ForegroundColor Green
        } else {
            Write-Host "     ✗ $tool manquant" -ForegroundColor Red
            $allChecksPass = $false
        }
    }
} else {
    Write-Host "   ✗ Configuration 'jupyter' introuvable" -ForegroundColor Red
    $allChecksPass = $false
}

# 3. Vérifier l'ancienne configuration
Write-Host "`n[3] Vérification de la configuration 'jupyter-old' (Node.js)..." -ForegroundColor Yellow
if ($config.mcpServers."jupyter-old") {
    $oldConfig = $config.mcpServers."jupyter-old"
    
    if ($oldConfig.disabled -eq $true) {
        Write-Host "   ✓ Configuration désactivée (comme attendu)" -ForegroundColor Green
    } else {
        Write-Host "   ⚠ Configuration encore active (devrait être disabled)" -ForegroundColor Yellow
    }
    
    if ($oldConfig.args -contains "dist/index.js") {
        Write-Host "   ✓ Configuration Node.js détectée" -ForegroundColor Green
    } else {
        Write-Host "   ⚠ Configuration Node.js non détectée clairement" -ForegroundColor Yellow
    }
} else {
    Write-Host "   ⚠ Aucune configuration 'jupyter-old' (backup)" -ForegroundColor Yellow
}

# 4. Vérifier le backup
Write-Host "`n[4] Vérification du backup..." -ForegroundColor Yellow
$backupDir = "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\backups"
if (Test-Path $backupDir) {
    $backups = Get-ChildItem -Path $backupDir -Filter "mcp_settings-backup-*.json" | Sort-Object LastWriteTime -Descending
    if ($backups.Count -gt 0) {
        $latestBackup = $backups[0]
        Write-Host "   ✓ Backup trouvé: $($latestBackup.Name)" -ForegroundColor Green
        Write-Host "   ✓ Date: $($latestBackup.LastWriteTime)" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Aucun backup trouvé" -ForegroundColor Red
        $allChecksPass = $false
    }
} else {
    Write-Host "   ✗ Répertoire de backup introuvable" -ForegroundColor Red
    $allChecksPass = $false
}

# 5. Résumé final
Write-Host "`n[RÉSUMÉ]" -ForegroundColor Cyan
if ($allChecksPass) {
    Write-Host "   ✓ TOUTES LES VALIDATIONS RÉUSSIES" -ForegroundColor Green
    Write-Host "`n   La migration est complète et correcte." -ForegroundColor White
} else {
    Write-Host "   ✗ CERTAINES VALIDATIONS ONT ÉCHOUÉ" -ForegroundColor Red
    Write-Host "`n   Veuillez vérifier les erreurs ci-dessus." -ForegroundColor White
}

Write-Host "`n[PROCHAINES ÉTAPES]" -ForegroundColor Yellow
Write-Host "   1. Redémarrer VS Code : Ctrl+Shift+P → 'Developer: Reload Window'" -ForegroundColor Gray
Write-Host "   2. Vérifier que le serveur MCP démarre dans les logs" -ForegroundColor Gray
Write-Host "   3. Tester les outils Jupyter depuis Roo" -ForegroundColor Gray

Write-Host "`n[VALIDATION] Terminée." -ForegroundColor Cyan

if (-not $allChecksPass) {
    exit 1
}