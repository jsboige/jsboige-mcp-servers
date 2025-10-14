# Wrapper script pour capturer TOUS les logs du serveur MCP roo-state-manager
param(
    [string]$ServerPath = "D:\dev\roo-extensions\mcps\internal\servers\roo-state-manager\build\src\index.js"
)

Write-Host "[LOG-WRAPPER] Démarrage du serveur roo-state-manager avec capture complète des logs" -ForegroundColor Green

# Démarrer Node.js et rediriger stdout vers stderr pour le rendre visible
& node $ServerPath 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
        # Logs d'erreur (déjà visible)
        Write-Error $_.ToString()
    } else {
        # Stdout redirigé vers stderr pour le rendre visible  
        [Console]::Error.WriteLine("[STDOUT-CAPTURED] $($_)")
    }
}