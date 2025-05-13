@echo off
echo ===== Démarrage du serveur Jupyter =====

REM Vérifier si Jupyter est installé
where jupyter >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Jupyter n'est pas installé ou n'est pas dans le PATH.
    echo Veuillez installer Jupyter avec: pip install jupyter
    exit /b 1
)

REM Démarrer Jupyter Notebook en arrière-plan
echo Démarrage de Jupyter Notebook avec token d'authentification...
start "Jupyter Notebook" jupyter notebook --NotebookApp.token=test_token --NotebookApp.allow_origin=* --no-browser

REM Afficher un message d'information
echo ===== Serveur Jupyter démarré avec succès =====
echo Jupyter Notebook est accessible à l'adresse: http://localhost:8888
echo Pour connecter le client MCP Jupyter à ce serveur, exécutez start-jupyter-mcp-client.bat

exit /b 0