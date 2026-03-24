/**
 * Tests unitaires pour validate-architecture.ts
 * Vérifie la validation de l'architecture des parentIds
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock functions
const mockFindPotentialParent = vi.fn();
const mockFindAllPotentialParents = vi.fn();
const mockAddInstruction = vi.fn();
const mockGetStats = vi.fn();
const mockDetectStorageLocations = vi.fn();
const mockBuildHierarchicalSkeletons = vi.fn();

// Setup mocks before any imports
vi.mock('../utils/task-instruction-index.js', () => ({
  globalTaskInstructionIndex: {
    findPotentialParent: mockFindPotentialParent,
    findAllPotentialParents: mockFindAllPotentialParents,
    addInstruction: mockAddInstruction,
    getStats: mockGetStats
  }
}));

vi.mock('../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: mockDetectStorageLocations,
    buildHierarchicalSkeletons: mockBuildHierarchicalSkeletons
  }
}));

describe('validate-architecture', () => {
  beforeEach(() => {
    // Force fresh module load to avoid caching
    vi.resetModules();

    // Reset tous les mocks avant chaque test
    vi.clearAllMocks();

    // Setup default return values
    mockFindPotentialParent.mockReturnValue(undefined);
    mockFindAllPotentialParents.mockReturnValue([]);
    mockGetStats.mockReturnValue({ totalInstructions: 1, totalNodes: 1 });
    mockDetectStorageLocations.mockResolvedValue([{ path: '/mock/path', type: 'mock' }]);
    mockBuildHierarchicalSkeletons.mockResolvedValue([]);
  });

  it('should call findPotentialParent with correct arguments', async () => {
    // Import et exécution du module
    await import('../validate-architecture.js');

    // Attendre un tick pour laisser l'async se terminer
    await new Promise(resolve => setTimeout(resolve, 100));

    // Vérifier que findPotentialParent a été appelée
    expect(mockFindPotentialParent).toHaveBeenCalled();
    expect(mockFindPotentialParent).toHaveBeenCalledWith(
      expect.stringContaining('test task'),
      'test-id'
    );
  });

  it('should call findAllPotentialParents during validation', async () => {
    // Import du module
    await import('../validate-architecture.js');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Vérifier que findAllPotentialParents a été appelée
    expect(mockFindAllPotentialParents).toHaveBeenCalled();
    expect(mockFindAllPotentialParents).toHaveBeenCalledWith(
      expect.stringContaining('test task')
    );
  });

  it('should call radix tree methods to store instructions', async () => {
    // Import du module
    await import('../validate-architecture.js');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Vérifier que les méthodes du radix tree ont été appelées
    expect(mockAddInstruction).toHaveBeenCalled();
    expect(mockAddInstruction).toHaveBeenCalledWith(
      'parent-task-id',
      'test instruction'
    );
    expect(mockGetStats).toHaveBeenCalled();
  });
});
