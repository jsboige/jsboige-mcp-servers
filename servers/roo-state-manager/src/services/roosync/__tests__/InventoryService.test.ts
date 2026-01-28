import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { InventoryService } from '../InventoryService';

vi.mock('fs/promises');
// Mock os module but preserve original functions and add our mocks
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home'),
    hostname: vi.fn(() => 'test-machine'),
    type: vi.fn(() => 'Windows_NT'),
    release: vi.fn(() => '10.0.19045'),
    userInfo: vi.fn(() => ({ username: 'test-user' })),
  };
});

describe('InventoryService', () => {
  let service: InventoryService;
  const mockHomeDir = '/mock/home';

  beforeEach(() => {
    vi.clearAllMocks();
    // Les mocks de os sont définis au niveau module avec importOriginal
    // Pas besoin de les redéfinir ici

    // We need to reset the singleton instance to ensure clean state
    // This is a bit tricky with private constructors and singletons in tests
    // For this test, we assume getInstance works correctly
    service = InventoryService.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should collect MCP servers correctly', async () => {
    const mockMcpSettings = {
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['index.js'],
          disabled: false,
          autoStart: true
        }
      }
    };

    vi.mocked(fs.access).mockResolvedValue(undefined); // File exists
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMcpSettings));
    
    // Mock other file checks to avoid errors
    vi.mocked(fs.readdir).mockResolvedValue([]);

    const inventory = await service.getMachineInventory();

    expect(inventory.inventory.mcpServers).toHaveLength(1);
    expect(inventory.inventory.mcpServers[0]).toEqual({
      name: 'test-server',
      enabled: true,
      autoStart: true,
      command: 'node',
      transportType: undefined,
      alwaysAllow: undefined,
      description: undefined
    });
  });

  it('should handle missing MCP settings file gracefully', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT')); // File does not exist for MCP settings
    
    // Allow other checks to pass or fail gracefully
    vi.mocked(fs.readdir).mockResolvedValue([]);

    const inventory = await service.getMachineInventory();

    expect(inventory.inventory.mcpServers).toHaveLength(1);
    expect(inventory.inventory.mcpServers[0].status).toBe('absent');
  });

  it('should collect system info correctly', async () => {
     // Mock file checks to avoid errors
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    vi.mocked(fs.readdir).mockResolvedValue([]);

    const inventory = await service.getMachineInventory();

    expect(inventory.inventory.systemInfo).toEqual({
      os: 'Windows_NT 10.0.19045',
      hostname: 'test-machine',
      username: 'test-user',
      powershellVersion: '7.x' // Assuming default mock behavior
    });
  });

   /**
    * SIMPLIFICATION "Écuries d'Augias" : Scripts non collectés
    * Les scripts PowerShell ne sont pas utiles pour la comparaison des configurations
    * et gonflaient l'inventaire de 70+ KB. Maintenant retourne un objet vide.
    */
   it('should return empty scripts (simplified inventory)', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('{}');

    const inventory = await service.getMachineInventory();

    // Simplification: scripts est maintenant un objet vide
    expect(inventory.inventory.scripts.categories).toEqual({});
    expect(inventory.inventory.scripts.all).toEqual([]);
  });
});