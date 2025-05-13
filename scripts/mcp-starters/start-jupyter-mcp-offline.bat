@echo off
REM Script pour démarrer le client MCP Jupyter en mode hors ligne
REM Ce script évite les tentatives de connexion au serveur Jupyter au démarrage

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

REM Vérifier si le fichier de configuration existe
if not exist "%CONFIG_FILE%" (
    echo Création du fichier de configuration par défaut...
    echo {> "%CONFIG_FILE%"
    echo   "jupyterServer": {>> "%CONFIG_FILE%"
    echo     "baseUrl": "http://localhost:8888",>> "%CONFIG_FILE%"
    echo     "token": "">> "%CONFIG_FILE%"
    echo   }>> "%CONFIG_FILE%"
    echo }>> "%CONFIG_FILE%"
)

REM Démarrer le client MCP Jupyter en mode hors ligne
echo Démarrage du client MCP Jupyter en mode hors ligne...
cd /d "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Client" cmd /c "set JUPYTER_MCP_OFFLINE=true && node dist/index.js"

echo ===== Client MCP Jupyter démarré en mode hors ligne =====
echo Le client MCP Jupyter est maintenant disponible pour Roo
echo.
echo NOTE: Le client est en mode hors ligne et ne tentera pas de se connecter à un serveur Jupyter.
echo Pour utiliser les fonctionnalités nécessitant un serveur Jupyter, démarrez manuellement Jupyter Notebook.

exit /b 0