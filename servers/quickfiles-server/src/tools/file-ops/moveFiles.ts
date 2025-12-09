import { MoveFilesArgsSchema } from '../../validation/schemas.js';
import { FileCopyOperation, FileCopyResult } from '../../core/types.js';
import { CopyFilesTool } from './copyFiles.js';

/**
 * Outil pour déplacer des fichiers (réutilise la logique de copie)
 */
export class MoveFilesTool {
  private copyTool: CopyFilesTool;

  constructor(copyTool: CopyFilesTool) {
    this.copyTool = copyTool;
  }

  async handle(request: any): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      // Extraire et valider les arguments
      const args = request.params?.arguments || request;
      
      // Validation Zod explicite
      const validatedArgs = MoveFilesArgsSchema.parse(args);
      
      const { operations } = validatedArgs;
      
        const results = await Promise.all(operations.map(op => this.copyTool.processFileCopyOperation(op, 'move')));
        const report = this.copyTool.formatFileCopyResponse(results, 'move');
        return { content: [{ type: 'text' as const, text: report }] };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: `Erreur lors du déplacement des fichiers: ${(error as Error).message}` }], isError: true };
    }
  }
}