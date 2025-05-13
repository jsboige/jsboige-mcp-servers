@echo off
REM Script pour démarrer le serveur MCP Jupyter en arrière-plan sans afficher de terminal
REM Ce script utilise VBScript pour masquer complètement la fenêtre du terminal

REM Obtenir le chemin absolu du répertoire du script
set SCRIPT_DIR=%~dp0
set NODE_SCRIPT=%SCRIPT_DIR%start-jupyter-mcp-offline.js
set VBS_SCRIPT=%SCRIPT_DIR%run-hidden.vbs

REM Exécuter le script Node.js en arrière-plan via VBScript
wscript "%VBS_SCRIPT%" node "%NODE_SCRIPT%"

REM Aucun message n'est affiché car le script s'exécute en arrière-plan
exit /b 0