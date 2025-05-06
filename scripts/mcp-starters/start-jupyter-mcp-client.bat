@echo off
echo ===== Démarrage du client MCP Jupyter =====

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
    echo.
    echo ATTENTION: Un fichier de configuration par défaut a été créé.
    echo Si votre serveur Jupyter utilise un token, veuillez éditer le fichier:
    echo %CONFIG_FILE%
    echo et spécifier le token correct avant de continuer.
    echo.
    echo Pour obtenir le token, consultez la sortie du serveur Jupyter
    echo ou accédez à http://localhost:8888 dans votre navigateur.
    echo.
    pause
)

REM Démarrer le serveur MCP Jupyter
echo Démarrage du client MCP Jupyter...
cd /d "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Client" node dist/index.js

echo ===== Client MCP Jupyter démarré avec succès =====
echo Le client MCP Jupyter est maintenant disponible pour Roo
echo.
echo NOTE: Ce script suppose qu'un serveur Jupyter est déjà en cours d'exécution.
echo Si ce n'est pas le cas, veuillez d'abord exécuter start-jupyter-server.bat

exit /b 0