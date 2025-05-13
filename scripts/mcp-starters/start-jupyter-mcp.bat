@echo off
setlocal

REM Vérifier si le paramètre --offline est fourni
set OFFLINE_MODE=false
if "%1"=="--offline" (
    set OFFLINE_MODE=true
    set JUPYTER_MCP_OFFLINE=true
    echo Mode hors ligne activé - Le client MCP ne tentera pas de se connecter au serveur Jupyter
)

echo ===== Démarrage des serveurs Jupyter et MCP Jupyter =====

REM Définir les chemins
set PROJECT_ROOT=%~dp0
set JUPYTER_MCP_SERVER=%PROJECT_ROOT%servers\jupyter-mcp-server

REM Vérifier si Jupyter est installé
where jupyter >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Jupyter n'est pas installé ou n'est pas dans le PATH.
    echo Veuillez installer Jupyter avec: pip install jupyter
    exit /b 1
)

REM Vérifier si le serveur MCP Jupyter est compilé
if not exist "%JUPYTER_MCP_SERVER%\dist\index.js" (
    echo Compilation du serveur MCP Jupyter...
    cd "%JUPYTER_MCP_SERVER%" && npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo Échec de la compilation du serveur MCP Jupyter.
        exit /b 1
    )
)

REM Démarrer Jupyter Notebook en arrière-plan
echo Démarrage de Jupyter Notebook...
start "Jupyter Notebook" jupyter notebook --no-browser

REM Attendre que Jupyter Notebook soit prêt
echo Attente du démarrage de Jupyter Notebook...
timeout /t 5 /nobreak >nul

REM Démarrer le serveur MCP Jupyter
echo Démarrage du serveur MCP Jupyter...
if "%OFFLINE_MODE%"=="true" (
    cd "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Server" cmd /c "set JUPYTER_MCP_OFFLINE=true && node dist/index.js"
    echo NOTE: Le client MCP est en mode hors ligne et ne tentera pas de se connecter au serveur Jupyter.
) else (
    cd "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Server" node dist/index.js
)

echo ===== Les deux serveurs ont été démarrés avec succès =====
echo Jupyter Notebook est accessible à l'adresse: http://localhost:8888
echo Le serveur MCP Jupyter est maintenant disponible pour Roo

exit /b 0