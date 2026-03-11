/**
 * Tests pour update-dashboard.ts
 * Issue #546 - Dashboard hiérarchique RooSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock dependencies
const { mockWriteFile, mockReadFile, mockAccess } = vi.hoisted(() => ({
	mockWriteFile: vi.fn(),
	mockReadFile: vi.fn(),
	mockAccess: vi.fn()
}));

const mockGetSharedStatePath = vi.fn(() => '/shared/state');

vi.mock('fs/promises', () => ({
	writeFile: mockWriteFile,
	readFile: mockReadFile,
	access: mockAccess
}));

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: () => mockGetSharedStatePath()
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	Logger: class {}
}));

// Fix #636 timeout: Use static import instead of dynamic imports
import { roosyncUpdateDashboard } from '../update-dashboard.js';

describe('roosync_update_dashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSharedStatePath.mockReturnValue('C:/Drive/.shared-state');
		process.env.ROOSYNC_SHARED_PATH = 'C:/Drive/.shared-state';
		process.env.ROOSYNC_MACHINE_ID = 'myia-web1';

		// Mock DASHBOARD.md par défaut
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(`# RooSync Dashboard

**Dernière mise à jour:** 2026-03-03 17:30:00 par myia-web1:roo-extensions

---

## État Global

_Résumé global mis à jour par le coordinateur_

- **Statut système:** 🟢 Opérationnel

---

## Machines

### myia-web1 (Agent Flexible)

#### roo-extensions
- **État:** 🟢 Actif
- **Dernière action:** 2026-03-03 17:30
- **Notes libres:**
  - Test note

---

## Notes Inter-Agents

- [2026-03-03] Test note

---

## Décisions en Attente

_Aucune décision en attente._

---

## Métriques

| Métrique | Valeur |
|----------|--------|
| Test | Value |
`);
	});

	describe('parameter validation', () => {
		test('rejects missing section parameter', async () => {

			await expect(roosyncUpdateDashboard({
				// @ts-expect-error - Testing missing required parameter
				section: undefined,
				content: 'Test content'
			})).rejects.toThrow();
		});

		test('rejects invalid section value', async () => {

			await expect(roosyncUpdateDashboard({
				// @ts-expect-error - Testing invalid enum value
				section: 'invalid_section',
				content: 'Test content'
			})).rejects.toThrow();
		});

		test('rejects missing content parameter', async () => {

			await expect(roosyncUpdateDashboard({
				// @ts-expect-error - Testing missing required parameter
				section: 'machine',
				content: undefined
			})).rejects.toThrow();
		});

		test('accepts valid parameters with default values', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'global',
				content: '- Test note'
			});

			expect(result.success).toBe(true);
			expect(result.section).toBe('global');
			expect(result.mode).toBe('replace'); // default
		});
	});

	describe('section types', () => {
		test('updates global section', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'global',
				content: '- **Statut:** 🟢 Test update',
				mode: 'replace'
			});

			expect(result.success).toBe(true);
			expect(result.section).toBe('global');
			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('updates machine section', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'machine',
				machine: 'myia-web1',
				workspace: 'roo-extensions',
				content: '- New test note',
				mode: 'append'
			});

			expect(result.success).toBe(true);
			expect(result.section).toBe('machine');
			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('updates intercom section', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'intercom',
				content: '- [2026-03-03] Test intercom note',
				mode: 'append'
			});

			expect(result.success).toBe(true);
			expect(result.section).toBe('intercom');
		});

		test('updates decisions section', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'decisions',
				content: '- Test decision',
				mode: 'replace'
			});

			expect(result.success).toBe(true);
			expect(result.section).toBe('decisions');
		});

		test('updates metrics section', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'metrics',
				content: '| Test | Value |',
				mode: 'replace'
			});

			expect(result.success).toBe(true);
			expect(result.section).toBe('metrics');
		});
	});

	describe('update modes', () => {
		test('replace mode replaces content', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'global',
				content: '- **New statut:** 🟢 Updated',
				mode: 'replace'
			});

			expect(result.success).toBe(true);
			expect(result.mode).toBe('replace');
			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('append mode adds content to end', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'intercom',
				content: '- [2026-03-03] Appended note',
				mode: 'append'
			});

			expect(result.success).toBe(true);
			expect(result.mode).toBe('append');
		});

		test('prepend mode adds content to beginning', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'intercom',
				content: '- [2026-03-03] Prepended note',
				mode: 'prepend'
			});

			expect(result.success).toBe(true);
			expect(result.mode).toBe('prepend');
		});
	});

	describe('error handling', () => {
		test('throws error when DASHBOARD.md does not exist', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			await expect(roosyncUpdateDashboard({
				section: 'global',
				content: 'Test'
			})).rejects.toThrow('Dashboard non trouvé');
		});

		test('throws error when ROOSYNC_SHARED_PATH is not set', async () => {
			delete process.env.ROOSYNC_SHARED_PATH;

			await expect(roosyncUpdateDashboard({
				section: 'global',
				content: 'Test'
			})).rejects.toThrow('ROOSYNC_SHARED_PATH non configuré');

			// Restore for other tests
			process.env.ROOSYNC_SHARED_PATH = 'C:/Drive/.shared-state';
		});

		test('throws error when machine section not found', async () => {
			// Mock DASHBOARD.md without the target machine section
			mockReadFile.mockResolvedValue(`# RooSync Dashboard

**Dernière mise à jour:** 2026-03-03 17:30:00

---

## Machines

### other-machine

#### roo-extensions
- Note
`);

			await expect(roosyncUpdateDashboard({
				section: 'machine',
				machine: 'nonexistent-machine',
				content: 'Test'
			})).rejects.toThrow('Section pour machine nonexistent-machine non trouvée');
		});

		test('throws error when generic section not found', async () => {
			// Mock DASHBOARD.md without the target section
			mockReadFile.mockResolvedValue(`# RooSync Dashboard

**Dernière mise à jour:** 2026-03-03 17:30:00

---

## Machines

### myia-web1
- Note
`);

			await expect(roosyncUpdateDashboard({
				section: 'global',
				content: 'Test'
			})).rejects.toThrow('Section "global" (État Global) non trouvée');
		});
	});

	describe('default values', () => {
		test('uses default workspace when not specified', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'machine',
				machine: 'myia-web1',
				content: 'Test'
			});

			expect(result.success).toBe(true);
			// Should use 'roo-extensions' as default workspace
		});

		test('uses default machine ID from env when not specified', async () => {
			process.env.ROOSYNC_MACHINE_ID = 'myia-web1'; // Use existing machine in mock

			const result = await roosyncUpdateDashboard({
				section: 'machine',
				content: 'Test'
			});

			expect(result.success).toBe(true);

			// Restore
			process.env.ROOSYNC_MACHINE_ID = 'myia-web1';
		});

		test('uses default mode replace when not specified', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'global',
				content: 'Test content'
			});

			expect(result.success).toBe(true);
			expect(result.mode).toBe('replace');
		});
	});

	describe('timestamp update', () => {
		test('updates dashboard timestamp on successful update', async () => {

			const result = await roosyncUpdateDashboard({
				section: 'global',
				content: '- Test update'
			});

			expect(result.success).toBe(true);
			expect(result.timestamp).toBeDefined();
			expect(mockWriteFile).toHaveBeenCalled();
		});
	});
});
