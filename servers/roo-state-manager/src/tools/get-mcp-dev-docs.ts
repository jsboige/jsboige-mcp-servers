import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const getMcpDevDocs = {
    name: 'get_mcp_dev_docs',
    description: 'Retrieves the contents of MCP development and debugging documentation files.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: [],
    },
    async handler(): Promise<CallToolResult> {
        try {
            const docsBasePath = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'docs');
            const debugGuidePath = path.join(docsBasePath, 'guides', 'guide-utilisation-mcps.md');
            // const troubleshootingPath = path.join(docsBasePath, 'troubleshooting', 'mcp-startup-issues.md');

            const debugGuideContent = await fs.readFile(debugGuidePath, 'utf-8');
            const troubleshootingContent = "Le guide de dépannage est actuellement indisponible.";

            const combinedContent = `
# MCP Debugging Guide
---
${debugGuideContent}

# MCP Startup Issues Troubleshooting
---
${troubleshootingContent}
            `;

            return { content: [{ type: 'text' as const, text: combinedContent }] };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text' as const, text: `Error retrieving MCP dev docs: ${errorMessage}` }] };
        }
    },
};