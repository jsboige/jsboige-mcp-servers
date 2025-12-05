<!-- START_SECTION: metadata -->
---
title: "Documentation des MCPs Internes"
description: "Point d'entrée pour la documentation des serveurs MCP internes"
tags: #documentation #mcp #internal #index
date_created: "2025-05-14"
date_updated: "2025-05-14"
version: "1.0.0"
author: "Équipe MCP"
---
<!-- END_SECTION: metadata -->

# Documentation des MCPs Internes

<!-- START_SECTION: introduction -->
Ce document sert de point d'entrée pour la documentation des serveurs MCP (Model Context Protocol) internes. Il fournit des liens vers la documentation spécifique de chaque MCP et des informations générales sur leur utilisation.

> **Note** : Ce document fait partie de la documentation complète des MCPs. Pour une vue d'ensemble de tous les MCPs (internes et externes), consultez l'[index principal](../INDEX.md).

## Qu'est-ce qu'un MCP ?

Le Model Context Protocol (MCP) est un protocole qui permet aux modèles de langage (LLM) d'interagir avec des outils et des ressources externes. Il définit un format standard pour :

1. La découverte d'outils et de ressources
2. L'invocation d'outils
3. L'accès aux ressources
4. La gestion des erreurs et des résultats

Ce protocole permet d'étendre considérablement les capacités des LLM en leur donnant accès à des fonctionnalités externes.
<!-- END_SECTION: introduction -->

<!-- START_SECTION: mcp_list -->
## MCPs Internes Disponibles

### [QuickFiles](servers/quickfiles-server/README.md)

QuickFiles est un serveur MCP qui fournit des méthodes pour lire rapidement le contenu de répertoires et fichiers multiples, offrant des fonctionnalités optimisées pour l'accès aux fichiers locaux.

- [README](servers/quickfiles-server/README.md) - Présentation générale et fonctionnalités
- [Installation](servers/quickfiles-server/INSTALLATION.md) - Instructions d'installation spécifiques
- [Configuration](servers/quickfiles-server/CONFIGURATION.md) - Options de configuration détaillées
- [Utilisation](servers/quickfiles-server/USAGE.md) - Exemples d'utilisation et bonnes pratiques
- [Dépannage](servers/quickfiles-server/TROUBLESHOOTING.md) - Résolution des problèmes courants
- [Guide d'utilisation](./docs/quickfiles-guide.md) - Guide complet d'utilisation
- [Cas d'utilisation](./docs/quickfiles-use-cases.md) - Exemples de cas d'utilisation
- [Intégration](./docs/quickfiles-integration.md) - Guide d'intégration avec d'autres systèmes

### [JinaNavigator](servers/jinavigator-server/README.md)

JinaNavigator est un serveur MCP qui utilise l'API Jina pour convertir des pages web en Markdown, offrant un accès facile et formaté au contenu web pour les modèles d'IA.

- [README](servers/jinavigator-server/README.md) - Présentation générale et fonctionnalités
- [Installation](servers/jinavigator-server/INSTALLATION.md) - Instructions d'installation spécifiques
- [Configuration](servers/jinavigator-server/CONFIGURATION.md) - Options de configuration détaillées
- [Utilisation](servers/jinavigator-server/USAGE.md) - Exemples d'utilisation et bonnes pratiques
- [Dépannage](servers/jinavigator-server/TROUBLESHOOTING.md) - Résolution des problèmes courants

### [Jupyter](servers/jupyter-mcp-server/README.md)

Jupyter MCP est un serveur MCP qui permet d'interagir avec des notebooks Jupyter, offrant des fonctionnalités pour la lecture, la modification et l'exécution de notebooks via le protocole MCP.

- [README](servers/jupyter-mcp-server/README.md) - Présentation générale et fonctionnalités
- [Guide d'utilisation](servers/jupyter-mcp-server/README-USAGE.md) - Guide d'utilisation détaillé
- [Installation](servers/jupyter-mcp-server/INSTALLATION.md) - Instructions d'installation spécifiques
- [Configuration](servers/jupyter-mcp-server/CONFIGURATION.md) - Options de configuration détaillées
- [Utilisation](servers/jupyter-mcp-server/USAGE.md) - Exemples d'utilisation et bonnes pratiques
- [Dépannage](servers/jupyter-mcp-server/TROUBLESHOOTING.md) - Résolution des problèmes courants
- [Dépannage avancé](./docs/jupyter-mcp-troubleshooting.md) - Guide de dépannage avancé
- [Mode hors ligne](./docs/jupyter-mcp-offline-mode.md) - Utilisation en mode hors ligne
- [Test de connexion](./docs/jupyter-mcp-connection-test.md) - Test de connexion au serveur Jupyter
<!-- END_SECTION: mcp_list -->

<!-- START_SECTION: general_docs -->
## Documentation Générale

- [Architecture](./docs/architecture.md) - Documentation sur l'architecture MCP
- [Guide de démarrage](./docs/getting-started.md) - Guide de démarrage rapide
- [Dépannage général](./docs/troubleshooting.md) - Guide de dépannage général
<!-- END_SECTION: general_docs -->

<!-- START_SECTION: integration -->
## Intégration avec Roo

Les MCPs internes sont conçus pour être facilement intégrés avec Roo, un assistant IA basé sur des modèles de langage. Cette section explique comment configurer et utiliser les MCPs avec Roo.

### Configuration de Roo pour utiliser les MCPs

1. Assurez-vous que les serveurs MCP sont installés et en cours d'exécution
2. Dans la configuration de Roo, ajoutez les serveurs MCP dans la section appropriée
3. Redémarrez Roo pour prendre en compte les nouveaux serveurs MCP

### Exemples d'utilisation avec Roo

#### QuickFiles avec Roo

```
Utilisateur: Peux-tu lister tous les fichiers JavaScript dans le répertoire src?

Roo: Je vais utiliser QuickFiles pour lister ces fichiers.
[Utilisation de l'outil quickfiles-server.list_directory_contents]
Voici les fichiers JavaScript dans le répertoire src:
- src/app.js
- src/utils.js
- src/components/Button.js
...
```

#### JinaNavigator avec Roo

```
Utilisateur: Peux-tu me résumer la page d'accueil de Mozilla?

Roo: Je vais utiliser JinaNavigator pour convertir cette page en Markdown et la résumer.
[Utilisation de l'outil jinavigator-server.convert_web_to_markdown]
Voici un résumé de la page d'accueil de Mozilla:
...
```

#### Jupyter avec Roo

```
Utilisateur: Crée un notebook Python qui analyse des données de ventes.

Roo: Je vais créer un notebook Jupyter pour analyser des données de ventes.
[Utilisation de l'outil jupyter-mcp-server.create_notebook]
J'ai créé un nouveau notebook. Maintenant, je vais ajouter du code pour l'analyse...
[Utilisation de l'outil jupyter-mcp-server.add_cell]
Le notebook a été créé avec succès avec des cellules pour l'analyse de données de ventes.
```
<!-- END_SECTION: integration -->

<!-- START_SECTION: performance -->
## Performances et Optimisations

Cette section présente des informations sur les performances des MCPs internes et des recommandations pour les optimiser.

### QuickFiles

- **Performances** : QuickFiles est optimisé pour la lecture rapide de fichiers multiples et le listage de répertoires.
- **Optimisations** :
  - Utilisez les extraits de fichiers pour lire uniquement les parties nécessaires des fichiers volumineux
  - Limitez le nombre de lignes lues par fichier avec `max_lines_per_file`
  - Pour les opérations sur de nombreux fichiers, utilisez les fonctions d'édition ou de suppression multiples

### JinaNavigator

- **Performances** : JinaNavigator peut être limité par les performances de l'API Jina et la taille des pages web.
- **Optimisations** :
  - Utilisez les paramètres `start_line` et `end_line` pour extraire uniquement les parties pertinentes
  - Évitez de convertir des pages web très volumineuses
  - Limitez le nombre d'URLs traitées en parallèle à moins de 50

### Jupyter

- **Performances** : Les performances de Jupyter MCP dépendent du serveur Jupyter sous-jacent et de la complexité des notebooks.
- **Optimisations** :
  - Limitez la taille des notebooks à moins de 50 Mo
  - Exécutez uniquement les cellules nécessaires plutôt que des notebooks entiers
  - Arrêtez les kernels inutilisés pour libérer des ressources
<!-- END_SECTION: performance -->

<!-- START_SECTION: limitations -->
## Limites et Contraintes

### QuickFiles

- Ne peut pas accéder aux fichiers en dehors des répertoires autorisés
- Limité par les permissions du système de fichiers
- La lecture de fichiers très volumineux peut être limitée par la mémoire disponible

### JinaNavigator

- Dépend de l'API Jina qui peut avoir des limites de taux de requêtes
- Ne peut pas accéder au contenu nécessitant une authentification
- Certains types de contenu dynamique (JavaScript, Canvas, WebGL) ne peuvent pas être correctement convertis

### Jupyter

- Nécessite un serveur Jupyter en cours d'exécution
- Support limité pour les serveurs Jupyter nécessitant une authentification complexe
- Certains types de sorties complexes (widgets interactifs, visualisations 3D) peuvent ne pas être correctement sérialisés
<!-- END_SECTION: limitations -->

<!-- START_SECTION: advanced_usage -->
## Cas d'Utilisation Avancés

### QuickFiles

- **Analyse de code source** : Utilisation de QuickFiles pour analyser rapidement de grandes bases de code
- **Gestion de configuration** : Modification en masse de fichiers de configuration
- **Extraction de données** : Lecture sélective de portions spécifiques de fichiers volumineux

### JinaNavigator

- **Recherche d'informations** : Extraction et analyse de contenu web en format Markdown
- **Veille technologique** : Conversion de multiples pages web pour analyse comparative
- **Documentation automatique** : Génération de documentation à partir de pages web

### Jupyter

- **Analyse de données interactive** : Création et exécution de notebooks pour l'analyse de données
- **Prototypage rapide** : Développement et test de code Python dans un environnement interactif
- **Génération de rapports** : Création de notebooks combinant code, visualisations et texte explicatif
<!-- END_SECTION: advanced_usage -->

<!-- START_SECTION: navigation -->
## Navigation

- [Index principal](../INDEX.md)
- [Accueil](../README.md)
- [Guide de recherche](../SEARCH.md)
- [Dépannage général](../TROUBLESHOOTING.md)
<!-- END_SECTION: navigation -->