#!/bin/bash

echo "===== Démarrage du serveur MCP Searxng ====="

# Définir les variables d'environnement
export SEARXNG_URL="https://search.myia.io/"

# Démarrer le serveur MCP Searxng
echo "Démarrage du serveur MCP Searxng..."
mcp-searxng &
SEARXNG_PID=$!

echo "===== Le serveur a été démarré avec succès ====="
echo "Le serveur MCP Searxng est maintenant disponible pour Roo"

# Gérer la fermeture propre du processus
trap "echo 'Arrêt du serveur MCP Searxng...'; kill $SEARXNG_PID; exit 0" SIGINT SIGTERM

# Attendre que le processus se termine
wait $SEARXNG_PID