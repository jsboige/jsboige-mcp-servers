@echo off
REM Wrapper simple pour capturer tous les logs du serveur MCP
echo [LOG-WRAPPER] Demarrage du serveur roo-state-manager avec capture complete des logs
node "D:\dev\roo-extensions\mcps\internal\servers\roo-state-manager\build\src\index.js" 2>&1