# jsboige-mcp-servers

Collection de serveurs MCP (Model Context Protocol) pour étendre les capacités des modèles de langage (LLM).

[![CI](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml/badge.svg)](https://github.com/jsboige/jsboige-mcp-servers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

#### QuickFiles Server

Un serveur MCP qui fournit des méthodes pour lire rapidement le contenu de répertoires et fichiers multiples:
- Lecture de plusieurs fichiers en une seule requête
- Extraction de portions spécifiques de fichiers
- Listage détaillé du contenu des répertoires
- Et plus encore

[En savoir plus sur QuickFiles Server](servers/quickfiles-server/README.md)

#### Jupyter MCP Server

Un serveur MCP qui permet d'interagir avec des notebooks Jupyter:
- Gestion des notebooks (lecture, création, modification)
- Gestion des kernels (démarrage, arrêt, interruption)
- Exécution de code (cellules individuelles ou notebooks complets)
- Et plus encore

[En savoir plus sur Jupyter MCP Server](servers/jupyter-mcp-server/README.md)

## Installation

### Prérequis

- Node.js 14.x ou supérieur
- npm 6.x ou supérieur
- Git

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

Pour des instructions d'installation plus détaillées, consultez le [Guide de démarrage](docs/getting-started.md).

## Utilisation

### Démarrer un serveur MCP

```bash
# Exemple pour démarrer un serveur météo
cd servers/api-connectors/weather-api
node server.js
```

### Connecter un serveur MCP à un LLM

Les serveurs MCP peuvent être connectés à différents LLM qui supportent le protocole MCP. Dans votre interface LLM, configurez la connexion au serveur MCP en utilisant l'URL du serveur (généralement `http://localhost:3000` ou similaire).

### Exemple d'interaction

```
Utilisateur: Quelle est la météo à Paris aujourd'hui?

LLM: Je vais vérifier la météo à Paris pour vous.
[Utilisation de l'outil weather-api.get_weather avec les paramètres {"city": "Paris", "country": "FR"}]
D'après les données météo actuelles, il fait 22°C à Paris avec un ciel partiellement nuageux. L'humidité est de 65% et le vent souffle à 10 km/h.
```

Pour plus d'exemples et d'informations sur l'utilisation, consultez le [Guide de démarrage](docs/getting-started.md).

## Architecture

Les serveurs MCP suivent une architecture standardisée qui facilite leur développement et leur utilisation:

```
servers/
└── server-name/
    ├── README.md           # Documentation du serveur
    ├── package.json        # Dépendances et scripts
    ├── server.js ou index.ts # Point d'entrée du serveur
    ├── config.example.json # Configuration d'exemple (si nécessaire)
    ├── config.json         # Configuration réelle (ignorée par git)
    ├── src/                # Code source
    │   ├── tools/          # Implémentation des outils
    │   ├── resources/      # Implémentation des ressources
    │   └── utils/          # Utilitaires
    └── tests/              # Tests
```

Pour plus d'informations sur l'architecture, consultez la [Documentation sur l'architecture MCP](docs/architecture.md).

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

Si vous rencontrez des problèmes lors de l'installation ou de l'utilisation des serveurs MCP, consultez le [Guide de dépannage](docs/troubleshooting.md).

## Licence

Ce projet est sous licence MIT - voir le fichier [LICENSE](LICENSE) pour plus de détails.

## Ressources

- [Spécification MCP officielle](https://github.com/microsoft/mcp)
- [Guide de démarrage](docs/getting-started.md)
- [Documentation sur l'architecture MCP](docs/architecture.md)
- [Guide de dépannage](docs/troubleshooting.md)
- [Guide de contribution](CONTRIBUTING.md)