/**
 * Tests pour l'outil minimal_test_tool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleMinimalTest, minimalTestTool } from '../../../src/tools/test/minimal-test.tool';

describe('minimal_test_tool', () => {
    beforeEach(() => {
        // Reset console mocks avant chaque test
        console.clear();
    });

    it('should have correct tool definition', () => {
        expect(minimalTestTool.name).toBe('minimal_test_tool');
        expect(minimalTestTool.description).toBe('Test minimal pour vérifier si le MCP recharge correctement.');
        expect(minimalTestTool.inputSchema.type).toBe('object');
        expect(minimalTestTool.inputSchema).toHaveProperty('required');
        expect(minimalTestTool.inputSchema.properties.test_message.type).toBe('string');
    });

    it('should return default message when no custom message provided', async () => {
        const result = await handleMinimalTest({});
        
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('✅ MCP roo-state-manager opérationnel - Test minimal réussi');
        expect(result.content[0].text).toContain('**Timestamp:**');
    });

    it('should return custom message when provided', async () => {
        const customMessage = 'Message de test personnalisé';
        const result = await handleMinimalTest({ test_message: customMessage });
        
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain(customMessage);
        expect(result.content[0].text).toContain('**Timestamp:**');
    });

    it('should include proper markdown formatting', async () => {
        const result = await handleMinimalTest({ test_message: 'Test message' });
        
        expect(result.content[0].text).toContain('# Test Minimal MCP');
        expect(result.content[0].text).toContain('**Message:**');
        expect(result.content[0].text).toContain('**Statut:** Succès');
        expect(result.content[0].text).toContain('## Détails');
        expect(result.content[0].text).toContain('## Utilisation');
    });

    it('should log execution to console', async () => {
        const consoleSpy = vi.spyOn(console, 'log');
        
        await handleMinimalTest({ test_message: 'Test logging' });
        
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('[minimal-test-tool] 🧪 Exécution du test minimal: Test logging')
        );
        
        consoleSpy.mockRestore();
    });
});