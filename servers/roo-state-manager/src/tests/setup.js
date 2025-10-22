/**
 * Setup pour les tests Jest
 *
 * Configuration globale pour les tests du BaselineService
 */

// Mock global pour fs
const mockFs = {
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
  },
  existsSync: jest.fn(),
  copyFileSync: jest.fn(),
};

// Mock du module fs
jest.mock('fs', () => mockFs, { virtual: true });

// Rendre mockFs disponible globalement pour les tests
global.mockFs = mockFs;