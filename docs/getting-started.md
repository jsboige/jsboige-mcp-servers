# Guide de démarrage

Ce guide vous aidera à démarrer avec les serveurs MCP (Model Context Protocol).

## Prérequis

- Node.js 14.x ou supérieur
- npm 6.x ou supérieur
- Git

## Installation

1. Clonez le dépôt:

```bash
git clone https://github.com/jsboige/jsboige-mcp-servers.git
cd jsboige-mcp-servers
```

2. Installez les dépendances principales:

```bash
npm install
```

3. Installez tous les serveurs MCP:

```bash
npm run install-all
```

## Configuration

1. Configurez les serveurs MCP:

```bash
npm run setup-config
```

Ce script vous guidera à travers la configuration de chaque serveur MCP disponible.

2. Vous pouvez également modifier manuellement les fichiers de configuration dans le répertoire `config/`.

## Utilisation avec un LLM

### Connexion à un LLM

Les serveurs MCP peuvent être connectés à différents LLM qui supportent le protocole MCP. Voici comment connecter un serveur MCP à un LLM:

1. Démarrez le serveur MCP que vous souhaitez utiliser:

```bash
cd servers/api-connectors/weather-api
node server.js
```

2. Dans votre interface LLM, configurez la connexion au serveur MCP en utilisant l'URL du serveur (généralement `http://localhost:3000` ou similaire).

3. Une fois connecté, le LLM pourra utiliser les outils et ressources fournis par le serveur MCP.

### Exemple d'utilisation

Voici un exemple d'interaction avec un LLM utilisant un serveur MCP pour la météo:

```
Utilisateur: Quelle est la météo à Paris aujourd'hui?

LLM: Je vais vérifier la météo à Paris pour vous.
[Utilisation de l'outil weather-api.get_weather avec les paramètres {"city": "Paris", "country": "FR"}]
D'après les données météo actuelles, il fait 22°C à Paris avec un ciel partiellement nuageux. L'humidité est de 65% et le vent souffle à 10 km/h.
```

## Dépannage

Si vous rencontrez des problèmes, consultez le [guide de dépannage](troubleshooting.md) ou ouvrez une issue sur GitHub.

## Ressources supplémentaires

- [Documentation sur l'architecture MCP](architecture.md)
- [Guide de contribution](../CONTRIBUTING.md)
- [Licence](../LICENSE)