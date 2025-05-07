@echo off
setlocal enabledelayedexpansion

echo ===== Connexion du client MCP Jupyter à un serveur existant =====

REM Définir les chemins
set PROJECT_ROOT=%~dp0..\..\
set JUPYTER_MCP_SERVER=%PROJECT_ROOT%servers\jupyter-mcp-server
set CONFIG_FILE=%JUPYTER_MCP_SERVER%\config.json

REM Vérifier si le serveur MCP Jupyter est compilé
if not exist "%JUPYTER_MCP_SERVER%\dist\index.js" (
    echo Compilation du serveur MCP Jupyter...
    cd /d "%JUPYTER_MCP_SERVER%" && npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo Échec de la compilation du serveur MCP Jupyter.
        exit /b 1
    )
)

REM Demander l'URL du serveur Jupyter
set /p JUPYTER_URL="URL du serveur Jupyter [http://localhost:8888]: "
if "!JUPYTER_URL!"=="" set JUPYTER_URL=http://localhost:8888

REM Demander le token d'authentification
set /p JUPYTER_TOKEN="Token d'authentification (laisser vide si aucun): "

REM Afficher les informations de connexion
echo.
echo Connexion au serveur Jupyter:
echo URL: !JUPYTER_URL!
if "!JUPYTER_TOKEN!"=="" (
    echo Token: Aucun
) else (
    echo Token: !JUPYTER_TOKEN!
)
echo.

REM Demander confirmation
set /p CONFIRM="Ces informations sont-elles correctes? (O/N): "
if /i "!CONFIRM!"=="N" (
    echo Opération annulée.
    exit /b 0
)

REM Créer le fichier de configuration
echo Création du fichier de configuration...
echo {> "%CONFIG_FILE%"
echo   "jupyterServer": {>> "%CONFIG_FILE%"
echo     "baseUrl": "!JUPYTER_URL!",>> "%CONFIG_FILE%"
echo     "token": "!JUPYTER_TOKEN!">> "%CONFIG_FILE%"
echo   }>> "%CONFIG_FILE%"
echo }>> "%CONFIG_FILE%"

REM Démarrer le client MCP Jupyter
echo Démarrage du client MCP Jupyter...
cd /d "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Client" node dist/index.js --url "!JUPYTER_URL!" --token "!JUPYTER_TOKEN!"

echo ===== Client MCP Jupyter connecté au serveur existant =====
echo Le client MCP Jupyter est maintenant disponible pour Roo
echo.
echo NOTE: Si vous rencontrez des problèmes de connexion, vérifiez que:
echo 1. Le serveur Jupyter est en cours d'exécution à l'adresse !JUPYTER_URL!
echo 2. Le token d'authentification est correct
echo 3. Aucun pare-feu ne bloque la connexion

exit /b 0