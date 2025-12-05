/**
 * Outil MCP : minimal_test_tool
 * Test minimal pour vérifier si le MCP recharge correctement
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface MinimalTestArgs {
    /** Message de test personnalisé (optionnel) */
    test_message?: string;
}

/**
 * Définition de l'outil minimal_test_tool
 */
export const minimalTestTool = {
    name: 'minimal_test_tool',
    description: 'Test minimal pour vérifier si le MCP recharge correctement.',
    inputSchema: {
        type: 'object',
        properties: {
            test_message: {
                type: 'string',
                description: 'Message de test personnalisé à retourner.'
            }
        },
        required: [] as string[]
    };
};

/**
 * Handler pour minimal_test_tool
 * Retourne un message de test simple
 */
export async function handleMinimalTest(
    args: MinimalTestArgs
): Promise<CallToolResult> {
    const { test_message } = args;

    // Message de test par défaut
    const defaultMessage = '✅ MCP roo-state-manager opérationnel - Test minimal réussi';
    
    // Message personnalisé ou par défaut
    const message = test_message || defaultMessage;

    console.log(`[minimal-test-tool] 🧪 Exécution du test minimal: ${message}`);

    return {
        content: [{
            type: 'text',
            text: `# Test Minimal MCP\n\n**Message:** ${message}\n\n**Timestamp:** ${new Date().toISOString()}\n\n**Statut:** Succès\n\n---\n\n## Détails\n\nCet outil vérifie que le MCP roo-state-manager fonctionne correctement.\n\n## Utilisation\n\n\`\`\`json\n{\n  "tool": "minimal_test_tool",\n  "test_message": "Message personnalisé ici"\n}\n\`\`\`\n\n**Résultat attendu:** Message de test retourné avec timestamp\n\n`
        }]
    };
}