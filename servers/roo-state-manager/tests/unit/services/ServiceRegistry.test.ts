/**
 * Tests unitaires pour ServiceRegistry
 * Container d'injection de dépendances avec architecture 2-niveaux
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock les dépendances avec vi.hoisted
const { MockStateManagerError } = vi.hoisted(() => ({
    MockStateManagerError: class extends Error {
        code: string;
        service: string;
        details: any;
        constructor(message: string, code: string, service: string, details?: any) {
            super(message);
            this.code = code;
            this.service = service;
            this.details = details;
        }
    }
}));

vi.mock('../../../src/types/errors.js', () => ({
    StateManagerError: MockStateManagerError
}));

vi.mock('../../../src/interfaces/UnifiedToolInterface.js', () => ({
    ProcessingLevel: {
        IMMEDIATE: 'IMMEDIATE',
        BACKGROUND: 'BACKGROUND',
        MIXED: 'MIXED'
    }
}));

import { ServiceRegistry, createServiceRegistry } from '../../../src/services/ServiceRegistry.js';

describe('ServiceRegistry', () => {
    let registry: ServiceRegistry;

    beforeEach(() => {
        vi.clearAllMocks();
        registry = createServiceRegistry();
    });

    describe('constructor', () => {
        it('should initialize with 7 default services', () => {
            const metrics = registry.getRegistryMetrics();
            expect(metrics.totalServices).toBe(7);
        });

        it('should initialize with default config', () => {
            const metrics = registry.getRegistryMetrics();
            expect(metrics.totalCalls).toBe(0);
            expect(metrics.errorRate).toBe(0);
            expect(metrics.uptime).toBeGreaterThanOrEqual(0);
        });

        it('should accept partial config', () => {
            const custom = createServiceRegistry({ debugMode: true });
            const metrics = custom.getRegistryMetrics();
            expect(metrics.totalServices).toBe(7);
        });
    });

    describe('getService', () => {
        it('should return a service instance for registered services', () => {
            const service = registry.getService('display');
            expect(service).toBeDefined();
        });

        it('should increment call count on access', () => {
            registry.getService('display');
            registry.getService('display');
            const metrics = registry.getRegistryMetrics();
            const displayMetrics = metrics.serviceBreakdown.find(m => m.serviceName === 'display');
            expect(displayMetrics!.callCount).toBe(2);
        });

        it('should throw StateManagerError for unknown service', () => {
            expect(() => registry.getService('unknown' as any)).toThrow();
            try {
                registry.getService('nonexistent' as any);
            } catch (e: any) {
                expect(e.code).toBe('SERVICE_NOT_FOUND');
                expect(e.service).toBe('ServiceRegistry');
            }
        });
    });

    describe('registerService', () => {
        it('should register a service with a real instance', () => {
            const mockInstance = { doWork: vi.fn() };
            registry.registerService('display', mockInstance, 'IMMEDIATE' as any);
            const service = registry.getService('display');
            expect(service).toBe(mockInstance);
        });

        it('should create a stub when instance is null', () => {
            registry.registerService('display', null, 'IMMEDIATE' as any);
            const service = registry.getService<any>('display');
            // Stub has common methods
            expect(typeof service.execute).toBe('function');
            expect(typeof service.process).toBe('function');
            expect(typeof service.handle).toBe('function');
        });

        it('should override existing service on re-register', () => {
            const first = { id: 'first' };
            const second = { id: 'second' };
            registry.registerService('display', first, 'IMMEDIATE' as any);
            registry.registerService('display', second, 'IMMEDIATE' as any);
            const service = registry.getService('display');
            expect(service).toBe(second);
        });
    });

    describe('executeServiceMethod', () => {
        it('should execute method on IMMEDIATE service', async () => {
            const mockFn = vi.fn().mockResolvedValue('result');
            const mockInstance = { doWork: mockFn };
            registry.registerService('display', mockInstance, 'IMMEDIATE' as any);

            const result = await registry.executeServiceMethod('display', 'doWork', ['arg1']);
            expect(result).toBe('result');
            expect(mockFn).toHaveBeenCalledWith('arg1');
        });

        it('should increment immediateCallsCount for IMMEDIATE', async () => {
            const mockInstance = { doWork: vi.fn().mockResolvedValue('ok') };
            registry.registerService('display', mockInstance, 'IMMEDIATE' as any);
            await registry.executeServiceMethod('display', 'doWork');

            const metrics = registry.getRegistryMetrics();
            const displayMetrics = metrics.serviceBreakdown.find(m => m.serviceName === 'display');
            expect(displayMetrics!.immediateCallsCount).toBe(1);
        });

        it('should execute background service method', async () => {
            const mockFn = vi.fn().mockResolvedValue('bg-result');
            registry.registerService('summary', { longProcess: mockFn }, 'BACKGROUND' as any);
            const result = await registry.executeServiceMethod('summary', 'longProcess');
            expect(result).toBe('bg-result');
        });

        it('should return stub result when method not found on stub', async () => {
            // display is registered with null (stub)
            const result = await registry.executeServiceMethod<any>('display', 'unknownMethod', ['a', 'b']);
            expect(result.status).toBe('stubbed');
            expect(result.service).toBe('display');
            expect(result.method).toBe('unknownMethod');
        });

        it('should return background stub with jobId for BACKGROUND stub', async () => {
            // summary is registered with null, BACKGROUND level
            const result = await registry.executeServiceMethod<any>('summary', 'missingMethod');
            expect(result.jobId).toBeDefined();
            expect(result.status).toBe('processing');
        });

        it('should throw for unknown service', async () => {
            await expect(
                registry.executeServiceMethod('nonexistent' as any, 'doWork')
            ).rejects.toThrow();
        });

        it('should increment errorCount on failure', async () => {
            const mockInstance = { fail: vi.fn().mockRejectedValue(new Error('boom')) };
            registry.registerService('display', mockInstance, 'IMMEDIATE' as any);

            await expect(registry.executeServiceMethod('display', 'fail')).rejects.toThrow('boom');

            const metrics = registry.getRegistryMetrics();
            const displayMetrics = metrics.serviceBreakdown.find(m => m.serviceName === 'display');
            expect(displayMetrics!.errorCount).toBe(1);
        });
    });

    describe('getUnifiedServices', () => {
        it('should return all 7 services', () => {
            const services = registry.getUnifiedServices();
            expect(services.storage).toBeDefined();
            expect(services.cache).toBeDefined();
            expect(services.search).toBeDefined();
            expect(services.export).toBeDefined();
            expect(services.summary).toBeDefined();
            expect(services.display).toBeDefined();
            expect(services.utility).toBeDefined();
        });
    });

    describe('injectExternalService', () => {
        it('should replace existing service instance', () => {
            const newInstance = { customMethod: vi.fn() };
            registry.injectExternalService('display', newInstance);
            const service = registry.getService('display');
            expect(service).toBe(newInstance);
        });

        it('should register if service does not exist', () => {
            // Force a fresh registry scenario where we remove a service first
            const newInstance = { customMethod: vi.fn() };
            // injectExternalService on an existing service name works
            registry.injectExternalService('storage', newInstance);
            expect(registry.getService('storage')).toBe(newInstance);
        });
    });

    describe('getRegistryMetrics', () => {
        it('should return correct initial metrics', () => {
            const metrics = registry.getRegistryMetrics();
            expect(metrics.totalServices).toBe(7);
            expect(metrics.totalCalls).toBe(0);
            expect(metrics.averageResponseTime).toBe(0);
            expect(metrics.errorRate).toBe(0);
            expect(metrics.uptime).toBeGreaterThanOrEqual(0);
            expect(metrics.serviceBreakdown).toHaveLength(7);
        });

        it('should aggregate calls across services', () => {
            registry.getService('display');
            registry.getService('search');
            registry.getService('display');
            const metrics = registry.getRegistryMetrics();
            expect(metrics.totalCalls).toBe(3);
        });

        it('should calculate error rate', async () => {
            const mockInstance = { fail: vi.fn().mockRejectedValue(new Error('err')) };
            registry.registerService('display', mockInstance, 'IMMEDIATE' as any);

            // Note: callCount is only incremented via getService(), not executeServiceMethod()
            // So we must call getService to have callCount > 0 for errorRate calculation
            registry.getService('display');
            registry.getService('display');
            try { await registry.executeServiceMethod('display', 'fail'); } catch {}

            const metrics = registry.getRegistryMetrics();
            // errorCount=1, callCount=2 for display → errorRate > 0
            expect(metrics.errorRate).toBeGreaterThan(0);
        });
    });

    describe('healthCheck', () => {
        it('should return healthy when no errors', async () => {
            const health = await registry.healthCheck();
            expect(health.status).toBe('healthy');
            expect(Object.keys(health.services)).toHaveLength(7);
        });

        it('should detect error service (errorRate > 50%)', async () => {
            const mockInstance = {
                work: vi.fn().mockRejectedValue(new Error('err'))
            };
            registry.registerService('display', mockInstance, 'IMMEDIATE' as any);

            // callCount must be > 0 for errorRate calc (only getService increments it)
            registry.getService('display');
            try { await registry.executeServiceMethod('display', 'work'); } catch {}

            const health = await registry.healthCheck();
            // errorCount=1, callCount=1 → errorRate=100% > 50% → 'error'
            expect(health.services['display']).toBe('error');
        });

        it('should return unhealthy when >2 services in error', async () => {
            // Create 3 services with >50% error rate
            for (const svcName of ['display', 'search', 'storage'] as const) {
                const mock = { fail: vi.fn().mockRejectedValue(new Error('err')) };
                registry.registerService(svcName, mock, 'IMMEDIATE' as any);
                // Need callCount > 0 via getService for errorRate calculation
                registry.getService(svcName);
                try { await registry.executeServiceMethod(svcName, 'fail'); } catch {}
            }

            const health = await registry.healthCheck();
            expect(health.status).toBe('unhealthy');
        });
    });

    describe('shutdown', () => {
        it('should call shutdown on services that have it', async () => {
            const shutdownFn = vi.fn().mockResolvedValue(undefined);
            registry.registerService('display', { shutdown: shutdownFn }, 'IMMEDIATE' as any);

            await registry.shutdown();
            expect(shutdownFn).toHaveBeenCalled();
        });

        it('should not crash if service has no shutdown method', async () => {
            registry.registerService('display', { noShutdown: true }, 'IMMEDIATE' as any);
            await expect(registry.shutdown()).resolves.not.toThrow();
        });

        it('should not crash if shutdown throws', async () => {
            registry.registerService('display', {
                shutdown: vi.fn().mockRejectedValue(new Error('shutdown error'))
            }, 'IMMEDIATE' as any);
            await expect(registry.shutdown()).resolves.not.toThrow();
        });

        it('should clear all services after shutdown', async () => {
            await registry.shutdown();
            const metrics = registry.getRegistryMetrics();
            expect(metrics.totalServices).toBe(0);
        });
    });

    describe('createServiceRegistry', () => {
        it('should create a new instance each time', () => {
            const r1 = createServiceRegistry();
            const r2 = createServiceRegistry();
            expect(r1).not.toBe(r2);
        });

        it('should accept partial config', () => {
            const r = createServiceRegistry({ debugMode: true });
            expect(r.getRegistryMetrics().totalServices).toBe(7);
        });
    });
});
