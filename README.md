# Serveurs MCP (Model Context Protocol)

Ce dépôt contient une collection de serveurs MCP (Model Context Protocol) prêts à l'emploi pour étendre les capacités des grands modèles de langage (LLM).

## Qu'est-ce que MCP?

Le Model Context Protocol (MCP) est un protocole qui permet aux modèles de langage d'interagir avec des outils et des ressources externes. Les serveurs MCP fournissent des fonctionnalités supplémentaires aux LLM, comme l'accès à des API externes, des outils de développement, et des utilitaires système.

## Structure du dépôt

```
jsboige-mcp-servers/
├── servers/                       # Tous les serveurs MCP
│   ├── api-connectors/            # Serveurs pour les APIs externes
│   ├── dev-tools/                 # Outils de développement
│   └── system-utils/              # Utilitaires système
├── config/                        # Exemples de configuration
├── docs/                          # Documentation
└── scripts/                       # Scripts utilitaires
```

## Installation

Pour installer tous les serveurs MCP:

```bash
npm run install-all
```

Pour configurer les serveurs:

```bash
npm run setup-config
```

## Documentation

- [Guide de démarrage](docs/getting-started.md)
- [Architecture MCP](docs/architecture.md)
- [Guide de dépannage](docs/troubleshooting.md)

## Contribution

Veuillez consulter [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives de contribution.

## Licence

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.