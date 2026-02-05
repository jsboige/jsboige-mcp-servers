/**
 * Tests unitaires pour export_config
 *
 * CONS-10: Outil consolidé qui remplace configure_xml_export
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module export/export-config.test
 * @version 1.0.0 (CONS-10)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleExportConfig, exportConfigTool, ExportConfigArgs } from '../export-config.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Helper to extract text from CallToolResult content */
function getTextContent(result: CallToolResult, index: number = 0): string {
    const content = result.content[index];
    if (content && content.type === 'text') {
        return content.text;
    }
    return '';
}

// Mock ExportConfigManager
const createMockConfigManager = () => ({
    getConfig: vi.fn().mockResolvedValue({
        prettyPrint: true,
        includeContent: false,
        maxDepth: 10
    }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    resetConfig: vi.fn().mockResolvedValue(undefined)
});

describe('export_config - CONS-10', () => {
    let mockConfigManager: ReturnType<typeof createMockConfigManager>;

    beforeEach(() => {
        mockConfigManager = createMockConfigManager();
        vi.clearAllMocks();
    });

    // ============================================================
    // Tests de validation des arguments
    // ============================================================

    describe('argument validation', () => {
        test('should return error when action is missing', async () => {
            const args = {} as ExportConfigArgs;

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('action');
        });

        test('should return error when action is invalid', async () => {
            const args = { action: 'invalid' as any };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('invalide');
        });
    });

    // ============================================================
    // Tests pour action: get
    // ============================================================

    describe('action: get', () => {
        test('should return current config', async () => {
            const args: ExportConfigArgs = { action: 'get' };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBeFalsy();
            expect(mockConfigManager.getConfig).toHaveBeenCalled();
            expect(getTextContent(result)).toContain('prettyPrint');
        });
    });

    // ============================================================
    // Tests pour action: set
    // ============================================================

    describe('action: set', () => {
        test('should update config successfully', async () => {
            const args: ExportConfigArgs = {
                action: 'set',
                config: { prettyPrint: false }
            };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBeFalsy();
            expect(mockConfigManager.updateConfig).toHaveBeenCalledWith({ prettyPrint: false });
            expect(getTextContent(result)).toContain('succès');
        });

        test('should return error when config is missing for set action', async () => {
            const args: ExportConfigArgs = { action: 'set' };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('manquante');
        });
    });

    // ============================================================
    // Tests pour action: reset
    // ============================================================

    describe('action: reset', () => {
        test('should reset config to defaults', async () => {
            const args: ExportConfigArgs = { action: 'reset' };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBeFalsy();
            expect(mockConfigManager.resetConfig).toHaveBeenCalled();
            expect(getTextContent(result)).toContain('défaut');
        });
    });

    // ============================================================
    // Tests de gestion des erreurs
    // ============================================================

    describe('error handling', () => {
        test('should handle getConfig error', async () => {
            mockConfigManager.getConfig.mockRejectedValueOnce(new Error('Config error'));
            const args: ExportConfigArgs = { action: 'get' };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('Config error');
        });

        test('should handle updateConfig error', async () => {
            mockConfigManager.updateConfig.mockRejectedValueOnce(new Error('Update error'));
            const args: ExportConfigArgs = {
                action: 'set',
                config: { setting: 'value' }
            };

            const result = await handleExportConfig(args, mockConfigManager as any);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('Update error');
        });
    });

    // ============================================================
    // Tests de la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        test('should have correct name', () => {
            expect(exportConfigTool.name).toBe('export_config');
        });

        test('should have action as required parameter', () => {
            expect(exportConfigTool.inputSchema.required).toContain('action');
        });

        test('should have correct action enum values', () => {
            const props = exportConfigTool.inputSchema.properties as any;
            expect(props.action.enum).toEqual(['get', 'set', 'reset']);
        });

        test('should have config parameter', () => {
            const props = exportConfigTool.inputSchema.properties as any;
            expect(props.config).toBeDefined();
            expect(props.config.type).toBe('object');
        });

        test('description should mention CONS-10', () => {
            expect(exportConfigTool.description).toContain('CONS-10');
        });
    });
});
