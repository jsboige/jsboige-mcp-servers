import { z } from 'zod';
import { UnifiedToolContract, ToolCategory, ProcessingLevel, ToolResult } from '../../interfaces/UnifiedToolInterface.js';
import { InventoryService } from '../../services/roosync/InventoryService.js';

const inputSchema = z.object({
  machineId: z.string().optional().describe('Identifiant optionnel de la machine (défaut: hostname)')
});

export const getMachineInventoryTool: UnifiedToolContract = {
  name: 'roosync_get_machine_inventory',
  description: 'Collecte l\'inventaire complet de configuration de la machine courante pour RooSync.',
  category: ToolCategory.UTILITY,
  processingLevel: ProcessingLevel.IMMEDIATE,
  version: '1.0.0',
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>): Promise<ToolResult<any>> => {
    const startTime = Date.now();
    try {
      const service = InventoryService.getInstance();
      const inventory = await service.getMachineInventory(input.machineId);
      
      return {
        success: true,
        data: inventory,
        metrics: {
          executionTime: Date.now() - startTime,
          processingLevel: ProcessingLevel.IMMEDIATE
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'INVENTORY_COLLECTION_FAILED',
          message: error.message
        },
        metrics: {
          executionTime: Date.now() - startTime,
          processingLevel: ProcessingLevel.IMMEDIATE
        }
      };
    }
  }
};