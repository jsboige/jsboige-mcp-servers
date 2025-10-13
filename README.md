# jsboige-mcp-servers

Collection de serveurs MCP (Model Context Protocol) pour étendre les capacités des modèles de langage (LLM).

[![CI](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml/badge.svg)](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Test Coverage](https://img.shields.io/codecov/c/github/jsboige/jsboige-mcp-servers)](https://codecov.io/gh/jsboige/jsboige-mcp-servers)
[![Documentation](https://img.shields.io/badge/docs-complete-brightgreen.svg)](https://github.com/jsboige/jsboige-mcp-servers/tree/main/docs)

## Qu'est-ce que MCP?

Le Model Context Protocol (MCP) est un protocole qui permet aux modèles de langage (LLM) d'interagir avec des outils et des ressources externes. Il définit un format standard pour:

1. La découverte d'outils et de ressources
2. L'invocation d'outils
3. L'accès aux ressources
4. La gestion des erreurs et des résultats

Ce protocole permet d'étendre considérablement les capacités des LLM en leur donnant accès à des fonctionnalités externes comme:
- Recherche d'informations en temps réel
- Accès à des API externes
- Manipulation de fichiers
- Analyse de code
- Et bien plus encore

## Contenu du dépôt

Ce dépôt contient une collection de serveurs MCP placés directement dans le répertoire `servers/`:

### Serveurs disponibles

#### QuickFiles Server (Fonctionnel)

Un serveur MCP qui fournit des méthodes pour lire rapidement le contenu de répertoires et fichiers multiples:
- Lecture de plusieurs fichiers en une seule requête
- Extraction de portions spécifiques de fichiers
- Listage détaillé du contenu des répertoires
- Numérotation de lignes et limitation du nombre de lignes lues
- Suppression de fichiers multiples en une seule opération
- Édition de fichiers multiples avec application de diffs
- Tests unitaires complets avec Jest et mock-fs
- Tests de performance et de gestion d'erreurs
- Documentation complète et standardisée
- Script de démonstration pour tester facilement les fonctionnalités

[En savoir plus sur QuickFiles Server](servers/quickfiles-server/README.md)

#### Jupyter MCP Server (Fonctionnel avec limitations)

Un serveur MCP qui permet d'interagir avec des notebooks Jupyter:
- Gestion des notebooks (lecture, création, modification)
- Gestion des kernels (démarrage, arrêt, interruption)
- Exécution de code (cellules individuelles ou notebooks complets)
- Récupération des sorties textuelles et riches (images, HTML, etc.)
- Tests unitaires complets pour toutes les fonctionnalités
- Tests de performance et de gestion d'erreurs
- Documentation détaillée avec exemples d'utilisation

> **Note**: Le serveur MCP Jupyter peut présenter des problèmes d'authentification dans certaines configurations. Consultez le [Guide de dépannage du MCP Jupyter](./docs/jupyter-mcp-troubleshooting.md) pour les solutions recommandées.

[En savoir plus sur Jupyter MCP Server](servers/jupyter-mcp-server/README.md)

#### JinaNavigator Server (Fonctionnel)

Un serveur MCP qui utilise l'API Jina pour convertir des pages web en Markdown:
- Conversion de pages web en format Markdown
- Extraction de portions spécifiques du contenu
- Accès via URI au format jina://{url}
- Filtrage du contenu par numéros de lignes
- Tests unitaires complets
- Tests de performance et de gestion d'erreurs
- Documentation standardisée

[En savoir plus sur JinaNavigator Server](servers/jinavigator-server/README.md)

## Installation

### Prérequis

- Node.js 14.x ou supérieur
- npm 6.x ou supérieur
- Git
- Python avec Jupyter installé (pour le serveur Jupyter MCP)

### Installation rapide

```bash
# Cloner le dépôt
git clone https://github.com/jsboige/jsboige-mcp-servers.git
cd jsboige-mcp-servers

# Installer les dépendances principales
npm install

# Installer tous les serveurs MCP
npm run install-all

# Configurer les serveurs
npm run setup-config
```

### Installation spécifique par serveur

#### QuickFiles Server
```bash
cd servers/quickfiles-server
npm install
npm run build
```

#### Jupyter MCP Server
```bash
cd servers/jupyter-mcp-server
npm install
npm run build

# Démarrez un serveur Jupyter avec les options recommandées
jupyter notebook --NotebookApp.token=test_token --NotebookApp.allow_origin='*' --no-browser

# Configurez le fichier config.json avec le même token
echo '{
  "jupyterServer": {
    "baseUrl": "http://localhost:8888",
    "token": "test_token"
  }
}' > config.json
```

#### JinaNavigator Server
```bash
cd servers/jinavigator-server
npm install
npm run build
```

Pour des instructions d'installation plus détaillées, consultez le [Guide de démarrage](./docs/getting-started.md).

## Utilisation

### Démarrer un serveur MCP

```bash
# Démarrer le serveur QuickFiles
cd servers/quickfiles-server
npm start

# Démarrer le serveur Jupyter MCP
cd servers/jupyter-mcp-server
npm start
# Note: Assurez-vous que le serveur Jupyter est en cours d'exécution avec le bon token
# jupyter notebook --NotebookApp.token=test_token --NotebookApp.allow_origin='*' --no-browser

# Démarrer le serveur JinaNavigator
cd servers/jinavigator-server
npm start
```

### Connecter un serveur MCP à un LLM

Les serveurs MCP peuvent être connectés à différents LLM qui supportent le protocole MCP. Dans votre interface LLM, configurez la connexion au serveur MCP en utilisant l'URL du serveur (généralement `http://localhost:3000` ou similaire).

### Exemples d'utilisation

#### QuickFiles Server
```
Utilisateur: Peux-tu lire les fichiers de configuration dans le dossier config?

LLM: Je vais lire les fichiers de configuration pour vous.
[Utilisation de l'outil quickfiles-server.read_multiple_files avec les paramètres {"paths": ["config/config1.json", "config/config2.json"]}]
Voici le contenu des fichiers de configuration...
```

```
Utilisateur: Peux-tu modifier tous les fichiers JavaScript pour ajouter un commentaire de copyright?

LLM: Je vais modifier les fichiers JavaScript.
[Utilisation de l'outil quickfiles-server.edit_multiple_files avec les paramètres {
  "files": [
    {
      "path": "src/app.js",
      "diffs": [
        {
          "search": "// Début du fichier",
          "replace": "// Début du fichier\n// Copyright 2025 - Tous droits réservés"
        }
      ]
    },
    {
      "path": "src/utils.js",
      "diffs": [
        {
          "search": "// Utilitaires",
          "replace": "// Utilitaires\n// Copyright 2025 - Tous droits réservés"
        }
      ]
    }
  ]
}]
J'ai ajouté le commentaire de copyright à tous les fichiers JavaScript.
```

#### Jupyter MCP Server
```
Utilisateur: Crée un notebook Python qui analyse des données.

LLM: Je vais créer un notebook pour vous.
[Utilisation de l'outil jupyter-mcp-server.create_notebook avec les paramètres {"path": "analyse_donnees.ipynb", "kernel": "python3"}]
J'ai créé un nouveau notebook. Maintenant, je vais ajouter du code pour analyser des données...

[Utilisation de l'outil jupyter-mcp-server.add_cell avec les paramètres {"path": "analyse_donnees.ipynb", "cell_type": "code", "source": "import pandas as pd\nimport matplotlib.pyplot as plt\nimport numpy as np\n\n# Créer des données d'exemple\ndata = {'x': np.random.rand(100), 'y': np.random.rand(100)}\ndf = pd.DataFrame(data)\ndf.plot.scatter(x='x', y='y')\nplt.show()"}]

Le notebook a été créé avec succès avec une cellule de code pour l'analyse de données.
```

> **Bonnes pratiques**: Pour éviter les erreurs 403 Forbidden, assurez-vous que:
> 1. Le token dans config.json correspond exactement au token du serveur Jupyter
> 2. Le serveur Jupyter est démarré avec `--NotebookApp.allow_origin='*'`
> 3. Consultez le [Guide de dépannage](./docs/jupyter-mcp-troubleshooting.md) pour plus de détails

#### JinaNavigator Server
```
Utilisateur: Peux-tu convertir la page d'accueil de GitHub en Markdown?

LLM: Je vais convertir cette page pour vous.
[Utilisation de l'outil jinavigator-server.convert_web_to_markdown avec les paramètres {"url": "https://github.com"}]
Voici le contenu de la page GitHub en format Markdown...
```

Pour plus d'exemples et d'informations sur l'utilisation, consultez le [Guide de démarrage](./docs/getting-started.md).

## Architecture

Les serveurs MCP suivent une architecture standardisée qui facilite leur développement et leur utilisation:

```
servers/
└── server-name/
    ├── README.md           # Documentation standardisée du serveur
    ├── package.json        # Dépendances et scripts standardisés
    ├── jest.config.js      # Configuration Jest standardisée
    ├── tsconfig.json       # Configuration TypeScript
    ├── src/                # Code source
    │   ├── index.ts        # Point d'entrée du serveur
    │   ├── tools/          # Implémentation des outils
    │   ├── resources/      # Implémentation des ressources
    │   └── utils/          # Utilitaires
    └── __tests__/          # Tests unitaires standardisés
        ├── *.test.js       # Tests fonctionnels
        ├── error-handling.test.js # Tests de gestion d'erreurs
        └── performance.test.js    # Tests de performance
```

Pour plus d'informations sur l'architecture, consultez la [Documentation sur l'architecture MCP](./docs/architecture.md).

## Intégration Continue

Ce projet utilise GitHub Actions pour l'intégration continue, avec les vérifications suivantes:

- **Tests unitaires**: Exécution automatique de tous les tests pour chaque serveur
- **Couverture de code**: Vérification du taux de couverture des tests
- **Qualité de la documentation**: Vérification de la présence et de la structure des fichiers README.md
- **Standardisation**: Vérification de la conformité aux standards du projet

Le workflow d'intégration continue est configuré dans le fichier `.github/workflows/ci.yml`.

## Configuration

Chaque serveur MCP possède son propre fichier de configuration. Vous pouvez utiliser le script `setup-config` pour configurer tous les serveurs:

```bash
npm run setup-config
```

Vous pouvez également modifier manuellement les fichiers de configuration dans le répertoire `config/`.

## Contribution

Nous accueillons favorablement les contributions à ce projet! Que vous souhaitiez ajouter un nouveau serveur MCP, améliorer un serveur existant, ou corriger des bugs, votre aide est la bienvenue.

Pour contribuer:

1. Consultez le [Guide de contribution](CONTRIBUTING.md) pour les détails sur notre processus de contribution
2. Consultez les [Issues ouvertes](https://github.com/jsboige/jsboige-mcp-servers/issues) pour voir ce qui est déjà en cours
3. Proposez vos propres idées en ouvrant une nouvelle issue

## Dépannage

Si vous rencontrez des problèmes lors de l'installation ou de l'utilisation des serveurs MCP, consultez:
- [Guide de dépannage général](./docs/troubleshooting.md)
- [Guide de dépannage du MCP Jupyter](./docs/jupyter-mcp-troubleshooting.md)

## Licence

Ce projet est sous licence MIT - voir le fichier [LICENSE](LICENSE) pour plus de détails.

## Ressources

- [Spécification MCP officielle](https://github.com/microsoft/mcp)
- [Guide de démarrage](./docs/getting-started.md)
- [Documentation sur l'architecture MCP](./docs/architecture.md)
- [Guide de dépannage](./docs/troubleshooting.md)
- [Guide de contribution](CONTRIBUTING.md)