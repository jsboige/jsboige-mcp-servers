#!/bin/bash

echo "===== Démarrage des serveurs Jupyter et MCP Jupyter ====="

# Définir les chemins
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_MCP_SERVER="${PROJECT_ROOT}/servers/jupyter-mcp-server"

# Vérifier si Jupyter est installé
if ! command -v jupyter &> /dev/null; then
    echo "Jupyter n'est pas installé ou n'est pas dans le PATH."
    echo "Veuillez installer Jupyter avec: pip install jupyter"
    exit 1
fi

# Vérifier si le serveur MCP Jupyter est compilé
if [ ! -f "${JUPYTER_MCP_SERVER}/dist/index.js" ]; then
    echo "Compilation du serveur MCP Jupyter..."
    cd "${JUPYTER_MCP_SERVER}" && npm run build
    if [ $? -ne 0 ]; then
        echo "Échec de la compilation du serveur MCP Jupyter."
        exit 1
    fi
fi

# Démarrer Jupyter Notebook en arrière-plan
echo "Démarrage de Jupyter Notebook..."
jupyter notebook --no-browser &
JUPYTER_PID=$!

# Attendre que Jupyter Notebook soit prêt
echo "Attente du démarrage de Jupyter Notebook..."
sleep 5

# Démarrer le serveur MCP Jupyter
echo "Démarrage du serveur MCP Jupyter..."
cd "${JUPYTER_MCP_SERVER}" && node dist/index.js &
MCP_PID=$!

echo "===== Les deux serveurs ont été démarrés avec succès ====="
echo "Jupyter Notebook est accessible à l'adresse: http://localhost:8888"
echo "Le serveur MCP Jupyter est maintenant disponible pour Roo"
echo "PIDs: Jupyter=${JUPYTER_PID}, MCP=${MCP_PID}"
echo "Pour arrêter les serveurs, utilisez: kill ${JUPYTER_PID} ${MCP_PID}"

# Attendre que les processus se terminent
wait