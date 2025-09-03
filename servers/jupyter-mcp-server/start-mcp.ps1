# Version robuste du script de démarrage pour le Jupyter MCP
# Gère le nettoyage, la compilation, le démarrage de la dépendance Jupyter Lab, et le lancement du MCP.

# --- Configuration ---
$McpDirectory = "D:\dev\roo-extensions\mcps\internal\servers\jupyter-mcp-server"
$JupyterLabPath = "C:\Users\jsboi\.conda\envs\mcp-jupyter\Scripts\jupyter-lab.exe"
$NodePath = "C:\Program Files\nodejs\node.exe"

# --- Fonctions ---
function Stop-ProcessByNameAndPath {
    param ([string]$Name, [string]$PathPattern)
    Write-Host "Recherche du processus '$Name' avec le chemin contenant '*$PathPattern*'..."
    try {
        $processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $Name -and ($_.CommandLine -like "*$PathPattern*" -or $_.ExecutablePath -like "*$PathPattern*") }
        if ($processes) {
            foreach ($p in $processes) {
                Write-Host "Arrêt du processus $($p.ProcessId) ($($p.Name))..."
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        } else {
            Write-Host "Aucun processus '$Name' correspondant trouvé."
        }
    } catch {
        Write-Warning "Impossible d'arrêter le processus : $_"
    }
}

# --- Exécution Principale ---

# 1. Nettoyage des anciens processus pour un démarrage propre
Write-Host "[ETAPE 1/4] Nettoyage des anciens processus..."
Stop-ProcessByNameAndPath -Name "node.exe" -PathPattern "jupyter-mcp-server"
Stop-ProcessByNameAndPath -Name "jupyter-lab.exe" -PathPattern "mcp-jupyter"

# 2. Compilation du MCP
Write-Host "[ETAPE 2/4] Compilation du serveur MCP..."
Push-Location $McpDirectory
try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "La compilation (npm run build) a échoué."
    }
    Write-Host "Compilation réussie."
} catch {
    Write-Error "Échec de la compilation. Voir les messages ci-dessus."
    Pop-Location
    exit 1
} finally {
    Pop-Location
}

# 3. Démarrage du serveur Jupyter Lab en arrière-plan
Write-Host "[ETAPE 3/4] Démarrage du serveur Jupyter Lab..."
if (-not (Test-Path $JupyterLabPath)) {
    Write-Error "Le fichier jupyter-lab.exe n'a pas été trouvé à l'adresse '$JupyterLabPath'. Veuillez vérifier le chemin."
    exit 1
}
$jupyterArgs = "--no-browser --ServerApp.token='' --ServerApp.password='' --ServerApp.disable_check_xsrf=True"
Start-Process -FilePath $JupyterLabPath -ArgumentList $jupyterArgs -WindowStyle Minimized
Write-Host "Serveur Jupyter Lab démarré en arrière-plan. Attente de 10 secondes pour l'initialisation..."
Start-Sleep -Seconds 10

# 4. Lancement du serveur MCP
Write-Host "[ETAPE 4/4] Lancement du serveur MCP Jupyter..."
$mcpScriptPath = Join-Path $McpDirectory "dist\index.js"
try {
    & $NodePath $mcpScriptPath
} catch {
    $errorMsg = $_ | Out-String
    $logPath = Join-Path $McpDirectory "start-error.log"
    "$(Get-Date -Format 'u') - Erreur lors du lancement du MCP: $errorMsg" | Out-File -FilePath $logPath -Append -Encoding utf8
    Write-Error "Le serveur MCP a rencontré une erreur fatale. Voir $logPath pour les détails."
    exit 1
}
