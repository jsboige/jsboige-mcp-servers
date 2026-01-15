import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unmock fs to use real filesystem for performance tests
vi.unmock('fs/promises');
vi.unmock('fs');

import { BaselineService } from '../../src/services/BaselineService.js';
import { BaselineFileConfig } from '../../src/types/baseline.js';
import { ConfigService } from '../../src/services/ConfigService.js';
import { InventoryCollectorWrapper } from '../../src/services/InventoryCollectorWrapper.js';
import { InventoryCollector } from '../../src/services/InventoryCollector.js';
import { DiffDetector } from '../../src/services/DiffDetector.js';
import { join } from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

describe('Performance & Concurrency', () => {
    let tempDir: string;
    let sharedPath: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'roo-perf-test-'));
        sharedPath = join(tempDir, 'shared');
        await mkdir(sharedPath, { recursive: true });
        
        // Mock environment variables - BaselineService uses SHARED_STATE_PATH
        process.env.SHARED_STATE_PATH = sharedPath;
        process.env.ROOSYNC_MACHINE_ID = 'perf-machine';
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('should handle concurrent baseline comparisons', async () => {
        const configService = new ConfigService();
        vi.spyOn(configService, 'getSharedStatePath').mockReturnValue(sharedPath);
        
        const baseCollector = new InventoryCollector();
        const inventoryCollector = new InventoryCollectorWrapper(baseCollector);
        
        // Mock inventory to be fast but async
        vi.spyOn(inventoryCollector, 'collectInventory').mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 10)); // Simulate 10ms work
            return {
                machineId: 'perf-machine',
                timestamp: new Date().toISOString(),
                config: {
                    roo: { modes: ['code'] },
                    hardware: {},
                    software: {},
                    system: {}
                },
                metadata: { source: 'test' }
            } as any;
        });

        const diffDetector = new DiffDetector();
        const baselineService = new BaselineService(configService, inventoryCollector, diffDetector);

        // Create baseline
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
                        modes: ['code'],
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

        // Wait for file to be fully written (timing issue)
        await new Promise(resolve => setTimeout(resolve, 50));

        // Run 50 concurrent comparisons
        const iterations = 50;
        const start = performance.now();
        
        const promises = [];
        for (let i = 0; i < iterations; i++) {
            promises.push(baselineService.compareWithBaseline('perf-machine'));
        }
        
        const results = await Promise.all(promises);
        const end = performance.now();
        const duration = end - start;

        console.log(`Executed ${iterations} concurrent comparisons in ${duration.toFixed(2)}ms`);
        console.log(`Average time per comparison: ${(duration / iterations).toFixed(2)}ms`);

        expect(results.length).toBe(iterations);
        results.forEach(report => {
            expect(report).toBeDefined();
        });
        
        // Performance assertion: Should be significantly faster than serial execution (50 * 10ms = 500ms)
        // We allow some overhead, but it should definitely be under 400ms
        expect(duration).toBeLessThan(400); 
    });
});
