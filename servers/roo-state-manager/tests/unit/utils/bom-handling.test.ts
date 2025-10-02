import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import mock from 'mock-fs';
import { RooStateManagerServer } from '../../../src/index.js';
import path from 'path';
import fs from 'fs/promises';

// Mock RooStorageDetector pour contrôler les chemins de stockage
jest.mock('../../../src/utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: jest.fn(),
    },
}));
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';

describe('BOM Handling Tools', () => {
    let server: RooStateManagerServer;
    const MOCK_STORAGE_PATH = '/mock/storage';
    const MOCK_TASKS_PATH = path.join(MOCK_STORAGE_PATH, 'tasks');
    const CORRUPTED_FILE_PATH = path.join(MOCK_TASKS_PATH, 'task-bom', 'api_conversation_history.json');
    const CLEAN_FILE_PATH = path.join(MOCK_TASKS_PATH, 'task-clean', 'api_conversation_history.json');

    beforeEach(async () => {
        server = new RooStateManagerServer();
        (RooStorageDetector.detectStorageLocations as jest.Mock<() => Promise<string[]>>).mockResolvedValue([MOCK_TASKS_PATH]);

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
        jest.clearAllMocks();
    });

    it('diagnose_conversation_bom should detect file with BOM', async () => {
        // @ts-ignore
        const result = await server['handleDiagnoseConversationBom']({ fix_found: false });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        expect(textContent).toContain('Fichiers corrompus (BOM): 1');
        expect(textContent).toContain(CORRUPTED_FILE_PATH);
    });

    it('repair_conversation_bom should fix file with BOM', async () => {
        // @ts-ignore
        await server['handleRepairConversationBom']({ dry_run: false });
        
        const repairedContent = await fs.readFile(CORRUPTED_FILE_PATH, 'utf-8');
        expect(repairedContent.charCodeAt(0)).not.toBe(0xFEFF);
        expect(JSON.parse(repairedContent).message).toBe('test');
    });

    it('repair_conversation_bom should not modify clean files', async () => {
        const originalContent = await fs.readFile(CLEAN_FILE_PATH, 'utf-8');
        // @ts-ignore
        await server['handleRepairConversationBom']({ dry_run: false });
        const newContent = await fs.readFile(CLEAN_FILE_PATH, 'utf-8');
        expect(newContent).toEqual(originalContent);
    });
});