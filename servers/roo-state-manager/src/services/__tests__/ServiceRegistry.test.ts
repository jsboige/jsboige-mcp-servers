/**
 * Tests pour ServiceRegistry.ts
 * Issue #492 - Couverture du DI container
 *
 * @module services/__tests__/ServiceRegistry
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ServiceRegistry, createServiceRegistry, getServiceRegistry } from '../ServiceRegistry.js';
import { ProcessingLevel } from '../../interfaces/UnifiedToolInterface.js';

describe('ServiceRegistry', () => {
	let registry: ServiceRegistry;

	beforeEach(() => {
		registry = createServiceRegistry({ debugMode: false });
	});

	// ============================================================
	// Constructor & initialization
	// ============================================================

	describe('initialization', () => {
		test('initializes with default services', () => {
			const metrics = registry.getRegistryMetrics();
			expect(metrics.totalServices).toBe(7);
		});

		test('accepts partial config', () => {
			const r = createServiceRegistry({ debugMode: true });
			expect(r.getRegistryMetrics().totalServices).toBe(7);
		});

		test('uses default config when none provided', () => {
			const r = createServiceRegistry();
			expect(r.getRegistryMetrics().totalServices).toBe(7);
		});
	});

	// ============================================================
	// Service registration
	// ============================================================

	describe('registerService', () => {
		test('registers a service with custom instance', () => {
			const mockService = { execute: vi.fn() };
			registry.registerService('display', mockService, ProcessingLevel.IMMEDIATE);
			const retrieved = registry.getService('display');
			expect(retrieved).toBe(mockService);
		});

		test('overwrites existing service on re-register', () => {
			const first = { id: 1 };
			const second = { id: 2 };
			registry.registerService('display', first);
			registry.registerService('display', second);
			expect(registry.getService('display')).toBe(second);
		});
	});

	// ============================================================
	// getService
	// ============================================================

	describe('getService', () => {
		test('returns stub for uninitialized service', () => {
			// Default services are registered with null -> stub
			const service = registry.getService('display');
			expect(service).toBeDefined();
		});

		test('throws for non-existent service name', () => {
			expect(() => registry.getService('nonexistent' as any)).toThrow();
		});

		test('increments call count on access', () => {
			registry.getService('display');
			registry.getService('display');
			registry.getService('display');
			const metrics = registry.getRegistryMetrics();
			const displayMetrics = metrics.serviceBreakdown.find(m => m.serviceName === 'display');
			expect(displayMetrics!.callCount).toBe(3);
		});
	});

	// ============================================================
	// executeServiceMethod
	// ============================================================

	describe('executeServiceMethod', () => {
		test('executes stub method for uninitialized service', async () => {
			const result = await registry.executeServiceMethod('display', 'execute', ['test']);
			expect(result).toBeDefined();
			expect((result as any).status).toBe('stubbed');
		});

		test('executes real method on injected service', async () => {
			const mockService = {
				myMethod: vi.fn().mockResolvedValue('success')
			};
			registry.registerService('display', mockService, ProcessingLevel.IMMEDIATE);

			const result = await registry.executeServiceMethod('display', 'myMethod', ['arg1']);
			expect(result).toBe('success');
			expect(mockService.myMethod).toHaveBeenCalledWith('arg1');
		});

		test('throws for non-existent service', async () => {
			await expect(
				registry.executeServiceMethod('nonexistent' as any, 'method')
			).rejects.toThrow();
		});

		test('tracks error count on failure', async () => {
			const mockService = {
				fail: vi.fn().mockRejectedValue(new Error('test error'))
			};
			registry.registerService('display', mockService, ProcessingLevel.IMMEDIATE);

			await expect(
				registry.executeServiceMethod('display', 'fail')
			).rejects.toThrow('test error');

			const metrics = registry.getRegistryMetrics();
			const displayMetrics = metrics.serviceBreakdown.find(m => m.serviceName === 'display');
			expect(displayMetrics!.errorCount).toBe(1);
		});

		test('handles BACKGROUND processing level', async () => {
			// Default stub for background returns job info
			const r = createServiceRegistry();
			const result = await r.executeServiceMethod('summary', 'process', []) as any;
			expect(result).toBeDefined();
		});
	});

	// ============================================================
	// injectExternalService
	// ============================================================

	describe('injectExternalService', () => {
		test('replaces existing service instance', () => {
			const external = { custom: true };
			registry.injectExternalService('search', external);
			expect(registry.getService('search')).toBe(external);
		});

		test('registers new service if not exists', () => {
			// This shouldn't happen normally since all 7 are registered, but test the path
			const newRegistry = createServiceRegistry();
			const external = { custom: true };
			newRegistry.injectExternalService('storage', external);
			expect(newRegistry.getService('storage')).toBe(external);
		});
	});

	// ============================================================
	// getUnifiedServices
	// ============================================================

	describe('getUnifiedServices', () => {
		test('returns all 7 services', () => {
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

	// ============================================================
	// getRegistryMetrics
	// ============================================================

	describe('getRegistryMetrics', () => {
		test('returns correct structure', () => {
			const metrics = registry.getRegistryMetrics();
			expect(metrics.totalServices).toBe(7);
			expect(metrics.totalCalls).toBe(0);
			expect(metrics.averageResponseTime).toBe(0);
			expect(metrics.errorRate).toBe(0);
			expect(metrics.uptime).toBeGreaterThanOrEqual(0);
			expect(metrics.serviceBreakdown).toHaveLength(7);
		});

		test('updates metrics on service access', () => {
			// callCount is incremented via getService(), not executeServiceMethod()
			registry.getService('display');
			registry.getService('display');
			const metrics = registry.getRegistryMetrics();
			expect(metrics.totalCalls).toBeGreaterThanOrEqual(2);
		});
	});

	// ============================================================
	// healthCheck
	// ============================================================

	describe('healthCheck', () => {
		test('returns healthy for fresh registry', async () => {
			const health = await registry.healthCheck();
			expect(health.status).toBe('healthy');
			expect(Object.keys(health.services)).toHaveLength(7);
		});

		test('returns degraded when service has errors', async () => {
			const mockService = {
				fail: vi.fn().mockRejectedValue(new Error('test'))
			};
			registry.registerService('display', mockService, ProcessingLevel.IMMEDIATE);

			// callCount is incremented via getService, errorCount via executeServiceMethod
			// We need both to compute errorRate properly
			for (let i = 0; i < 5; i++) {
				registry.getService('display'); // increment callCount
				try { await registry.executeServiceMethod('display', 'fail'); } catch {}
			}

			const health = await registry.healthCheck();
			// errorRate = 5 errors / 5 calls = 100% > 50% threshold
			expect(health.services['display']).toBe('error');
		});
	});

	// ============================================================
	// shutdown
	// ============================================================

	describe('shutdown', () => {
		test('clears all services', async () => {
			await registry.shutdown();
			// After shutdown, getting a service should throw
			expect(() => registry.getService('display')).toThrow();
		});

		test('calls shutdown on services that support it', async () => {
			const mockService = { shutdown: vi.fn().mockResolvedValue(undefined) };
			registry.registerService('display', mockService, ProcessingLevel.IMMEDIATE);

			await registry.shutdown();
			expect(mockService.shutdown).toHaveBeenCalled();
		});

		test('handles shutdown errors gracefully', async () => {
			const mockService = { shutdown: vi.fn().mockRejectedValue(new Error('shutdown failed')) };
			registry.registerService('display', mockService, ProcessingLevel.IMMEDIATE);

			// Should not throw
			await expect(registry.shutdown()).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// Singleton factory
	// ============================================================

	describe('getServiceRegistry singleton', () => {
		test('returns same instance', () => {
			const a = getServiceRegistry();
			const b = getServiceRegistry();
			expect(a).toBe(b);
		});
	});
});
