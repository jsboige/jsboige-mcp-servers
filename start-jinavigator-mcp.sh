#!/bin/bash

echo "===== Démarrage du serveur MCP JinaNavigator ====="

# Définir les chemins
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JINAVIGATOR_MCP_SERVER="${PROJECT_ROOT}/servers/jinavigator-server"

# Vérifier si le serveur MCP JinaNavigator est compilé
if [ ! -f "${JINAVIGATOR_MCP_SERVER}/dist/index.js" ]; then
    echo "Compilation du serveur MCP JinaNavigator..."
    cd "${JINAVIGATOR_MCP_SERVER}" && npm run build
    if [ $? -ne 0 ]; then
        echo "Échec de la compilation du serveur MCP JinaNavigator."
        exit 1
    fi
fi

# Démarrer le serveur MCP JinaNavigator
echo "Démarrage du serveur MCP JinaNavigator..."
cd "${JINAVIGATOR_MCP_SERVER}" && node dist/index.js &
MCP_PID=$!

echo "===== Le serveur a été démarré avec succès ====="
echo "Le serveur MCP JinaNavigator est maintenant disponible pour Roo"
echo "PID: MCP=${MCP_PID}"
echo "Pour arrêter le serveur, utilisez: kill ${MCP_PID}"

# Attendre que le processus se termine
wait