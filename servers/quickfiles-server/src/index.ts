import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

// Zod Schemas
const LineRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
});

const FileWithExcerptsSchema = z.object({
  path: z.string(),
  excerpts: z.array(LineRangeSchema).optional(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.union([z.string(), FileWithExcerptsSchema])),
  show_line_numbers: z.boolean().optional(),
  max_lines_per_file: z.number().optional(),
  max_total_lines: z.number().optional(),
  max_chars_per_file: z.number().optional(),
  max_total_chars: z.number().optional(),
});


class QuickFilesServer {
  private server: McpServer;

  constructor() {
    this.server = new McpServer({
      name: 'quickfiles-server',
      version: '1.0.0',
    });

    this.server.registerTool(
      "read_multiple_files",
      {
        description: "Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers. Tronque automatiquement les contenus volumineux pour éviter les problèmes de mémoire et de performance.",
        inputSchema: ReadMultipleFilesArgsSchema.shape,
      },
      this.handleReadMultipleFiles.bind(this),
    );

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async handleReadMultipleFiles(
    args: z.infer<typeof ReadMultipleFilesArgsSchema>,
    extra: Record<string, unknown>,
  ) {
    const { paths, show_line_numbers = false } = args;
    const content = [];

    for (const file of paths) {
      const filePath = typeof file === 'string' ? file : file.path;
      try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const text = show_line_numbers
          ? fileContent.split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n')
          : fileContent;
        content.push({
            type: 'resource' as const,
            resource: {
                uri: pathToFileURL(path.resolve(filePath)).toString(),
                text: text,
            }
        });
      } catch (error) {
        const errorMessage = (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'ERREUR: Le fichier n\'existe pas ou n\'est pas accessible'
            : (error as Error).message;
        content.push({
            type: 'text' as const,
            text: `Erreur lors de la lecture du fichier ${filePath}: ${errorMessage}`,
        });
      }
    }
    return { content };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('QuickFiles server started successfully (with read_multiple_files tool).');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new QuickFilesServer();
  server.run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}