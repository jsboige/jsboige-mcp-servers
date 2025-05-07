@echo off
echo ===== Démarrage du client MCP Jupyter =====

REM Définir les chemins
set PROJECT_ROOT=%~dp0..\..\
set JUPYTER_MCP_SERVER=%PROJECT_ROOT%servers\jupyter-mcp-server
set CONFIG_FILE=%JUPYTER_MCP_SERVER%\config.json
set BASE_URL=http://localhost:8888

REM Vérifier si le serveur Jupyter est en cours d'exécution
echo Vérification si un serveur Jupyter est en cours d'exécution...
powershell -Command "try { $response = Invoke-WebRequest -Uri '%BASE_URL%' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ATTENTION: Aucun serveur Jupyter n'a été détecté à l'adresse %BASE_URL%
    echo Le client MCP Jupyter a besoin d'un serveur Jupyter en cours d'exécution.
    echo.
    echo Options:
    echo 1. Démarrer un serveur Jupyter avec: start-jupyter-server.bat
    echo 2. Continuer quand même (des erreurs de connexion seront affichées)
    echo 3. Annuler
    echo.
    set /p CHOIX="Votre choix (1-3): "
    
    if "%CHOIX%"=="1" (
        echo.
        echo Démarrage du serveur Jupyter...
        start "Jupyter Server" cmd /c "%~dp0start-jupyter-server.bat"
        echo Attente du démarrage du serveur Jupyter...
        timeout /t 5 /nobreak > nul
    ) else if "%CHOIX%"=="3" (
        echo Opération annulée.
        exit /b 0
    ) else if "%CHOIX%"=="2" (
        echo Continuation sans serveur Jupyter en mode hors ligne...
        set JUPYTER_MCP_OFFLINE=true
    ) else (
        echo Choix invalide. Opération annulée.
        exit /b 1
    )
)

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
    echo     "baseUrl": "%BASE_URL%",>> "%CONFIG_FILE%"
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
    echo ou accédez à %BASE_URL% dans votre navigateur.
    echo.
    pause
)

REM Démarrer le serveur MCP Jupyter
echo Démarrage du client MCP Jupyter...
if defined JUPYTER_MCP_OFFLINE (
    echo Mode hors ligne activé: les vérifications de connexion au serveur Jupyter sont désactivées
    cd /d "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Client" cmd /c "set JUPYTER_MCP_OFFLINE=true && node dist/index.js"
) else (
    cd /d "%JUPYTER_MCP_SERVER%" && start "MCP Jupyter Client" node dist/index.js
)

echo ===== Client MCP Jupyter démarré avec succès =====
echo Le client MCP Jupyter est maintenant disponible pour Roo
echo.
echo NOTE: Ce script suppose qu'un serveur Jupyter est déjà en cours d'exécution.
echo Si ce n'est pas le cas, veuillez d'abord exécuter start-jupyter-server.bat

exit /b 0