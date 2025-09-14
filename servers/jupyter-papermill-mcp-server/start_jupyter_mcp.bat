@echo off
REM Script de lancement du serveur jupyter-papermill-mcp avec nettoyage du cache Python
REM Ce script résout le problème de code non mis à jour en forçant la recompilation

echo [MCP] Nettoyage du cache Python...

REM Nettoyer les répertoires __pycache__ récursivement
for /d /r . %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" && echo   Supprimé: %%d

REM Nettoyer les fichiers .pyc individuels
del /s /q "*.pyc" 2>nul

echo [MCP] Cache Python nettoyé.
echo [MCP] Démarrage du serveur MCP...

REM Lancer le serveur avec la configuration de l'environnement Conda
C:/Users/jsboi/.conda/envs/mcp-jupyter/python.exe -m papermill_mcp.main_fastmcp