/**
 * Tests for configure-xml-export.ts
 * Issue #492 - Coverage for legacy XML export configuration tool
 *
 * @module tools/export/__tests__/configure-xml-export
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { configureXmlExportTool, handleConfigureXmlExport } from '../configure-xml-export.js';

describe('configureXmlExportTool', () => {
	// ============================================================
	// Tool definition
	// ============================================================

	test('has correct name', () => {
		expect(configureXmlExportTool.name).toBe('configure_xml_export');
	});

	test('requires action field', () => {
		expect(configureXmlExportTool.inputSchema.required).toEqual(['action']);
	});

	test('action has enum values', () => {
		const actionProp = (configureXmlExportTool.inputSchema.properties as any).action;
		expect(actionProp.enum).toEqual(['get', 'set', 'reset']);
	});

	test('has config property', () => {
		const configProp = (configureXmlExportTool.inputSchema.properties as any).config;
		expect(configProp.type).toBe('object');
	});
});

describe('handleConfigureXmlExport', () => {
	let mockManager: any;

	beforeEach(() => {
		vi.clearAllMocks();
		mockManager = {
			getConfig: vi.fn(),
			updateConfig: vi.fn(),
			resetConfig: vi.fn()
		};
	});

	// ============================================================
	// Get action
	// ============================================================

	test('get action returns current config as JSON', async () => {
		const config = { defaults: { prettyPrint: true }, templates: {}, filters: {} };
		mockManager.getConfig.mockResolvedValue(config);

		const result = await handleConfigureXmlExport(
			{ action: 'get' },
			mockManager
		);

		expect(mockManager.getConfig).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.defaults.prettyPrint).toBe(true);
	});

	// ============================================================
	// Set action
	// ============================================================

	test('set action calls updateConfig', async () => {
		const newConfig = { defaults: { prettyPrint: false } };
		mockManager.updateConfig.mockResolvedValue(undefined);

		const result = await handleConfigureXmlExport(
			{ action: 'set', config: newConfig },
			mockManager
		);

		expect(mockManager.updateConfig).toHaveBeenCalledWith(newConfig);
		expect(result.content[0].text).toContain('succès');
	});

	test('set action without config returns error message', async () => {
		const result = await handleConfigureXmlExport(
			{ action: 'set' },
			mockManager
		);

		// Error is caught internally and returned as error text
		expect(result.content[0].text).toContain('Erreur');
	});

	// ============================================================
	// Reset action
	// ============================================================

	test('reset action calls resetConfig', async () => {
		mockManager.resetConfig.mockResolvedValue(undefined);

		const result = await handleConfigureXmlExport(
			{ action: 'reset' },
			mockManager
		);

		expect(mockManager.resetConfig).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain('défaut');
	});

	// ============================================================
	// Error handling
	// ============================================================

	test('invalid action returns error message', async () => {
		const result = await handleConfigureXmlExport(
			{ action: 'invalid' as any },
			mockManager
		);

		expect(result.content[0].text).toContain('Erreur');
	});

	test('handler catches thrown errors', async () => {
		mockManager.getConfig.mockRejectedValue(new Error('Storage failure'));

		const result = await handleConfigureXmlExport(
			{ action: 'get' },
			mockManager
		);

		expect(result.content[0].text).toContain('Storage failure');
	});
});
