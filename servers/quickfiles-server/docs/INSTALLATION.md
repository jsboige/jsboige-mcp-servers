<!-- START_SECTION: metadata -->
---
title: "Installation du serveur MCP QuickFiles"
description: "Guide d'installation complet pour le serveur MCP QuickFiles"
tags: #installation #quickfiles #mcp #guide
date_created: "2025-05-14"
date_updated: "2025-05-14"
version: "1.0.0"
author: "Équipe MCP"
---
<!-- END_SECTION: metadata -->

# Installation du serveur MCP QuickFiles

<!-- START_SECTION: prerequisites -->
## Prérequis

Avant d'installer le serveur MCP QuickFiles, assurez-vous que votre système répond aux exigences suivantes :

- **Node.js** : Version 14.x ou supérieure
- **npm** : Version 6.x ou supérieure
- **Espace disque** : Au moins 100 Mo d'espace libre
- **Mémoire** : Au moins 512 Mo de RAM disponible
- **Système d'exploitation** : Windows, macOS ou Linux
<!-- END_SECTION: prerequisites -->

<!-- START_SECTION: installation_steps -->
## Intégration du serveur

Le serveur MCP QuickFiles est conçu pour être utilisé au sein de l'écosystème Roo. En tant que tel, il n'y a pas d'étapes d'installation traditionnelles. Le serveur est inclus dans le projet et est activé via la configuration.

### Activation du serveur

Pour activer le serveur, assurez-vous qu'il est correctement défini dans votre configuration de serveurs MCP avec le type `stdio`.

```json
{
  "name": "quickfiles",
  "type": "stdio",
  "command": "node ./mcps/internal/servers/quickfiles-server/build/index.js",
  "enabled": true,
  "autoStart": true,
  "description": "Serveur MCP pour manipuler rapidement plusieurs fichiers"
}
```

### Compilation

Si vous modifiez le code source du serveur (situé dans `mcps/internal/servers/quickfiles-server/src`), vous devrez le recompiler :

```bash
cd mcps/internal/servers/quickfiles-server
npm install
npm run build
```

Cela mettra à jour les fichiers JavaScript dans le répertoire `build/` qui sont exécutés par la commande de démarrage.
<!-- END_SECTION: installation_steps -->

<!-- START_SECTION: post_installation -->
## Configuration post-installation

### Autorisations de fichiers

Le serveur QuickFiles nécessite des autorisations de lecture et d'écriture sur les répertoires qu'il doit manipuler. Assurez-vous que l'utilisateur qui exécute le serveur dispose des permissions nécessaires.


<!-- END_SECTION: post_installation -->

<!-- START_SECTION: troubleshooting -->
## Dépannage de l'installation

### Problèmes courants

#### Erreur "Module not found"

**Problème** : Erreur indiquant qu'un module n'a pas été trouvé lors de l'exécution.

**Solution** :
- Vérifiez que toutes les dépendances ont été installées avec `npm install`
- Vérifiez que le projet a été compilé avec `npm run build`
- Essayez de supprimer le répertoire `node_modules` et le fichier `package-lock.json`, puis réinstallez les dépendances

#### Erreur de permissions

**Problème** : Erreurs liées aux permissions lors de l'accès aux fichiers.

**Solution** :
- Vérifiez que l'utilisateur qui exécute le serveur a les permissions nécessaires sur les répertoires concernés
- Exécutez le serveur avec des privilèges plus élevés si nécessaire (non recommandé pour la production)
- Modifiez les permissions des répertoires concernés
<!-- END_SECTION: troubleshooting -->

<!-- START_SECTION: next_steps -->
## Prochaines étapes

Maintenant que vous avez installé le serveur QuickFiles, vous pouvez :

1. [Configurer le serveur](CONFIGURATION.md) selon vos besoins
2. [Apprendre à utiliser le serveur](USAGE.md) avec des exemples pratiques
3. [Consulter le guide de dépannage](TROUBLESHOOTING.md) en cas de problèmes
4. [Explorer les cas d'utilisation avancés](../../docs/quickfiles-use-cases.md) pour tirer le meilleur parti du serveur
<!-- END_SECTION: next_steps -->

<!-- START_SECTION: navigation -->
## Navigation

- [Index principal](../../../INDEX.md)
- [Index des MCPs internes](../../INDEX.md)
- [Documentation QuickFiles](./README.md)
- [Configuration](./CONFIGURATION.md)
- [Utilisation](./USAGE.md)
- [Dépannage](./TROUBLESHOOTING.md)
- [Guide de recherche](../../../SEARCH.md)
<!-- END_SECTION: navigation -->