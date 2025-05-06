@echo off
echo ===== Démarrage des serveurs Jupyter et MCP Jupyter =====

REM Chemins absolus pour éviter les problèmes de chemin relatif
set JUPYTER_PATH=C:\Python313\Scripts\jupyter.exe
set JUPYTER_MCP_SERVER=d:\Dev\jsboige-mcp-servers\servers\jupyter-mcp-server

REM Vérifier si Jupyter est installé
if not exist "%JUPYTER_PATH%" (
    echo Jupyter n'est pas trouvé à l'emplacement %JUPYTER_PATH%.
    echo Veuillez installer Jupyter avec: pip install jupyter
    exit /b 1
)

REM Vérifier si le serveur MCP Jupyter est compilé
if not exist "%JUPYTER_MCP_SERVER%\dist\index.js" (
    echo Compilation du serveur MCP Jupyter...
    cd /d "%JUPYTER_MCP_SERVER%"
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo Échec de la compilation du serveur MCP Jupyter.
        exit /b 1
    )
)

REM Démarrer Jupyter Notebook en arrière-plan avec un port différent
echo Démarrage de Jupyter Notebook sur le port 8889...
start "Jupyter Notebook" "%JUPYTER_PATH%" notebook --no-browser --port=8889

REM Attendre que Jupyter Notebook soit prêt
echo Attente du démarrage de Jupyter Notebook...
timeout /t 5 /nobreak

REM Démarrer le serveur MCP Jupyter
echo Démarrage du serveur MCP Jupyter...
cd /d "%JUPYTER_MCP_SERVER%"
start "MCP Jupyter Server" node dist/index.js

echo ===== Les deux serveurs ont été démarrés avec succès =====
echo Jupyter Notebook est accessible à l'adresse: http://localhost:8889
echo Le serveur MCP Jupyter est maintenant disponible pour Roo

exit /b 0