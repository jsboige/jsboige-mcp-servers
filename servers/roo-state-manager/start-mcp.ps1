# Définir le répertoire de travail au répertoire du script
$PSScriptRoot = Split-Path -Parent -Path $MyInvocation.MyCommand.Definition
Set-Location -Path $PSScriptRoot

# Démarrer le serveur MCP
npm start