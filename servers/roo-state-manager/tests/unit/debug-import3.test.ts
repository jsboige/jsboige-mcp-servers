import { describe, it, expect } from 'vitest';
import { InventoryCollector } from '../../src/services/InventoryCollector.js';

describe('DEBUG: Import InventoryCollector 3', () => {
    it('should check all available methods', () => {
        const collector = new InventoryCollector();
        const proto = Object.getPrototypeOf(collector);
        const methods = Object.getOwnPropertyNames(proto);
        console.log('=== Methods found ===');
        console.log('methods:', methods);
        console.log('=== typeof checks ===');
        console.log('getCacheStats:', typeof collector.getCacheStats);
        console.log('clearCache:', typeof collector.clearCache);
        console.log('collectInventory:', typeof collector.collectInventory);
        console.log('constructor:', typeof collector.constructor);
        expect(methods.length).toBeGreaterThan(0);
    });
});
