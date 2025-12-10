/**
 * Configuration globale pour les tests Jest
 * 
 * Ce fichier est exécuté avant chaque suite de tests
 * pour configurer l'environnement de test global.
 */

// Configuration des mocks globaux
global.console = {
  ...console,
  // Silence les logs dans les tests sauf si explicitement demandé
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: console.warn,
  error: console.error,
};

// Mock pour fetch global si nécessaire
global.fetch = jest.fn();

// Variables globales pour les tests
global.testTimeout = 10000;

// Configuration des timeouts pour les tests asynchrones
jest.setTimeout(30000);

// Nettoyage après chaque test
afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

// Configuration pour les erreurs non gérées
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});