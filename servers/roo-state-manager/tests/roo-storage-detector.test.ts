/**
 * Tests unitaires pour le détecteur de stockage Roo
 * Focus SDDD Phase 2: Validation de l'alignement des préfixes via computeInstructionPrefix(K=192)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import { RooStorageDetector } from '../src/utils/roo-storage-detector.js';
import { computeInstructionPrefix } from '../src/utils/task-instruction-index.js';

// Mock des dépendances externes
jest.mock('fs/promises');
jest.mock('../src/utils/cache-manager.js', () => ({
    globalCacheManager: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined)
    }
}));

jest.mock('../src/utils/task-instruction-index.js', () => ({
    globalTaskInstructionIndex: {
        addInstruction: jest.fn(),
        rebuildFromSkeletons: jest.fn(),
        getStats: jest.fn().mockReturnValue({
            totalInstructions: 0,
            totalNodes: 0,
            avgDepth: 0
        })
    },
    computeInstructionPrefix: jest.fn().mockImplementation((raw: string, K: number = 192) => {
        if (!raw) return '';
        return raw.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, K);
    })
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedComputeInstructionPrefix = computeInstructionPrefix as jest.MockedFunction<typeof computeInstructionPrefix>;

describe('RooStorageDetector — Exact Prefix normalization (K=192)', () => {
    let tempDir: string;
    let taskPath: string;

    beforeEach(() => {
        jest.clearAllMocks();
        tempDir = path.join(os.tmpdir(), 'roo-storage-test');
        taskPath = path.join(tempDir, 'test-task-id');
        
        // Rétablir l'implémentation réelle de computeInstructionPrefix pour les tests
        mockedComputeInstructionPrefix.mockImplementation((raw: string, K: number = 192) => {
            if (!raw) return '';
            return raw.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, K);
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('childTaskInstructionPrefixes produit des préfixes normalisés via computeInstructionPrefix', async () => {
        // ARRANGE: Préparer les données de test
        const childRawMessage = "**MISSION CRITIQUE**: Analyser et déboguer le système hiérarchique pour résoudre les problèmes de reconstruction des tâches parentes";
        const parentTaskId = 'parent-task-123';
        
        // Simuler le contenu d'un fichier ui_messages.json avec instruction <new_task>
        const uiMessagesContent = JSON.stringify([
            {
                role: 'assistant',
                content: `<new_task><mode>debug</mode><message>${childRawMessage}</message></new_task>`,
                timestamp: Date.now()
            }
        ]);

        const taskMetadata = {
            title: 'Test Parent Task',
            workspace: '/test/workspace',
            mode: 'orchestrator'
        };

        // Mock du système de fichiers
        mockedFs.stat.mockImplementation((filePath: any) => {
            const pathStr = filePath.toString();
            if (pathStr.includes('task_metadata.json')) {
                return Promise.resolve({ size: 100, mtime: new Date(), birthtime: new Date() } as any);
            }
            if (pathStr.includes('ui_messages.json')) {
                return Promise.resolve({ size: 500, mtime: new Date()