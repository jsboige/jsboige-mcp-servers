@echo off
echo ===== Script de démarrage manuel pour MCP Jupyter =====
echo.
echo Ce script vous permet de démarrer le serveur Jupyter et le client MCP Jupyter
echo de manière contrôlée, sans démarrage automatique par VSCode.
echo.

:MENU
echo Que souhaitez-vous faire ?
echo 1. Démarrer uniquement le serveur Jupyter
echo 2. Démarrer uniquement le client MCP Jupyter
echo 3. Démarrer les deux (serveur Jupyter + client MCP)
echo 4. Quitter
echo.

set /p CHOIX="Votre choix (1-4): "

if "%CHOIX%"=="1" goto START_SERVER
if "%CHOIX%"=="2" goto START_CLIENT
if "%CHOIX%"=="3" goto START_BOTH
if "%CHOIX%"=="4" goto EXIT
echo Choix invalide. Veuillez réessayer.
goto MENU

:START_SERVER
echo.
echo Démarrage du serveur Jupyter...
call "%~dp0start-jupyter-server.bat"
echo.
echo Serveur Jupyter démarré. Vous pouvez maintenant démarrer le client MCP Jupyter si nécessaire.
goto EXIT

:START_CLIENT
echo.
echo Démarrage du client MCP Jupyter...
call "%~dp0start-jupyter-mcp-client.bat"
echo.
echo Client MCP Jupyter démarré. Assurez-vous qu'un serveur Jupyter est en cours d'exécution.
goto EXIT

:START_BOTH
echo.
echo Démarrage du serveur Jupyter...
call "%~dp0start-jupyter-server.bat"
echo.
echo Attente du démarrage complet du serveur Jupyter...
timeout /t 5 /nobreak
echo.
echo Démarrage du client MCP Jupyter...
call "%~dp0start-jupyter-mcp-client.bat"
echo.
echo Les deux composants ont été démarrés avec succès.
goto EXIT

:EXIT
echo.
echo ===== Fin du script =====
exit /b 0