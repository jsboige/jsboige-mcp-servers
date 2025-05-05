@echo off
echo ===== Démarrage du serveur MCP Searxng =====

REM Définir les variables d'environnement
set SEARXNG_URL=https://search.myia.io/

REM Démarrer le serveur MCP Searxng
echo Démarrage du serveur MCP Searxng...
start "MCP Searxng Server" mcp-searxng

echo ===== Le serveur a été démarré avec succès =====
echo Le serveur MCP Searxng est maintenant disponible pour Roo

exit /b 0