import { describe, it, expect } from 'vitest';
import { InventoryCollector } from '../../src/services/InventoryCollector.js';

describe('DEBUG: Import InventoryCollector 2', () => {
    it('should have methods', () => {
        const collector = new InventoryCollector();
        const proto = Object.getPrototypeOf(collector);
        const methods = Object.getOwnPropertyNames(proto);
        expect(typeof collector).toBe('object');
        expect(typeof collector.getCacheStats).toBe('function');
        expect(typeof collector.clearCache).toBe('function');
        expect(typeof collector.collectInventory).toBe('function');
        expect(methods).toContain('getCacheStats');
        expect(methods).toContain('clearCache');
        expect(methods).toContain('collectInventory');
    });
});
