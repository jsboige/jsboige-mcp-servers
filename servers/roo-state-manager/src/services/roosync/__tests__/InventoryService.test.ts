import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { InventoryService } from '../InventoryService';

vi.mock('fs/promises');
vi.mock('os');

describe('InventoryService', () => {
  let service: InventoryService;
  const mockHomeDir = '/mock/home';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomeDir);
    vi.mocked(os.hostname).mockReturnValue('test-machine');
    vi.mocked(os.type).mockReturnValue('Windows_NT');
    vi.mocked(os.release).mockReturnValue('10.0.19045');
    vi.mocked(os.userInfo).mockReturnValue({ username: 'test-user' } as any);
    
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

   it('should collect scripts correctly', async () => {
    const mockScripts = ['script1.ps1', 'script2.ps1'];
    const mockDirs = [
        { name: 'category1', isDirectory: () => true, isFile: () => false },
        { name: 'root-script.ps1', isDirectory: () => false, isFile: () => true }
    ] as any;
    
    const mockCategoryFiles = [
        { name: 'cat-script.ps1', isDirectory: () => false, isFile: () => true }
    ] as any;

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    
    // Mock readdir for scripts path
    vi.mocked(fs.readdir).mockImplementation(async (pathLike: any) => {
        if (pathLike.includes('scripts') && !pathLike.includes('category1')) {
            return mockDirs;
        }
        if (pathLike.includes('category1')) {
            return mockCategoryFiles;
        }
        return [];
    });

    const inventory = await service.getMachineInventory();

    expect(inventory.inventory.scripts.categories['root']).toHaveLength(1);
    expect(inventory.inventory.scripts.categories['root'][0].name).toBe('root-script.ps1');
    
    expect(inventory.inventory.scripts.categories['category1']).toHaveLength(1);
    expect(inventory.inventory.scripts.categories['category1'][0].name).toBe('cat-script.ps1');
  });
});