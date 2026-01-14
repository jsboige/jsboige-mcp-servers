import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock fs to use real filesystem for integration tests
vi.unmock('fs/promises');
vi.unmock('fs');

import { BaselineService } from '../../src/services/BaselineService.js';
import { BaselineFileConfig } from '../../src/types/baseline.js';
import { RooSyncService } from '../../src/services/RooSyncService.js';
import { ConfigService } from '../../src/services/ConfigService.js';
import { InventoryCollectorWrapper } from '../../src/services/InventoryCollectorWrapper.js';
import { InventoryCollector } from '../../src/services/InventoryCollector.js';
import { DiffDetector } from '../../src/services/DiffDetector.js';
import { join } from 'path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';

describe('New Modules Integration', () => {
    let tempDir: string;
    let sharedPath: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'roo-integration-test-'));
        sharedPath = join(tempDir, 'shared');
        await mkdir(sharedPath, { recursive: true });
        
        // Mock environment variables - BaselineService uses SHARED_STATE_PATH
        process.env.SHARED_STATE_PATH = sharedPath;
        process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    describe('BaselineService <-> RooSyncService Integration', () => {
        it('should integrate BaselineService with RooSyncService workflow', async () => {
            // 1. Setup Services
            const configService = new ConfigService();
            // Mock getSharedStatePath to return our temp path
            vi.spyOn(configService, 'getSharedStatePath').mockReturnValue(sharedPath);
            
            const baseCollector = new InventoryCollector();
            const inventoryCollector = new InventoryCollectorWrapper(baseCollector);
            // Mock inventory collection
            vi.spyOn(inventoryCollector, 'collectInventory').mockResolvedValue({
                machineId: 'test-machine',
                timestamp: new Date().toISOString(),
                config: {
                    roo: { modes: ['code'] },
                    hardware: {},
                    software: {},
                    system: {}
                },
                metadata: { source: 'test' }
            } as any);

            const diffDetector = new DiffDetector();
            const baselineService = new BaselineService(configService, inventoryCollector, diffDetector);

            // 2. Create a baseline file
            const baselineConfig: BaselineFileConfig = {
                version: '1.0.0',
                baselineId: 'baseline-1',
                timestamp: new Date().toISOString(),
                lastUpdated: new Date().toISOString(),
                machineId: 'baseline-machine',
                autoSync: false,
                conflictStrategy: 'manual',
                logLevel: 'INFO',
                sharedStatePath: sharedPath,
                machines: [
                    {
                        id: 'baseline-machine',
                        name: 'Baseline Machine',
                        hostname: 'baseline-host',
                        os: 'windows',
                        architecture: 'x64',
                        lastSeen: new Date().toISOString(),
                        roo: {
                            modes: ['code', 'architect'], // 'architect' is missing in local
                            mcpServers: [],
                            sdddSpecs: []
                        },
                        hardware: {
                            cpu: { cores: 8, threads: 16 },
                            memory: { total: 16000000000 }
                        },
                        software: {
                            node: '18.0.0',
                            python: '3.10.0'
                        }
                    }
                ],
                syncTargets: [],
                syncPaths: [],
                decisions: [],
                messages: []
            };
            await writeFile(join(sharedPath, 'sync-config.ref.json'), JSON.stringify(baselineConfig));

            // Verify file was written correctly
            const fileContent = await readFile(join(sharedPath, 'sync-config.ref.json'), 'utf-8');
            const parsedContent = JSON.parse(fileContent);
            expect(parsedContent.machines).toBeDefined();
            expect(parsedContent.machines.length).toBeGreaterThan(0);

            // 3. Run comparison
            const report = await baselineService.compareWithBaseline('test-machine');

            // 4. Verify integration results
            expect(report).toBeDefined();
            expect(report?.differences.length).toBeGreaterThan(0);
            expect(report?.differences[0].path).toContain('roo.modes');
            
            // 5. Create decisions
            const decisions = await baselineService.createSyncDecisions(report!);
            expect(decisions.length).toBeGreaterThan(0);
            expect(decisions[0].status).toBe('pending');
        });
    });
});