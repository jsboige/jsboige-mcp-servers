#!/bin/bash

echo "===== Démarrage de l'outil de capture des erreurs Roo pour MCP Jupyter ====="
echo "Les logs seront enregistrés dans roo-errors.log"

node capture-roo-errors.js

echo "===== Outil de capture des erreurs arrêté ====="
echo "Appuyez sur Entrée pour continuer..."
read