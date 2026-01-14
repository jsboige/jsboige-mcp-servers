import { describe, it, expect, beforeEach, vi } from 'vitest';
import { minimal_test_tool } from '../../../src/tools/test/minimal-test.tool';

describe('minimal_test_tool', () => {
    beforeEach(() => {
        // Nettoyer les mocks avant chaque test
        vi.clearAllMocks();
    });

    it('devrait retourner un message de test avec timestamp', async () => {
        const args = {
            message: 'Message de test unitaire'
        };

        const result = await minimal_test_tool.handler(args);

        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content).toHaveLength(1);

        const content = result.content[0];
        expect(content.type).toBe('text');
        expect(typeof content.text).toBe('string');
        expect(content.text).toContain('Message de test unitaire');
        expect(content.text).toContain(new Date().getFullYear().toString());
    });

    it('devrait gérer un message vide', async () => {
        const args = {
            message: ''
        };

        const result = await minimal_test_tool.handler(args);

        expect(result.content[0].text).toContain('Message:');
    });

    it('devrait contenir les informations de base', async () => {
        const args = {
            message: 'Test validation'
        };

        const result = await minimal_test_tool.handler(args);

        expect(result.content[0].text).toContain('# Test Minimal MCP');
        expect(result.content[0].text).toContain('**Status:** Succès');
        expect(result.content[0].text).toContain('**Timestamp:**');
    });
});
