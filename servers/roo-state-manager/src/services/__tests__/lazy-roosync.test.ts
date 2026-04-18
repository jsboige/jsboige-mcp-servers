/**
 * Tests pour lazy-roosync (issue #1110 - Lazy facade for RooSyncService)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRooSyncService, RooSyncService, RooSyncServiceError } from '../lazy-roosync.js';

// Mock the RooSyncService module
vi.mock('../RooSyncService.js', () => ({
    RooSyncServiceError: class MockRooSyncServiceError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'RooSyncServiceError';
        }
    },
    getRooSyncService: vi.fn(() => Promise.resolve('mock-service-instance')),
    RooSyncService: {
        resetInstance: vi.fn(),
        getInstance: vi.fn((options) => Promise.resolve({ options, name: 'mock-instance' })),
    },
}));

describe('lazy-roosync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        // Clear module cache between tests
        vi.resetModules();
    });

    describe('getRooSyncService', () => {
        it('devrait charger RooSyncService de manière lazy au premier appel', async () => {
            const service = await getRooSyncService();

            expect(service).toBeDefined();
        });

        it('devrait mettre en cache le module chargé', async () => {
            const service1 = await getRooSyncService();
            const service2 = await getRooSyncService();

            expect(service1).toBe(service2);
        });
    });

    describe('RooSyncService facade', () => {
        it('devrait exporter resetInstance', async () => {
            await expect(RooSyncService.resetInstance()).resolves.toBeUndefined();
        });

        it('devrait exporter getInstance', async () => {
            const instance = await RooSyncService.getInstance();

            expect(instance).toBeDefined();
            expect(instance).toEqual({ name: 'mock-instance', options: undefined });
        });

        it('devrait passer les options à getInstance', async () => {
            const options = { enabled: false };
            const instance = await RooSyncService.getInstance(options);

            expect(instance.options).toEqual(options);
        });
    });

    describe('RooSyncServiceError export', () => {
        it('devrait exporter RooSyncServiceError de manière synchrone', () => {
            expect(RooSyncServiceError).toBeDefined();
            expect(typeof RooSyncServiceError).toBe('function');
        });

        it('devrait créer une instance de RooSyncServiceError', () => {
            const error = new RooSyncServiceError('test error');

            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe('RooSyncServiceError');
            expect(error.message).toContain('test error');
        });
    });

    describe('Concurrency handling', () => {
        it('devrait gérer les appels simultanés sans deadlock', async () => {
            const promises = [
                getRooSyncService(),
                getRooSyncService(),
                getRooSyncService(),
            ];

            const results = await Promise.all(promises);

            // Tous devraient retourner la même instance (même module chargé une seule fois)
            expect(results[0]).toBe(results[1]);
            expect(results[1]).toBe(results[2]);
        });
    });
});
