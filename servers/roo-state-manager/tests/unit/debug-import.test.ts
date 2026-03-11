import { describe, it, expect } from 'vitest';
import { InventoryCollector } from '../../src/services/InventoryCollector.js';

describe('DEBUG: Import InventoryCollector', () => {
    it('should have methods', () => {
        const collector = new InventoryCollector();
        console.log('collector type:', typeof collector);
        console.log('collector constructor:', collector.constructor.name);
        console.log('collector proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(collector)));
        console.log('collector keys:', Object.keys(collector));
        console.log('Has getCacheStats:', typeof collector.getCacheStats);
        console.log('Has clearCache:', typeof collector.clearCache);
        console.log('Has collectInventory:', typeof collector.collectInventory);
        expect(typeof collector).toBe('object');
    });
});
