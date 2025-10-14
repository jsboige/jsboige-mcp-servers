# Organisation des Tests - roo-state-manager

Ce répertoire contient tous les tests du projet, organisés par type.

## Structure

\\\
tests/
├── unit/              # Tests unitaires rapides et isolés
│   ├── services/      # Tests des services
│   ├── utils/         # Tests des utilitaires
│   ├── tools/         # Tests des outils MCP
│   └── gateway/       # Tests du gateway API
├── integration/       # Tests d'intégration multi-modules
│   ├── hierarchy/     # Tests de la hiérarchie complète
│   ├── storage/       # Tests de détection et storage
│   └── api/           # Tests de l'API gateway
├── e2e/              # Tests end-to-end complets
│   └── scenarios/    # Scénarios utilisateur complets
├── fixtures/         # Données de test (conservées)
├── config/           # Configuration Jest
├── helpers/          # Utilitaires de tests
└── archive/          # Tests obsolètes/désactivés
\\\

## Exécution

\\\ash
npm test              # Tous les tests
npm run test:unit     # Tests unitaires
npm run test:integration  # Tests d'intégration
npm run test:e2e      # Tests end-to-end
\\\

Date de réorganisation : 2025-10-02
