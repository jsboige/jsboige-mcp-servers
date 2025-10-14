# Guide de déploiement du MCP Quickfiles

Ce document explique comment compiler et tester les modifications apportées au serveur MCP Quickfiles.

## Prérequis

- Node.js (version 14 ou supérieure)
- NPM (généralement installé avec Node.js)
- TypeScript (`npm install -g typescript`)

## Structure du projet

Le projet MCP Quickfiles est organisé comme suit :

- `src/` : Contient les fichiers source TypeScript
  - `index.ts` : Point d'entrée principal du serveur MCP
- `build/` : Contient les fichiers JavaScript compilés
- `__tests__/` : Contient les tests unitaires et d'intégration
- `tsconfig.json` : Configuration TypeScript
- `package.json` : Configuration du projet et dépendances

## Processus de développement

Lorsque vous modifiez le code source du serveur dans le répertoire `src/`, vous devez le recompiler pour que vos changements prennent effet.

### Compilation

Le processus de compilation convertit les fichiers TypeScript (`.ts`) en fichiers JavaScript (`.js`) exécutables par Node.js.

Pour compiler le serveur, exécutez les commandes suivantes à la racine du serveur (`mcps/internal/servers/quickfiles-server`) :

```bash
# S'assurer que les dépendances sont installées
npm install

# Compiler le code
npm run build
```

Cette commande va nettoyer le répertoire `build/` et y placer les fichiers JavaScript compilés. L'application hôte (Roo) redémarrera automatiquement le serveur si elle est en cours d'exécution.

## Vérification des modifications

Pour vérifier que vos modifications fonctionnent comme prévu :

1.  Compilez le code comme décrit ci-dessus.
2.  Assurez-vous que Roo est en cours d'exécution et que le serveur `quickfiles` est activé.
3.  Testez les outils que vous avez modifiés directement depuis l'interface de Roo.
4.  Consultez les logs de Roo pour toute erreur provenant du serveur Quickfiles.

## Résolution des problèmes courants

### Erreur : "Le fichier tsconfig.json n'a pas été trouvé"

Assurez-vous d'exécuter le script depuis le répertoire racine du projet MCP Quickfiles.

### Erreur : "Node.js et NPM sont requis pour exécuter ce script"

Installez Node.js depuis https://nodejs.org/ et assurez-vous qu'il est correctement ajouté à votre PATH.

### Erreur lors de la compilation TypeScript

Vérifiez les erreurs de syntaxe dans les fichiers source TypeScript et corrigez-les avant de relancer la compilation.

### Le serveur MCP ne démarre pas

Vérifiez la console de Roo pour des messages d'erreur liés au démarrage du processus du serveur `quickfiles`. Assurez-vous que la commande dans votre configuration de serveur est correcte et que les fichiers compilés existent bien dans le répertoire `build/`.

## Maintenance continue

Pour maintenir le serveur MCP Quickfiles à jour :

1. Mettez à jour régulièrement les dépendances dans `package.json`
2. Exécutez `npm update` pour installer les dernières versions des dépendances
3. Recompilez et redéployez le serveur après chaque mise à jour

## Nouveaux outils disponibles

Après le déploiement, les outils suivants seront disponibles dans le serveur MCP Quickfiles :

1. `read_multiple_files` : Lit plusieurs fichiers en une seule requête
2. `list_directory_contents` : Liste le contenu des répertoires avec options de filtrage et de tri
3. `delete_files` : Supprime une liste de fichiers
4. `edit_multiple_files` : Édite plusieurs fichiers en appliquant des diffs
5. `extract_markdown_structure` : Analyse les fichiers markdown et extrait les titres
6. `search_in_files` : Recherche des motifs dans plusieurs fichiers
7. `search_and_replace` : Recherche et remplace du texte dans plusieurs fichiers