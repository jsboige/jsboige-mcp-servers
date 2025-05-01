# Guide de contribution

Merci de votre intérêt pour contribuer aux serveurs MCP! Ce document vous guidera à travers le processus de contribution à ce projet.

## Table des matières

- [Code de conduite](#code-de-conduite)
- [Comment puis-je contribuer?](#comment-puis-je-contribuer)
  - [Signaler des bugs](#signaler-des-bugs)
  - [Suggérer des améliorations](#suggérer-des-améliorations)
  - [Proposer un nouveau serveur MCP](#proposer-un-nouveau-serveur-mcp)
  - [Contribuer du code](#contribuer-du-code)
- [Standards de développement](#standards-de-développement)
  - [Style de code](#style-de-code)
  - [Tests](#tests)
  - [Documentation](#documentation)
  - [Sécurité](#sécurité)
- [Processus de développement](#processus-de-développement)
  - [Branches](#branches)
  - [Commits](#commits)
  - [Pull Requests](#pull-requests)
  - [Revue de code](#revue-de-code)
- [Structure d'un serveur MCP](#structure-dun-serveur-mcp)
  - [Exemple de serveur](#exemple-de-serveur)
  - [Bonnes pratiques](#bonnes-pratiques)

## Code de conduite

Ce projet et tous ses participants sont régis par notre code de conduite. En participant, vous êtes censé respecter ce code. Veuillez signaler tout comportement inacceptable à [maintainer@example.com](mailto:maintainer@example.com).

## Comment puis-je contribuer?

### Signaler des bugs

Les bugs sont suivis comme des [issues GitHub](https://github.com/jsboige/jsboige-mcp-servers/issues). Créez une issue et fournissez les informations suivantes:

- Utilisez un titre clair et descriptif
- Décrivez les étapes exactes pour reproduire le problème
- Décrivez le comportement observé et le comportement attendu
- Incluez des captures d'écran si possible
- Précisez votre environnement (OS, version de Node.js, etc.)
- Incluez les logs pertinents

### Suggérer des améliorations

Les suggestions d'amélioration sont également suivies comme des issues GitHub. Créez une issue avec le tag "enhancement" et fournissez les informations suivantes:

- Utilisez un titre clair et descriptif
- Décrivez en détail la fonctionnalité suggérée
- Expliquez pourquoi cette fonctionnalité serait utile
- Proposez une implémentation possible si vous en avez une
- Précisez le type de serveur MCP concerné (API Connector, Dev Tool, System Util)

### Proposer un nouveau serveur MCP

Si vous souhaitez proposer un nouveau serveur MCP, suivez ces étapes:

1. **Vérifiez d'abord** si un serveur similaire existe déjà ou est en cours de développement
2. **Créez une issue** décrivant le serveur que vous souhaitez ajouter:
   - Nom et description du serveur
   - Catégorie (API Connector, Dev Tool, System Util)
   - Outils et ressources que le serveur fournira
   - APIs externes ou dépendances requises
   - Cas d'utilisation et exemples
3. **Attendez les retours** de la communauté et des mainteneurs
4. **Développez un prototype** une fois que votre proposition est approuvée

### Contribuer du code

1. **Fork** le dépôt
2. **Créez une branche** pour votre fonctionnalité (`git checkout -b feature/amazing-feature`)
3. **Committez vos changements** (`git commit -m 'Add some amazing feature'`)
4. **Poussez vers la branche** (`git push origin feature/amazing-feature`)
5. **Ouvrez une Pull Request**

## Standards de développement

### Style de code

- Utilisez ESLint pour vérifier votre code
- Suivez les conventions de style JavaScript standard
- Utilisez des noms de variables et de fonctions descriptifs
- Commentez votre code lorsque nécessaire
- Utilisez des fonctions asynchrones avec async/await plutôt que des callbacks

```javascript
// Bon exemple
async function getWeatherData(city) {
  try {
    const response = await fetch(`https://api.weather.com/current?city=${city}`);
    return await response.json();
  } catch (error) {
    console.error('Erreur lors de la récupération des données météo:', error);
    throw error;
  }
}

// Mauvais exemple
function getWeatherData(city, callback) {
  fetch(`https://api.weather.com/current?city=${city}`)
    .then(response => response.json())
    .then(data => callback(null, data))
    .catch(error => callback(error));
}
```

### Tests

- Écrivez des tests unitaires pour toutes les fonctionnalités
- Utilisez Jest ou Mocha pour les tests
- Visez une couverture de code d'au moins 80%
- Incluez des tests d'intégration pour les fonctionnalités critiques
- Assurez-vous que tous les tests passent avant de soumettre une PR

```javascript
// Exemple de test avec Jest
describe('Weather API', () => {
  test('should return weather data for a valid city', async () => {
    const data = await getWeatherData('Paris');
    expect(data).toHaveProperty('temperature');
    expect(data).toHaveProperty('conditions');
  });

  test('should throw an error for an invalid city', async () => {
    await expect(getWeatherData('NonExistentCity')).rejects.toThrow();
  });
});
```

### Documentation

- Documentez toutes les fonctions, classes et méthodes publiques
- Utilisez JSDoc pour la documentation du code
- Incluez des exemples d'utilisation
- Mettez à jour le README.md du serveur avec des informations détaillées
- Documentez les schémas d'entrée et de sortie des outils

```javascript
/**
 * Récupère les données météorologiques actuelles pour une ville.
 * 
 * @param {string} city - Le nom de la ville
 * @param {string} [country] - Le code pays ISO à 2 lettres (optionnel)
 * @returns {Promise<Object>} Les données météorologiques
 * @throws {Error} Si la ville est invalide ou si l'API est indisponible
 * 
 * @example
 * // Récupérer la météo pour Paris
 * const weather = await getWeatherData('Paris', 'FR');
 * console.log(`Température: ${weather.temperature}°C`);
 */
async function getWeatherData(city, country) {
  // Implémentation
}
```

### Sécurité

- Validez toutes les entrées utilisateur
- Utilisez des bibliothèques à jour et sécurisées
- Ne stockez jamais de secrets (clés API, mots de passe) dans le code
- Utilisez des variables d'environnement ou des fichiers de configuration sécurisés
- Implémentez une limitation de débit pour éviter les abus
- Documentez les risques de sécurité potentiels

## Processus de développement

### Branches

- `main`: branche principale, toujours stable
- `develop`: branche de développement
- `feature/*`: branches de fonctionnalités
- `bugfix/*`: branches de correction de bugs
- `release/*`: branches de préparation de release

### Commits

- Utilisez des messages de commit clairs et descriptifs
- Suivez le format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- Exemple: `feat(weather-api): add support for hourly forecast`

### Pull Requests

- Créez une PR depuis votre branche de fonctionnalité vers la branche `develop`
- Utilisez le template de PR fourni
- Liez la PR à l'issue correspondante
- Assurez-vous que tous les tests passent
- Demandez une revue de code

### Revue de code

- Toutes les PR doivent être revues par au moins un mainteneur
- Les commentaires de revue doivent être constructifs et respectueux
- Les problèmes identifiés doivent être corrigés avant la fusion
- Une fois approuvée, la PR peut être fusionnée

## Structure d'un serveur MCP

Chaque serveur MCP doit suivre cette structure:

```
server-name/
├── README.md           # Documentation du serveur
├── package.json        # Dépendances et scripts
├── server.js           # Point d'entrée du serveur
├── config.example.json # Configuration d'exemple
├── src/                # Code source
│   ├── tools/          # Implémentation des outils
│   ├── resources/      # Implémentation des ressources
│   └── utils/          # Utilitaires
└── tests/              # Tests
```

### Exemple de serveur

Voici un exemple de structure pour un serveur météo:

```
weather-api/
├── README.md
├── package.json
├── server.js
├── config.example.json
├── src/
│   ├── tools/
│   │   ├── getCurrentWeather.js
│   │   ├── getForecast.js
│   │   └── index.js
│   ├── resources/
│   │   ├── weatherResource.js
│   │   └── index.js
│   └── utils/
│       ├── apiClient.js
│       └── validators.js
└── tests/
    ├── tools/
    │   ├── getCurrentWeather.test.js
    │   └── getForecast.test.js
    └── resources/
        └── weatherResource.test.js
```

### Bonnes pratiques

#### Pour les API Connectors

- Utilisez la gestion de taux limite (rate limiting) pour éviter de dépasser les quotas d'API
- Mettez en cache les résultats lorsque c'est possible pour améliorer les performances
- Gérez correctement les erreurs et fournissez des messages d'erreur utiles
- Documentez clairement les exigences en termes de clés API et d'authentification
- Respectez les conditions d'utilisation des API externes

#### Pour les Dev Tools

- Assurez-vous que les outils fonctionnent avec différents langages de programmation lorsque c'est pertinent
- Utilisez des parseurs et des analyseurs robustes pour manipuler le code
- Fournissez des résultats structurés et faciles à comprendre pour les LLM
- Documentez clairement les limites et les cas d'utilisation de chaque outil
- Respectez les bonnes pratiques de sécurité lors de l'exécution de code

#### Pour les System Utils

- Implémentez des mesures de sécurité strictes pour éviter les abus
- Limitez l'accès aux ressources sensibles du système
- Validez soigneusement toutes les entrées utilisateur
- Documentez clairement les permissions requises pour chaque outil
- Assurez-vous que les outils fonctionnent sur différents systèmes d'exploitation (Windows, Linux, macOS)
- Gérez correctement les erreurs et fournissez des messages d'erreur utiles

---

Merci de contribuer à ce projet! Votre aide est précieuse pour améliorer les serveurs MCP et étendre les capacités des LLM.