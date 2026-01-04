import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Tool } from '../../types/tool-definitions.js';
import { z } from 'zod';

/**
 * Schéma pour les paramètres d'entrée du tool minimal_test_tool
 */
export const MinimalTestToolSchema = z.object({
    message: z.string().describe('Message de test personnalisé')
});

/**
 * Type pour les paramètres du tool minimal_test_tool
 */
export type MinimalTestToolArgs = z.infer<typeof MinimalTestToolSchema>;

/**
 * Tool de test minimal pour vérifier le fonctionnement de base du MCP roo-state-manager
 */
export const minimal_test_tool: Tool = {
    definition: {
        name: 'minimal_test_tool',
        description: 'Tool de test minimal pour vérifier le fonctionnement de base',
        inputSchema: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'Message de test personnalisé'
                }
            },
            required: ['message']
        }
    },
    handler: handleMinimalTest
};

/**
 * Handler pour minimal_test_tool
 * Exécute un test minimal et retourne un message de succès
 */
async function handleMinimalTest(args: MinimalTestToolArgs): Promise<CallToolResult> {
    console.log(`[minimal-test-tool] 🧪 Exécution du test minimal: ${args.message}`);
    
    return {
        content: [{
            type: 'text',
            text: `# Test Minimal MCP\n\n**Message:** ${args.message}\n\n**Timestamp:** ${new Date().toISOString()}\n\n**Status:** Succès\n\n---\n\n## Détails\n\nCet outil vérifie que le MCP roo-state-manager fonctionne correctement.\n\n## Utilisation\n\n\`\`\`json\n{\n  "tool": "minimal_test_tool",\n  "test_message": "Message personnalisé ici"\n}\n\`\`\`\n**Résultat attendu:** Message de test retourné avec timestamp\n\n`
        }]
    };
}