@echo off
echo ===== Démarrage du serveur MCP JinaNavigator =====

REM Définir les chemins
set PROJECT_ROOT=%~dp0
set JINAVIGATOR_MCP_SERVER=%PROJECT_ROOT%servers\jinavigator-server

REM Vérifier si le serveur MCP JinaNavigator est compilé
if not exist "%JINAVIGATOR_MCP_SERVER%\dist\index.js" (
    echo Compilation du serveur MCP JinaNavigator...
    cd "%JINAVIGATOR_MCP_SERVER%" && npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo Échec de la compilation du serveur MCP JinaNavigator.
        exit /b 1
    )
)

REM Démarrer le serveur MCP JinaNavigator
echo Démarrage du serveur MCP JinaNavigator...
cd "%JINAVIGATOR_MCP_SERVER%" && start "MCP JinaNavigator Server" node dist/index.js

echo ===== Le serveur a été démarré avec succès =====
echo Le serveur MCP JinaNavigator est maintenant disponible pour Roo

exit /b 0