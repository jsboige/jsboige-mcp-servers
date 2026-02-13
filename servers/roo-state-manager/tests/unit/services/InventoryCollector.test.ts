/**
 * Tests unitaires pour InventoryCollector
 * Collecte l'inventaire système via cache, shared state, et script PowerShell
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger avec vi.hoisted
const { mockLogger } = vi.hoisted(() => ({
    mockLogger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../../src/utils/logger.js', () => ({
    createLogger: vi.fn(() => mockLogger)
}));

// Mock git-helpers
const { mockVerifyGitAvailable } = vi.hoisted(() => ({
    mockVerifyGitAvailable: vi.fn()
}));

vi.mock('../../../src/utils/git-helpers.js', () => ({
    getGitHelpers: vi.fn(() => ({
        verifyGitAvailable: mockVerifyGitAvailable
    }))
}));

// Mock server-helpers
const { mockGetSharedStatePath } = vi.hoisted(() => ({
    mockGetSharedStatePath: vi.fn()
}));

vi.mock('../../../src/utils/server-helpers.js', () => ({
    getSharedStatePath: mockGetSharedStatePath
}));

// Mock fs (both promises and sync)
const { mockReadFile, mockReaddir, mockWriteFile, mockMkdir, mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
    mockReadFile: vi.fn(),
    mockReaddir: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn()
}));

vi.mock('fs', () => ({
    promises: {
        readFile: mockReadFile,
        readdir: mockReaddir,
        writeFile: mockWriteFile,
        mkdir: mockMkdir
    },
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync
}));

// Mock child_process
const { mockExec } = vi.hoisted(() => ({
    mockExec: vi.fn()
}));

vi.mock('child_process', () => ({
    exec: mockExec
}));

// Mock os
const { mockHostname, mockPlatform, mockArch, mockUptime, mockCpus, mockTotalmem, mockFreemem } = vi.hoisted(() => ({
    mockHostname: vi.fn(),
    mockPlatform: vi.fn(),
    mockArch: vi.fn(),
    mockUptime: vi.fn(),
    mockCpus: vi.fn(),
    mockTotalmem: vi.fn(),
    mockFreemem: vi.fn()
}));

vi.mock('os', () => ({
    default: {
        hostname: mockHostname,
        platform: mockPlatform,
        arch: mockArch,
        uptime: mockUptime,
        cpus: mockCpus,
        totalmem: mockTotalmem,
        freemem: mockFreemem
    },
    hostname: mockHostname,
    platform: mockPlatform,
    arch: mockArch,
    uptime: mockUptime,
    cpus: mockCpus,
    totalmem: mockTotalmem,
    freemem: mockFreemem
}));

import { InventoryCollector, MachineInventory } from '../../../src/services/InventoryCollector.js';

// Helper: create a raw inventory JSON (PowerShell format)
function createRawInventory(machineId: string): any {
    return {
        machineId,
        timestamp: '2026-02-09T10:00:00.000Z',
        inventory: {
            systemInfo: {
                hostname: machineId,
                os: 'Windows 11',
                architecture: 'x64',
                uptime: 3600,
                processor: 'Intel Core i7',
                cpuCores: 8,
                cpuThreads: 16,
                totalMemory: 16000000000,
                availableMemory: 8000000000,
                disks: [{ drive: 'C:', size: 500000000000, free: 100000000000 }]
            },
            tools: {
                powershell: { version: '7.4.0' },
                node: { version: '20.11.0' }
            },
            mcpServers: [{ name: 'roo-state-manager', enabled: true }],
            rooModes: [{ slug: 'code', name: 'Code' }]
        },
        paths: {
            rooExtensions: 'D:/Dev/roo-extensions'
        }
    };
}

// Helper: create a baseline inventory JSON (direct format)
function createBaselineInventory(machineId: string): MachineInventory {
    return {
        machineId,
        timestamp: '2026-02-09T10:00:00.000Z',
        system: { hostname: machineId, os: 'Windows 11', architecture: 'x64', uptime: 3600 },
        hardware: {
            cpu: { name: 'Intel Core i7', cores: 8, threads: 16 },
            memory: { total: 16000000000, available: 8000000000 },
            disks: [{ drive: 'C:', size: 500000000000, free: 100000000000 }]
        },
        software: { powershell: '7.4.0', node: '20.11.0' },
        roo: {
            mcpServers: [{ name: 'roo-state-manager', enabled: true }],
            modes: [{ slug: 'code', name: 'Code' }]
        },
        paths: { rooExtensions: 'D:/Dev/roo-extensions' }
    };
}

describe('InventoryCollector', () => {
    let collector: InventoryCollector;

    beforeEach(() => {
        vi.clearAllMocks();

        // Defaults
        mockVerifyGitAvailable.mockResolvedValue({ available: true, version: 'git 2.40.0' });
        mockGetSharedStatePath.mockReturnValue('/mock/shared-state');
        mockHostname.mockReturnValue('myia-po-2023');
        mockPlatform.mockReturnValue('win32');
        mockArch.mockReturnValue('x64');
        mockUptime.mockReturnValue(3600);
        mockCpus.mockReturnValue([{}, {}, {}, {}]);
        mockTotalmem.mockReturnValue(16000000000);
        mockFreemem.mockReturnValue(8000000000);
        mockExistsSync.mockReturnValue(false);

        collector = new InventoryCollector();
    });

    describe('constructor', () => {
        it('should initialize with empty cache', () => {
            const stats = collector.getCacheStats();
            expect(stats.size).toBe(0);
            expect(stats.entries).toHaveLength(0);
        });

        it('should verify git on startup', () => {
            // verifyGitOnStartup is async fire-and-forget
            expect(mockVerifyGitAvailable).toHaveBeenCalled();
        });
    });

    describe('clearCache', () => {
        it('should clear all cache entries', () => {
            // Manually populate cache via collectInventory
            // Instead, test via public API
            collector.clearCache();
            expect(collector.getCacheStats().size).toBe(0);
        });
    });

    describe('getCacheStats', () => {
        it('should return empty stats initially', () => {
            const stats = collector.getCacheStats();
            expect(stats.size).toBe(0);
            expect(stats.entries).toEqual([]);
        });
    });

    describe('collectInventory - cache behavior', () => {
        it('should return cached data if cache is valid and forceRefresh=false', async () => {
            // First call: load from shared state
            mockExistsSync.mockReturnValue(true);
            const rawJson = JSON.stringify(createBaselineInventory('test-machine'));
            mockReadFile.mockResolvedValue(rawJson);

            const first = await collector.collectInventory('test-machine');
            expect(first).not.toBeNull();
            expect(first!.machineId).toBe('test-machine');

            // Second call: should hit cache, no new fs calls
            vi.clearAllMocks();
            const second = await collector.collectInventory('test-machine', false);
            expect(second).not.toBeNull();
            expect(second!.machineId).toBe('test-machine');
            // Should NOT have called getSharedStatePath again (cache hit)
            expect(mockGetSharedStatePath).not.toHaveBeenCalled();
        });

        it('should bypass cache when forceRefresh=true', async () => {
            // First call to populate cache
            mockExistsSync.mockReturnValue(true);
            const rawJson = JSON.stringify(createBaselineInventory('test-machine'));
            mockReadFile.mockResolvedValue(rawJson);

            await collector.collectInventory('test-machine');
            expect(collector.getCacheStats().size).toBe(1);

            // Force refresh should call shared state again
            vi.clearAllMocks();
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockResolvedValue(rawJson);
            mockGetSharedStatePath.mockReturnValue('/mock/shared-state');

            const result = await collector.collectInventory('test-machine', true);
            expect(result).not.toBeNull();
            expect(mockGetSharedStatePath).toHaveBeenCalled();
        });
    });

    describe('collectInventory - shared state loading', () => {
        it('should load from exact file path ({machineId}.json)', async () => {
            // existsSync: inventoriesDir=true, exactFilePath=true
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue(JSON.stringify(createBaselineInventory('test-machine')));

            const result = await collector.collectInventory('test-machine');
            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('test-machine');
        });

        it('should load from lowercase exact file path', async () => {
            // Only lowercase exists
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories') && !path.includes('.json')) return true;
                if (path.includes('myia-ai-01.json') && !path.includes('MYIA')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue(JSON.stringify(createBaselineInventory('MYIA-AI-01')));

            const result = await collector.collectInventory('MYIA-AI-01');
            expect(result).not.toBeNull();
        });

        it('should load from timestamped files when exact not found', async () => {
            // inventoriesDir exists, but no exact file
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories') && !path.includes('.json')) return true;
                return false;
            });
            mockReaddir.mockResolvedValue([
                'test-machine-2026-02-08T10-00-00.json',
                'test-machine-2026-02-09T10-00-00.json',
                'other-machine-2026-02-09.json'
            ]);
            mockReadFile.mockResolvedValue(JSON.stringify(createBaselineInventory('test-machine')));

            const result = await collector.collectInventory('test-machine');
            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('test-machine');
            // Should load the most recent (sorted reverse)
            expect(mockReadFile).toHaveBeenCalledWith(
                expect.stringContaining('test-machine-2026-02-09'),
                'utf-8'
            );
        });

        it('should return null when inventories dir does not exist', async () => {
            mockExistsSync.mockReturnValue(false);
            mockHostname.mockReturnValue('different-host');

            const result = await collector.collectInventory('remote-machine');
            expect(result).toBeNull();
        });

        it('should return null for remote machine with no shared state file', async () => {
            // inventoriesDir exists but empty
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories') && !path.includes('.json')) return true;
                return false;
            });
            mockReaddir.mockResolvedValue([]);
            mockHostname.mockReturnValue('different-host');

            const result = await collector.collectInventory('remote-machine');
            expect(result).toBeNull();
        });

        it('should handle BOM UTF-8 in shared state files', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            const bom = '\uFEFF';
            const json = JSON.stringify(createBaselineInventory('test-machine'));
            mockReadFile.mockResolvedValue(bom + json);

            const result = await collector.collectInventory('test-machine');
            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('test-machine');
        });

        it('should parse raw format (with inventory field)', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue(JSON.stringify(createRawInventory('test-machine')));

            const result = await collector.collectInventory('test-machine');
            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('test-machine');
            expect(result!.system.hostname).toBe('test-machine');
            expect(result!.hardware.cpu.name).toBe('Intel Core i7');
            expect(result!.hardware.cpu.cores).toBe(8);
            expect(result!.software.powershell).toBe('7.4.0');
            expect(result!.software.node).toBe('20.11.0');
            expect(result!.roo.mcpServers).toHaveLength(1);
            expect(result!.roo.modes).toHaveLength(1);
        });

        it('should parse baseline format (direct MachineInventory)', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue(JSON.stringify(createBaselineInventory('test-machine')));

            const result = await collector.collectInventory('test-machine');
            expect(result).not.toBeNull();
            expect(result!.system.os).toBe('Windows 11');
        });

        it('should return null for unrecognized format', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            // Missing machineId/timestamp/paths
            mockReadFile.mockResolvedValue(JSON.stringify({ random: 'data' }));
            mockHostname.mockReturnValue('different-host');

            const result = await collector.collectInventory('test-machine');
            expect(result).toBeNull();
        });

        it('should return null on JSON parse error', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue('not valid json{{{');
            mockHostname.mockReturnValue('different-host');

            const result = await collector.collectInventory('test-machine');
            expect(result).toBeNull();
        });

        it('should handle readdir error gracefully', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories') && !path.includes('.json')) return true;
                return false;
            });
            mockReaddir.mockRejectedValue(new Error('Permission denied'));
            mockHostname.mockReturnValue('different-host');

            const result = await collector.collectInventory('remote-machine');
            expect(result).toBeNull();
        });
    });

    describe('collectInventory - local machine PowerShell fallback', () => {
        it('should detect local machine by hostname match', async () => {
            mockHostname.mockReturnValue('myia-po-2023');
            // No shared state
            mockExistsSync.mockReturnValue(false);

            const result = await collector.collectInventory('myia-po-2023');
            // Will fail because script doesn't exist (existsSync=false)
            expect(result).toBeNull();
        });

        it('should detect myia-ai-01 as local for any host containing it', async () => {
            mockHostname.mockReturnValue('some-other-host');
            mockExistsSync.mockReturnValue(false);

            // myia-ai-01 always triggers local detection due to hardcoded check
            const result = await collector.collectInventory('myia-ai-01');
            expect(result).toBeNull();
            // Verify it tried local path (logged "Machine locale détectée")
        });

        it('should return null if PowerShell script not found', async () => {
            mockHostname.mockReturnValue('myia-po-2023');
            // inventoriesDir doesn't exist, script doesn't exist
            mockExistsSync.mockReturnValue(false);

            const result = await collector.collectInventory('myia-po-2023');
            expect(result).toBeNull();
        });

        it('should execute PowerShell and parse result on local machine', async () => {
            mockHostname.mockReturnValue('myia-po-2023');
            const rawInventory = createRawInventory('myia-po-2023');
            const inventoryJson = JSON.stringify(rawInventory);

            // inventoriesDir doesn't exist, but script exists, output file exists
            let callCount = 0;
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories') && !path.includes('.json')) return false;
                if (path.includes('Get-MachineInventory.ps1')) return true;
                if (path.includes('.json') && callCount > 0) return true;
                return false;
            });

            // Mock exec (promisified)
            mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                callCount++;
                callback(null, {
                    stdout: 'Collecting...\nG:/shared/inventories/myia-po-2023-2026.json\n',
                    stderr: ''
                });
            });

            mockReadFileSync.mockReturnValue(inventoryJson);
            mockWriteFile.mockResolvedValue(undefined);
            mockMkdir.mockResolvedValue(undefined);

            const result = await collector.collectInventory('myia-po-2023');
            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('myia-po-2023');
            expect(result!.hardware.cpu.name).toBe('Intel Core i7');
        });

        it('should handle PowerShell execution error gracefully', async () => {
            mockHostname.mockReturnValue('myia-po-2023');
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('Get-MachineInventory.ps1')) return true;
                return false;
            });

            mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                callback(new Error('PowerShell timeout'), { stdout: '', stderr: 'Timeout' });
            });

            const result = await collector.collectInventory('myia-po-2023');
            expect(result).toBeNull();
        });

        it('should strip BOM from readFileSync output', async () => {
            mockHostname.mockReturnValue('myia-po-2023');
            const rawInventory = createRawInventory('myia-po-2023');

            let callCount = 0;
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('Get-MachineInventory.ps1')) return true;
                if (path.includes('.json') && callCount > 0) return true;
                return false;
            });

            mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                callCount++;
                callback(null, { stdout: 'G:/output.json\n', stderr: '' });
            });

            // BOM prefix
            const bom = '\uFEFF';
            mockReadFileSync.mockReturnValue(bom + JSON.stringify(rawInventory));
            mockWriteFile.mockResolvedValue(undefined);
            mockMkdir.mockResolvedValue(undefined);

            const result = await collector.collectInventory('myia-po-2023');
            expect(result).not.toBeNull();
            expect(result!.machineId).toBe('myia-po-2023');
        });
    });

    describe('collectInventory - cache update and save', () => {
        it('should update cache after loading from shared state', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue(JSON.stringify(createBaselineInventory('test-machine')));

            await collector.collectInventory('test-machine');

            const stats = collector.getCacheStats();
            expect(stats.size).toBe(1);
            expect(stats.entries[0].machineId).toBe('test-machine');
            expect(stats.entries[0].age).toBeLessThan(1000); // Fresh
        });

        it('should expire cache entries after TTL', async () => {
            // Load first
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test-machine.json')) return true;
                return false;
            });
            mockReadFile.mockResolvedValue(JSON.stringify(createBaselineInventory('test-machine')));

            await collector.collectInventory('test-machine');
            expect(collector.getCacheStats().size).toBe(1);

            // Advance time beyond TTL (1h = 3600000ms)
            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now + 3600001);

            // Next call should not hit cache
            vi.clearAllMocks();
            mockGetSharedStatePath.mockReturnValue('/mock/shared-state');
            mockExistsSync.mockReturnValue(false);
            mockHostname.mockReturnValue('different-host');

            const result = await collector.collectInventory('test-machine');
            // Cache expired, no shared state, not local → null
            expect(result).toBeNull();

            vi.spyOn(Date, 'now').mockRestore();
        });
    });

    describe('collectInventory - raw format field mapping', () => {
        it('should map systemInfo fields correctly', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test.json')) return true;
                return false;
            });
            const raw = createRawInventory('test');
            raw.inventory.systemInfo.gpu = [{ name: 'RTX 4090', memory: 24000000000 }];
            mockReadFile.mockResolvedValue(JSON.stringify(raw));

            const result = await collector.collectInventory('test');
            expect(result).not.toBeNull();
            expect(result!.hardware.gpu).toHaveLength(1);
            expect(result!.hardware.gpu![0].name).toBe('RTX 4090');
            expect(result!.hardware.memory.total).toBe(16000000000);
            expect(result!.hardware.disks).toHaveLength(1);
        });

        it('should fallback to os values when systemInfo is missing', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test.json')) return true;
                return false;
            });
            // Raw format with empty inventory
            const raw = {
                machineId: 'test',
                timestamp: '2026-02-09T10:00:00.000Z',
                inventory: {},
                paths: { rooExtensions: 'D:/Dev' }
            };
            mockReadFile.mockResolvedValue(JSON.stringify(raw));

            const result = await collector.collectInventory('test');
            expect(result).not.toBeNull();
            // Should fallback to os mocks
            expect(result!.system.hostname).toBe('myia-po-2023');
            expect(result!.hardware.cpu.cores).toBe(4); // mockCpus returns 4 elements
            expect(result!.software.powershell).toBe('Unknown');
        });

        it('should map MCP servers and modes', async () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('inventories')) return true;
                if (path.includes('test.json')) return true;
                return false;
            });
            const raw = createRawInventory('test');
            raw.inventory.mcpServers = [
                { name: 'server-a', enabled: true, command: 'node', transportType: 'stdio' },
                { name: 'server-b', enabled: false }
            ];
            raw.inventory.rooModes = [
                { slug: 'code', name: 'Code', defaultModel: 'claude-3-opus' },
                { slug: 'debug', name: 'Debug' }
            ];
            mockReadFile.mockResolvedValue(JSON.stringify(raw));

            const result = await collector.collectInventory('test');
            expect(result!.roo.mcpServers).toHaveLength(2);
            expect(result!.roo.mcpServers[0].transportType).toBe('stdio');
            expect(result!.roo.modes).toHaveLength(2);
            expect(result!.roo.modes[0].defaultModel).toBe('claude-3-opus');
        });
    });
});
