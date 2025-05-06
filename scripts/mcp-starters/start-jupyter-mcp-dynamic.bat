@echo off
echo ===== Démarrage des serveurs Jupyter et MCP Jupyter =====

REM Définir les chemins absolus
set JUPYTER_PATH=C:\Python313\Scripts\jupyter.exe
set PROJECT_ROOT=d:\Dev\jsboige-mcp-servers
set JUPYTER_MCP_SERVER=%PROJECT_ROOT%\servers\jupyter-mcp-server
set TEMP_LOG_FILE=%TEMP%\jupyter_startup.log
set CONFIG_FILE=%JUPYTER_MCP_SERVER%\config.json

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

REM Démarrer Jupyter Notebook et capturer sa sortie dans un fichier temporaire
echo Démarrage de Jupyter Notebook...
start "Jupyter Notebook" cmd /c "%JUPYTER_PATH% notebook --no-browser > %TEMP_LOG_FILE% 2>&1"

REM Attendre que Jupyter Notebook soit prêt et extraire le port et le token
echo Attente du démarrage de Jupyter Notebook...
set PORT=
set TOKEN=
set MAX_WAIT=30
set WAIT_COUNT=0

:WAIT_LOOP
if %WAIT_COUNT% geq %MAX_WAIT% (
    echo Timeout: Jupyter Notebook n'a pas démarré dans le temps imparti.
    exit /b 1
)

timeout /t 1 /nobreak > nul
set /a WAIT_COUNT+=1

REM Rechercher le port et le token dans le fichier de log
findstr /C:"http://localhost:" %TEMP_LOG_FILE% > nul
if %ERRORLEVEL% equ 0 (
    for /f "tokens=2 delims=:" %%a in ('findstr /C:"http://localhost:" %TEMP_LOG_FILE%') do (
        for /f "tokens=1 delims=/" %%b in ("%%a") do (
            set PORT=%%b
        )
    )
    
    for /f "tokens=2 delims==" %%a in ('findstr /C:"token=" %TEMP_LOG_FILE%') do (
        for /f "tokens=1 delims= " %%b in ("%%a") do (
            set TOKEN=%%b
        )
    )
    
    if defined PORT if defined TOKEN (
        goto PORT_TOKEN_FOUND
    )
)

goto WAIT_LOOP

:PORT_TOKEN_FOUND
echo Jupyter Notebook démarré sur le port %PORT% avec le token %TOKEN%

REM Créer le fichier de configuration pour le serveur MCP Jupyter
echo Création du fichier de configuration pour le serveur MCP Jupyter...
echo {> "%CONFIG_FILE%"
echo   "jupyterServer": {>> "%CONFIG_FILE%"
echo     "baseUrl": "http://localhost:%PORT%",>> "%CONFIG_FILE%"
echo     "token": "%TOKEN%">> "%CONFIG_FILE%"
echo   }>> "%CONFIG_FILE%"
echo }>> "%CONFIG_FILE%"

REM Attendre un peu pour s'assurer que Jupyter est complètement initialisé
timeout /t 2 /nobreak > nul

REM Démarrer le serveur MCP Jupyter
echo Démarrage du serveur MCP Jupyter...
cd /d "%JUPYTER_MCP_SERVER%"
start "MCP Jupyter Server" node dist/index.js

echo ===== Les deux serveurs ont été démarrés avec succès =====
echo Jupyter Notebook est accessible à l'adresse: http://localhost:%PORT%/tree?token=%TOKEN%
echo Le serveur MCP Jupyter est maintenant disponible pour Roo

exit /b 0