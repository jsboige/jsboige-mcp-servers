#!/bin/bash

# Script pour démarrer le client MCP Jupyter en mode hors ligne
# Ce script évite les tentatives de connexion au serveur Jupyter au démarrage

echo "Mode hors ligne activé - Le client MCP ne tentera pas de se connecter au serveur Jupyter"

echo "===== Démarrage du serveur MCP Jupyter en mode hors ligne ====="

# Définir les chemins
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_MCP_SERVER="${PROJECT_ROOT}/servers/jupyter-mcp-server"
CONFIG_FILE="${JUPYTER_MCP_SERVER}/config.json"

# Vérifier si le serveur MCP Jupyter est compilé
if [ ! -f "${JUPYTER_MCP_SERVER}/dist/index.js" ]; then
    echo "Compilation du serveur MCP Jupyter..."
    cd "${JUPYTER_MCP_SERVER}" && npm run build
    if [ $? -ne 0 ]; then
        echo "Échec de la compilation du serveur MCP Jupyter."
        exit 1
    fi
fi

# Vérifier si le fichier de configuration existe
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "Création du fichier de configuration par défaut..."
    cat > "${CONFIG_FILE}" << EOF
{
  "jupyterServer": {
    "baseUrl": "http://localhost:8888",
    "token": ""
  }
}
EOF
fi

# Démarrer le client MCP Jupyter en mode hors ligne
echo "Démarrage du client MCP Jupyter en mode hors ligne..."
export JUPYTER_MCP_OFFLINE=true
cd "${JUPYTER_MCP_SERVER}" && node dist/index.js &
MCP_PID=$!

echo "===== Client MCP Jupyter démarré en mode hors ligne ====="
echo "Le client MCP Jupyter est maintenant disponible pour Roo"
echo ""
echo "NOTE: Le client est en mode hors ligne et ne tentera pas de se connecter à un serveur Jupyter."
echo "Pour utiliser les fonctionnalités nécessitant un serveur Jupyter, démarrez manuellement Jupyter Notebook."
echo "PID: MCP=${MCP_PID}"
echo "Pour arrêter le serveur, utilisez: kill ${MCP_PID}"

# Attendre que le processus se termine
wait