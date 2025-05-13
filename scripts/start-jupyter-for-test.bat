@echo off
setlocal enabledelayedexpansion

echo ===== Démarrage du serveur Jupyter pour test avec Roo =====
echo.
echo Ce script va démarrer un serveur Jupyter Notebook en arrière-plan
echo et afficher les informations nécessaires pour configurer le MCP Jupyter.
echo.

REM Vérifier si Jupyter est installé
where jupyter >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Jupyter n'est pas installé ou n'est pas dans le PATH.
    echo Veuillez installer Jupyter avec: pip install jupyter
    exit /b 1
)

REM Générer un token aléatoire (ou utiliser un token fixe pour les tests)
set TOKEN=roo_test_token_%RANDOM%

REM Définir le port (par défaut 8888, mais peut être modifié)
set PORT=8888
set /p PORT_INPUT="Port à utiliser [8888]: "
if not "!PORT_INPUT!"=="" set PORT=!PORT_INPUT!

REM Démarrer Jupyter Notebook en arrière-plan
echo Démarrage de Jupyter Notebook avec token d'authentification...
start "Jupyter Notebook" jupyter notebook --NotebookApp.token=!TOKEN! --NotebookApp.port=!PORT! --NotebookApp.allow_origin=* --no-browser

REM Attendre que le serveur démarre
echo Attente du démarrage du serveur Jupyter...
timeout /t 5 /nobreak > nul

REM Vérifier si le serveur est en cours d'exécution
set BASE_URL=http://localhost:!PORT!
powershell -Command "try { $response = Invoke-WebRequest -Uri '%BASE_URL%' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 (
    echo ERREUR: Le serveur Jupyter n'a pas pu démarrer correctement.
    echo Vérifiez s'il n'y a pas déjà un serveur en cours d'exécution sur le port !PORT!.
    exit /b 1
)

REM Afficher les informations de connexion
echo.
echo ===== Serveur Jupyter démarré avec succès =====
echo.
echo Informations de connexion pour le MCP Jupyter:
echo.
echo URL du serveur: !BASE_URL!
echo Token d'authentification: !TOKEN!
echo.
echo ===== Instructions pour configurer le MCP Jupyter =====
echo.
echo 1. Exécutez le script configure-jupyter-mcp.js avec les commandes suivantes:
echo.
echo    node scripts/configure-jupyter-mcp.js --url !BASE_URL! --token !TOKEN!
echo.
echo 2. Vérifiez que le MCP Jupyter est correctement configuré en exécutant:
echo.
echo    node tests/test-jupyter-connection.js
echo.
echo 3. Si tout est correctement configuré, vous pouvez maintenant utiliser
echo    le MCP Jupyter avec Roo.
echo.
echo Pour arrêter le serveur Jupyter, fermez la fenêtre du terminal correspondante.
echo.

exit /b 0