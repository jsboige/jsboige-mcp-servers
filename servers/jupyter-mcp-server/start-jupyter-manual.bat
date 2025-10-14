@echo off
echo Démarrage du serveur Jupyter Lab en arrière-plan...
start "Jupyter Lab" /B conda run -n mcp-jupyter jupyter-lab --no-browser --ServerApp.token='' --ServerApp.password='' --ServerApp.disable_check_xsrf=True
echo Serveur Jupyter démarré.