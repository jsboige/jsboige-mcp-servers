@echo off
REM Script de lancement portable du serveur jupyter-papermill-mcp
REM Détecte automatiquement l'environnement conda mcp-jupyter

echo [MCP] Nettoyage du cache Python...

REM Nettoyer les répertoires __pycache__ récursivement
for /d /r . %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" && echo   Supprimé: %%d

REM Nettoyer les fichiers .pyc individuels
del /s /q "*.pyc" 2>nul

echo [MCP] Cache Python nettoyé.
echo [MCP] Recherche de l'environnement conda mcp-jupyter...

REM Essayer de localiser l'environnement conda mcp-jupyter
set CONDA_ENV_PATH=
for /f "delims=" %%i in ('conda info --envs ^| findstr mcp-jupyter') do (
    for %%j in (%%i) do (
        if exist "%%j\python.exe" (
            set CONDA_ENV_PATH=%%j
            goto :found
        )
    )
)

:found
if "%CONDA_ENV_PATH%"=="" (
    echo [ERREUR] Environnement conda 'mcp-jupyter' non trouvé !
    echo [AIDE] Créez l'environnement avec: conda create -n mcp-jupyter python=3.12 -y
    echo [AIDE] Puis installez les dépendances avec: pip install -e .
    pause
    exit /b 1
)

echo [MCP] Environnement trouvé: %CONDA_ENV_PATH%
echo [MCP] Démarrage du serveur MCP...

REM Lancer le serveur avec l'environnement détecté
"%CONDA_ENV_PATH%\python.exe" -m papermill_mcp.main_fastmcp

if %ERRORLEVEL% neq 0 (
    echo [ERREUR] Échec du démarrage du serveur MCP (code d'erreur: %ERRORLEVEL%)
    echo [AIDE] Vérifiez que toutes les dépendances sont installées
    pause
    exit /b %ERRORLEVEL%
)

echo [MCP] Serveur arrêté normalement.
pause