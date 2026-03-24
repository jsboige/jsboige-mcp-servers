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

      const args: DebugTaskParsingArgs = { task_id: 'nonexistent-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Task nonexistent-task-id not found');
    });

    it('should detect task path and analyze files', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue({
        taskId: 'test-task-id',
        parentTaskId: 'parent-task-id',
        truncatedInstruction: 'Test instruction here',
        childTaskInstructionPrefixes: ['Prefix 1', 'Prefix 2']
      });

      const existsSyncMock = vi.mocked(existsSync);
      existsSyncMock.mockImplementation((path: any) => {
        if (typeof path === 'string') {
          return path.includes('test-task-id') || path.includes('ui_messages.json');
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

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier les informations de base
      expect(text).toContain('📁 Task path:');
      expect(text).toContain('test-task-id');

      // Vérifier la détection des fichiers
      expect(text).toContain('📄 UI Messages:');
      expect(text).toContain('✅ EXISTS');

      // Vérifier le comptage des messages
      expect(text).toContain('📊 UI Messages count: 2');

      // Vérifier la détection des tags
      expect(text).toContain('Total <task> tags found: 1');
      expect(text).toContain('Total <new_task> tags found: 1');

      // Vérifier l'analyse RooStorageDetector
      expect(text).toContain('🧪 TESTING RooStorageDetector.analyzeConversation');
      expect(text).toContain('✅ Analysis complete');
      expect(text).toContain('TaskId: test-task-id');
      expect(text).toContain('ParentTaskId: parent-task-id');
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
          return path.includes('test-task-id') || path.includes('ui_messages.json');
        }
        return false;
      });

      // Simuler un fichier avec BOM UTF-8 (0xFEFF)
      const mockMessages = [{ role: 'user', content: 'Test message' }];
      const jsonWithBom = '\uFEFF' + JSON.stringify(mockMessages);
      vi.mocked(fs.readFile).mockResolvedValue(jsonWithBom);

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que le fichier a été lu et parsé malgré le BOM
      expect(text).toContain('📊 UI Messages count: 1');
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
          return path.includes('test-task-id') || path.includes('ui_messages.json');
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

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que les tags sont détectés dans le contenu array
      expect(text).toContain('Total <task> tags found: 1');
      expect(text).toContain('Total <new_task> tags found: 1');
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
          return path.includes('test-task-id') && !path.includes('ui_messages.json');
        }
        return false;
      });

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      expect(text).toContain('📄 UI Messages: ❌ MISSING');
      expect(text).toContain('🧪 TESTING RooStorageDetector.analyzeConversation');
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
          return path.includes('test-task-id');
        }
        return false;
      });

      const mockMessages = [{ role: 'user', content: 'Test message' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      expect(text).toContain('❌ Analysis returned null');
    });

    it('should handle errors gracefully', async () => {
      const mockDetectStorageLocations = vi.fn().mockRejectedValue(new Error('Storage detection failed'));

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      expect(text).toContain('❌ ERROR: Storage detection failed');
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
          return path.includes('test-task-id') || path.includes('ui_messages.json');
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

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que le preview du contenu est présent
      expect(text).toContain('Content preview:');
      expect(text).toContain(taskContent.substring(0, 50)); // Au moins les 50 premiers caractères
    });

    it('should display child task instruction prefixes when available', async () => {
      const mockDetectStorageLocations = vi.fn().mockResolvedValue([
        '/path/to/storage1'
      ]);

      const { RooStorageDetector } = await import('../../../utils/roo-storage-detector.js');
      RooStorageDetector.detectStorageLocations = mockDetectStorageLocations;
      RooStorageDetector.analyzeConversation = vi.fn().mockResolvedValue({
        taskId: 'test-task-id',
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
          return path.includes('test-task-id');
        }
        return false;
      });

      const mockMessages = [{ role: 'user', content: 'Test message' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockMessages));

      const args: DebugTaskParsingArgs = { task_id: 'test-task-id' };
      const result = await handleDebugTaskParsing(args);

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;

      // Vérifier que les prefixes sont affichés
      expect(text).toContain('ChildTaskInstructionPrefixes: 4 prefixes');
      expect(text).toContain('Prefixes preview:');

      // Vérifier que les 3 premiers sont affichés
      expect(text).toContain('1. "Child task 1');
      expect(text).toContain('2. "Child task 2');
      expect(text).toContain('3. "Child task 3');

      // Le 4ème ne devrait pas apparaître (limité à 3)
      expect(text).not.toContain('4. "Child task 4');
    });
  });
});
