import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mock from 'mock-fs';
import path from 'path';
import fs from 'fs/promises';

// Désactiver le mock global de fs pour permettre à mock-fs de fonctionner correctement
vi.unmock('fs');
vi.unmock('fs/promises');
import { diagnoseConversationBomTool } from '../../../src/tools/repair/diagnose-conversation-bom.tool.js';
import { repairConversationBomTool } from '../../../src/tools/repair/repair-conversation-bom.tool.js';

// Mock RooStorageDetector pour contrôler les chemins de stockage
vi.mock('../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
    },
}));
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';

describe('BOM Handling Tools', () => {
    const MOCK_STORAGE_PATH = '/mock/storage';
    const MOCK_TASKS_PATH = path.join(MOCK_STORAGE_PATH, 'tasks');
    const CORRUPTED_FILE_PATH = path.join(MOCK_TASKS_PATH, 'task-bom', 'api_conversation_history.json');
    const CLEAN_FILE_PATH = path.join(MOCK_TASKS_PATH, 'task-clean', 'api_conversation_history.json');

    beforeEach(async () => {
        // Le mock doit retourner le chemin de base, car l'outil ajoute /tasks lui-même
        (RooStorageDetector.detectStorageLocations as any).mockResolvedValue([MOCK_STORAGE_PATH]);

        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const jsonData = Buffer.from(JSON.stringify({ message: 'test' }));
        const corruptedContent = Buffer.concat([bom, jsonData]);

        mock({
            [CORRUPTED_FILE_PATH]: corruptedContent,
            [CLEAN_FILE_PATH]: JSON.stringify({ message: 'clean' }),
        });
    });

    afterEach(() => {
        mock.restore();
        vi.clearAllMocks();
    });

    it('diagnose_conversation_bom should detect file with BOM', async () => {
        const result = await diagnoseConversationBomTool.handler({ fix_found: false });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        expect(textContent).toContain('**Fichiers corrompus (BOM):** 1');
        expect(textContent).toContain(CORRUPTED_FILE_PATH);
    });

    it('repair_conversation_bom should fix file with BOM', async () => {
        await repairConversationBomTool.handler({ dry_run: false });

        const repairedContent = await fs.readFile(CORRUPTED_FILE_PATH, 'utf-8');
        const contentStr = Buffer.isBuffer(repairedContent) ? repairedContent.toString('utf-8') : repairedContent;
        expect(contentStr.charCodeAt(0)).not.toBe(0xFEFF);
        expect(JSON.parse(contentStr).message).toBe('test');
    });

    it('repair_conversation_bom should not modify clean files', async () => {
        const originalContent = await fs.readFile(CLEAN_FILE_PATH, 'utf-8');
        await repairConversationBomTool.handler({ dry_run: false });
        const newContent = await fs.readFile(CLEAN_FILE_PATH, 'utf-8');
        expect(newContent).toEqual(originalContent);
    });
});