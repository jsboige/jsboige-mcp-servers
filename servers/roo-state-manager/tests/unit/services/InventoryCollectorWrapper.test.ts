import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InventoryCollectorWrapper } from '../../../src/services/InventoryCollectorWrapper.js';
import { InventoryCollector } from '../../../src/services/InventoryCollector.js';
import { promises as fs } from 'fs';
import { join } from 'path';

describe('InventoryCollectorWrapper', () => {
    let wrapper: InventoryCollectorWrapper;
    let mockCollector: InventoryCollector;

    beforeEach(() => {
        mockCollector = new InventoryCollector();
        wrapper = new InventoryCollectorWrapper(mockCollector);
        process.env.ROOSYNC_SHARED_PATH = '/mock/shared';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('collectInventory', () => {
        it('should delegate to local collector first', async () => {
            vi.spyOn(mockCollector, 'collectInventory').mockResolvedValue({
                machineId: 'local-machine',
                timestamp: '2023-01-01T00:00:00.000Z',
                hardware: { cpu: {}, memory: {}, disks: [], gpu: [] },
                software: { powershell: '', node: '', python: '' },
                system: { os: '', architecture: '' }
            } as any);

            const result = await wrapper.collectInventory('local-machine');
            
            expect(mockCollector.collectInventory).toHaveBeenCalledWith('local-machine', false);
            expect(result?.machineId).toBe('local-machine');
            expect(result?.metadata.source).toBe('local');
        });

        it('should fallback to shared state if local collection fails', async () => {
            vi.spyOn(mockCollector, 'collectInventory').mockRejectedValue(new Error('Local fail'));
            
            // Mock fs.readdir to return files
            vi.spyOn(fs, 'readdir').mockResolvedValue([
                'remote-machine-2023-01-01T00-00-00-000Z.json'
            ] as any);
            
            // Mock fs.readFile to return content
            vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
                machineId: 'remote-machine',
                timestamp: '2023-01-01T00:00:00.000Z',
                hardware: {},
                software: {},
                system: {}
            }) as any);

            const result = await wrapper.collectInventory('remote-machine');
            
            expect(result?.machineId).toBe('remote-machine');
            expect(result?.metadata.source).toBe('remote');
        });

        it('should prioritize -fixed files in shared state', async () => {
            vi.spyOn(mockCollector, 'collectInventory').mockRejectedValue(new Error('Local fail'));
            
            vi.spyOn(fs, 'readdir').mockResolvedValue([
                'remote-machine-2023-01-01T10-00-00-000Z.json',
                'remote-machine-2023-01-01T10-00-00-000Z-fixed.json'
            ] as any);
            
            vi.spyOn(fs, 'readFile').mockImplementation(async (path: any) => {
                const pathStr = String(path);
                if (pathStr.includes('-fixed')) {
                    return JSON.stringify({ 
                        machineId: 'remote-machine', 
                        timestamp: '2023-01-01T10:00:00.000Z',
                        variant: 'fixed' 
                    });
                }
                return JSON.stringify({ 
                    machineId: 'remote-machine', 
                    timestamp: '2023-01-01T10:00:00.000Z',
                    variant: 'normal' 
                });
            });

            const result = await wrapper.collectInventory('remote-machine');
            
            expect(fs.readFile).toHaveBeenCalledWith(
                expect.stringContaining('-fixed.json'), 
                'utf-8'
            );
            expect(result?.machineId).toBe('remote-machine');
        });
    });
});
