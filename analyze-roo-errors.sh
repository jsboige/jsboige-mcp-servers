#!/bin/bash

echo "===== Analyse des logs d'erreurs Roo pour MCP Jupyter ====="

if [ -z "$1" ]; then
  echo "Utilisation du fichier de log par défaut: roo-errors.log"
  node analyze-roo-errors.js
else
  echo "Analyse du fichier: $1"
  node analyze-roo-errors.js "$1"
fi

echo "===== Analyse terminée ====="
echo "Le rapport a été généré dans roo-errors-analysis.md"
echo "Appuyez sur Entrée pour continuer..."
read