/**
 * Tests pour get-machine-inventory.ts
 * Issue #492 - Couverture des outils non-roosync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockGetMachineInventory } = vi.hoisted(() => ({
	mockGetMachineInventory: vi.fn()
}));

vi.mock('../../../services/roosync/InventoryService.js', () => ({
	InventoryService: {
		getInstance: vi.fn(() => ({
			getMachineInventory: mockGetMachineInventory
		}))
	}
}));

vi.mock('../../../interfaces/UnifiedToolInterface.js', () => ({
	ToolCategory: { UTILITY: 'utility' },
	ProcessingLevel: { IMMEDIATE: 'immediate' }
}));

// Fix #636 timeout: Use static import instead of dynamic imports
import { getMachineInventoryTool } from '../get-machine-inventory.js';

describe('get-machine-inventory', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('returns inventory for default machine', async () => {
		const mockInventory = {
			machineId: 'ai-01',
			os: { platform: 'win32', arch: 'x64' },
			software: { node: '20.0.0' }
		};
		mockGetMachineInventory.mockResolvedValue(mockInventory);

			const result = await getMachineInventoryTool.execute({}, {});

		expect(result.success).toBe(true);
		expect(result.data).toEqual(mockInventory);
		expect(result.metrics?.executionTime).toBeGreaterThanOrEqual(0);
	});

	test('passes machineId to service', async () => {
		mockGetMachineInventory.mockResolvedValue({ machineId: 'po-2023' });

			await getMachineInventoryTool.execute({ machineId: 'po-2023' }, {});

		expect(mockGetMachineInventory).toHaveBeenCalledWith('po-2023');
	});

	test('returns error on service failure', async () => {
		mockGetMachineInventory.mockRejectedValue(new Error('Service unavailable'));

			const result = await getMachineInventoryTool.execute({}, {});

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe('INVENTORY_COLLECTION_FAILED');
		expect(result.error?.message).toContain('Service unavailable');
	});

	test('has correct tool metadata', async () => {
			expect(getMachineInventoryTool.name).toBe('roosync_get_machine_inventory');
		expect(getMachineInventoryTool.version).toBe('1.0.0');
	});

	test('input schema accepts empty object', async () => {
			const parsed = getMachineInventoryTool.inputSchema.parse({});
		expect(parsed.machineId).toBeUndefined();
	});

	test('input schema accepts machineId', async () => {
			const parsed = getMachineInventoryTool.inputSchema.parse({ machineId: 'test-host' });
		expect(parsed.machineId).toBe('test-host');
	});
});
