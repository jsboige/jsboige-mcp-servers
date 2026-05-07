/**
 * Tests unitaires pour debug-parsing.tool.ts
 * Vérifie l'analyse détaillée du parsing des tâches Roo
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleDebugTaskParsing, DebugTaskParsingArgs } from '../debug-parsing.tool.js';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';

// Mock des modules
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn()
  },
  existsSync: vi.fn()
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    detectStorageLocations: vi.fn(),
    analyzeConversation: vi.fn()
  }
}));

describe('debug-parsing.tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleDebugTaskParsing', () => {
    it('should return error when task not found', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1',
        '/path/to/storage2'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;

      vi.mocked(existsSync).mockReturnValue(false);

      const args: DebugTaskParsingArgs = { task_id: '00000000-0000-4000-a000-000000000000' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Task 00000000-0000-4000-a000-000000000000 not found');
    });

    it('should return JSON error when task not found and format=json', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;

      vi.mocked(existsSync).mockReturnValue(false);

      const args: DebugTaskParsingArgs = { task_id: '00000000-0000-4000-a000-000000000000', format: 'json' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('not_found');
      expect(parsed.task_id).toBe('00000000-0000-4000-a000-000000000000');
    });

    it('should detect task path and analyze files', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue({
        taskId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
        parentTaskId: 'b2c3d4e5-f6a7-4b8c-9d0e-2f3a4b5c6d7e',
        truncatedInstruction: 'Test instruction here',
        childTaskInstructionPrefixes: ['Prefix 1', 'Prefix 2']
      });

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d') || path.includes('ui_messages.json');
        }
        return false;
      });

      const mockMessages = [
        {
          role: 'user',
          content: 'User message with <task>Test task content</task>'
        },
        {
          role: 'assistant',
          content: 'Response with <new_task>New task here</new_task>'
        }
      ];

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier les informations de base
      expect(text).toContain('Task path:');
      expect(text).toContain('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');

      // Vérifier la détection des fichiers
      expect(text).toContain('UI Messages: EXISTS');

      // Vérifier le comptage des messages
      expect(text).toContain('UI Messages count: 2');

      // Vérifier la détection des tags
      expect(text).toContain('Total <task> tags: 1');
      expect(text).toContain('Total <new_task> tags: 1');

      // Vérifier l'analyse RooStorageDetector
      expect(text).toContain('Skeleton analysis:');
      expect(text).toContain('TaskId: a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
      expect(text).toContain('ParentTaskId: b2c3d4e5-f6a7-4b8c-9d0e-2f3a4b5c6d7e');
    });

    it('should return JSON format when format=json', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue({
        taskId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
        parentTaskId: null,
        truncatedInstruction: 'Test instruction',
        childTaskInstructionPrefixes: ['Prefix 1']
      });

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d') || path.includes('ui_messages.json');
        }
        return false;
      });

      const mockMessages = [{ role: 'user', content: 'Test' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d', format: 'json' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.task_id).toBe('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
      expect(parsed.skeleton.task_id).toBe('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
      expect(parsed.skeleton.parent_task_id).toBeNull();
      expect(parsed.ui_messages_count).toBe(1);
    });

    it('should handle BOM in UTF-8 files', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue(null);

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d') || path.includes('ui_messages.json');
        }
        return false;
      });

      // Simuler un fichier avec BOM UTF-8 (0xFEFF)
      const mockMessages = [{ role: 'user', content: 'Test message' }];
      const jsonWithBom = '﻿' + JSON.stringify(mockMessages);
      vi.mocked(fs.readFile).mockResolvedValue(jsonWithBom);

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que le fichier a été lu et parsé malgré le BOM
      expect(text).toContain('UI Messages count: 1');
    });

    it('should handle array content in messages', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue(null);

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d') || path.includes('ui_messages.json');
        }
        return false;
      });

      const mockMessages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part with <task>Content</task>' },
            { type: 'text', text: 'Second part with <new_task>More</new_task>' }
          ]
        }
      ];

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que les tags sont détectés dans le contenu array
      expect(text).toContain('Total <task> tags: 1');
      expect(text).toContain('Total <new_task> tags: 1');
    });

    it('should handle missing UI messages file', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue(null);

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          // Task exists, but ui_messages.json doesn't
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d') && !path.includes('ui_messages.json');
        }
        return false;
      });

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      expect(text).toContain('UI Messages: MISSING');
      expect(text).toContain('Skeleton analysis: FAILED (null)');
    });

    it('should handle RooStorageDetector.analyzeConversation returning null', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue(null);

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
        }
        return false;
      });

      const mockMessages = [{ role: 'user', content: 'Test message' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      expect(text).toContain('Skeleton analysis: FAILED (null)');
    });

    it('should handle errors gracefully', async () => {
      const mockDetectStorageLocations = vi.fn().mockRejectedValue(new Error('Storage detection failed'));

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      expect(text).toContain('ERROR: Storage detection failed');
    });

    it('should handle errors gracefully in JSON format', async () => {
      const mockDetectStorageLocations = vi.fn().mockRejectedValue(new Error('Storage detection failed'));

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d', format: 'json' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('Storage detection failed');
      expect(parsed.task_id).toBe('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
    });

    it('should extract task content preview correctly', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue(null);

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d') || path.includes('ui_messages.json');
        }
        return false;
      });

      const taskContent = 'This is a detailed task instruction that should be extracted and previewed in the debug output';
      const mockMessages = [
        {
          role: 'user',
          content: `Message with <task>${taskContent}</task> tag`
        }
      ];

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que le preview du contenu est présent
      expect(text).toContain('Preview:');
      expect(text).toContain(taskContent.substring(0, 50));
    });

    it('should display child task instruction prefixes when available', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue({
        taskId: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d',
        parentTaskId: null,
        truncatedInstruction: 'Parent instruction',
        childTaskInstructionPrefixes: [
          'Child task 1 instruction that is quite long and should be truncated',
          'Child task 2 instruction that is also long',
          'Child task 3 instruction preview',
          'Child task 4 instruction that won\'t be shown' // 4th one shouldn't appear (limited to 3)
        ]
      });

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d');
        }
        return false;
      });

      const mockMessages = [{ role: 'user', content: 'Test message' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que les prefixes sont affichés
      expect(text).toContain('Child prefixes: 4');
      expect(text).toContain('Child task 1');
      expect(text).toContain('Child task 2');
      expect(text).toContain('Child task 3');

      // Le 4ème ne devrait pas apparaître (limité à 3)
      expect(text).not.toContain('Child task 4');
    });
  });
});
