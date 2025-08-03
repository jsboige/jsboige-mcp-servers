# =============================================================================
#
#  SCRIPT: start-jupyter-for-test.ps1
#
#  AUTEUR: Roo
#
#  DATE: 2025-08-03
#
#  DESCRIPTION:
#  Ce script PowerShell est conçu pour démarrer et configurer un serveur
#  Jupyter Notebook pour les tests d'intégration avec le MCP Jupyter de Roo.
#  Il automatise les tâches suivantes :
#     1. Vérification de l'installation de Jupyter.
#     2. Génération d'un token d'authentification aléatoire.
#     3. Démarrage du serveur Jupyter en arrière-plan sur un port spécifié.
#     4. Attente et validation du démarrage effectif du serveur.
#     5. Configuration automatique du MCP jupyter via le script `configure-jupyter-mcp.js`.
#
#  UTILISATION:
#  Exécuter ce script depuis une console PowerShell. 
#  Il affichera l'URL et le token nécessaires à la connexion.
#
#  NOTES:
#  Ce script remplace l'ancienne version `.bat` qui présentait des problèmes
#  d'encodage sur les systèmes Windows non-anglophones.
#
# =============================================================================

Function Start-Jupyter-For-Test {
    param(
        [int]$Port = 8888,
        [string]$Token = "roo_test_token_$(Get-Random)"
    )

    Write-Host '===== Démarrage du serveur Jupyter pour test avec Roo ====='

    # Vérifier si Jupyter est installé
    if (-not (Get-Command jupyter -ErrorAction SilentlyContinue)) {
        Write-Error "Jupyter n'est pas installé ou n'est pas dans le PATH."
        Write-Error "Veuillez installer Jupyter avec la commande : pip install jupyter"
        return
    }

    Write-Host "Démarrage de Jupyter Notebook sur le port $Port..."
    
    # Lancer Jupyter en arrière-plan
    $arguments = "notebook", "--NotebookApp.token=$Token", "--NotebookApp.port=$Port", "--NotebookApp.allow_origin='*'", "--no-browser"
    Start-Process jupyter -ArgumentList $arguments -NoNewWindow

    Write-Host "Attente du démarrage du serveur (10 secondes)..."
    Start-Sleep -Seconds 10

    $baseUrl = "http://localhost:$Port"
    
    # Valider que le serveur est bien démarré
    try {
        $response = Invoke-WebRequest -Uri $baseUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        
        Write-Host "===== Serveur Jupyter démarré avec succès =====" -ForegroundColor Green
        Write-Host "URL du serveur: $baseUrl"
        Write-Host "Token d'authentification: $Token"
        Write-Host "==============================================="

        # Lancer la configuration automatique du MCP
        $configScriptPath = Resolve-Path "configure-jupyter-mcp.cjs"
        if (Test-Path $configScriptPath) {
            Write-Host "Lancement de la configuration automatique du MCP Jupyter..."
            node $configScriptPath --url $baseUrl --token $Token
        } else {
            Write-Warning "Le script de configuration 'configure-jupyter-mcp.js' n'a pas été trouvé."
        }

    } catch {
        Write-Error "ERREUR: Le serveur Jupyter n'a pas démarré ou n'a pas répondu sur $baseUrl."
        Write-Error "Vérifiez qu'aucun autre service n'utilise le port $Port et consultez les logs de Jupyter."
    }
}

# --- Point d'entrée du script ---
Start-Jupyter-For-Test