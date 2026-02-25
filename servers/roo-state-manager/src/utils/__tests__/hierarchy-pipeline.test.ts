/**
 * Tests unitaires pour HierarchyPipeline
 *
 * Couvre :
 * - extractNewTaskInstructionsFromUI : happy path, stat not file, JSON invalide, non-array, erreur stat
 * - analyzeTaskHierarchy : parent task valide, sous-tâches avec task tags, erreur lecture
 * - hasTaskTags (via analyzeTaskHierarchy)
 * - buildHierarchyRepresentation + extractTaskTitle (via analyzeTaskHierarchy)
 *
 * Framework: Vitest
 * Coverage cible: >70%
 *
 * @module utils/__tests__/hierarchy-pipeline.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock fs/promises
const mockStat = vi.fn();
const mockReadFile = vi.fn();

vi.mock('fs/promises', () => ({
  stat: (...args: any[]) => mockStat(...args),
  readFile: (...args: any[]) => mockReadFile(...args)
}));

// Mock MessageExtractionCoordinator
const mockExtractFromMessages = vi.fn();

vi.mock('../message-extraction-coordinator.js', () => ({
  MessageExtractionCoordinator: vi.fn().mockImplementation(() => ({
    extractFromMessages: mockExtractFromMessages
  }))
}));

import { HierarchyPipeline } from '../hierarchy-pipeline.js';
import { MessageExtractionCoordinator } from '../message-extraction-coordinator.js';

describe('HierarchyPipeline', () => {
  let pipeline: HierarchyPipeline;
  let mockCoordinator: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCoordinator = {
      extractFromMessages: mockExtractFromMessages
    };
    pipeline = new HierarchyPipeline(mockCoordinator as MessageExtractionCoordinator);
  });

  // ============================================================
  // extractNewTaskInstructionsFromUI
  // ============================================================

  describe('extractNewTaskInstructionsFromUI', () => {
    test('retourne les instructions extraites pour un fichier valide', async () => {
      const messages = [{ type: 'assistant', content: 'test' }];
      const mockInstruction = { task: 'do something', type: 'new_task' };

      mockStat.mockResolvedValue({ isFile: () => true });
      mockReadFile.mockResolvedValue(JSON.stringify(messages));
      mockExtractFromMessages.mockResolvedValue({ instructions: [mockInstruction] });

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/ui_messages.json');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockInstruction);
      expect(mockExtractFromMessages).toHaveBeenCalledWith(messages, {
        patterns: ['new_task'],
        minLength: 20,
        maxLength: 500
      });
    });

    test('retourne [] si le fichier n\'est pas un fichier (stat.isFile() = false)', async () => {
      mockStat.mockResolvedValue({ isFile: () => false });

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/dir');

      expect(result).toEqual([]);
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    test('retourne [] si le JSON est invalide', async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockReadFile.mockResolvedValue('not-valid-json{{{');

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/file.json');

      expect(result).toEqual([]);
    });

    test('retourne [] si le contenu n\'est pas un tableau', async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockReadFile.mockResolvedValue(JSON.stringify({ type: 'object' }));

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/file.json');

      expect(result).toEqual([]);
    });

    test('retourne [] si stat échoue', async () => {
      mockStat.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/missing.json');

      expect(result).toEqual([]);
    });

    test('retourne [] si extractFromMessages retourne null', async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockReadFile.mockResolvedValue(JSON.stringify([{ type: 'user' }]));
      mockExtractFromMessages.mockResolvedValue({ instructions: null });

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/file.json');

      expect(result).toEqual([]);
    });

    test('retourne [] si extractFromMessages retourne tableau vide', async () => {
      mockStat.mockResolvedValue({ isFile: () => true });
      mockReadFile.mockResolvedValue(JSON.stringify([{ type: 'user' }]));
      mockExtractFromMessages.mockResolvedValue({ instructions: [] });

      const result = await pipeline.extractNewTaskInstructionsFromUI('/path/to/file.json');

      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // analyzeTaskHierarchy
  // ============================================================

  describe('analyzeTaskHierarchy', () => {
    test('retourne la hiérarchie avec une tâche parent sans sous-tâches', async () => {
      const parentTask = { content: '<task>Do something important</task>' };

      // readFile for parent task
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      // stat for ui_messages.json and task_metadata.json (from readDirectory which returns those)
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      // readFile for ui_messages.json (no task tags)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags here' }));
      // readFile for task_metadata.json (no task tags)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags here' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent_task.json');

      expect(result.parentTask).toEqual(parentTask);
      expect(result.subTasks).toHaveLength(0);
      expect(result.hierarchy).toContain('Tâche Parent');
    });

    test('trouve des sous-tâches avec balises <task> (content string)', async () => {
      const parentTask = { content: '<task>Parent task</task>' };
      const subTask = { content: '<task>Sub task content</task>' };

      // readFile for parent
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      // stat for files in readDirectory
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      // readFile for ui_messages.json (has task tags)
      mockReadFile.mockResolvedValueOnce(JSON.stringify(subTask));
      // readFile for task_metadata.json (no task tags)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent_task.json');

      expect(result.parentTask).toEqual(parentTask);
      expect(result.subTasks).toHaveLength(1);
      expect(result.hierarchy).toContain('Sous-tâches');
    });

    test('trouve des sous-tâches avec balises <task> (content array)', async () => {
      const parentTask = { content: '<task>Parent task</task>' };
      const subTask = {
        content: [
          { type: 'text', text: 'Some intro <task>Array sub task</task> text' }
        ]
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      mockReadFile.mockResolvedValueOnce(JSON.stringify(subTask));
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent_task.json');

      expect(result.subTasks).toHaveLength(1);
    });

    test('retourne erreur hierarchy si readFile parent échoue', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/missing.json');

      expect(result.parentTask).toBeNull();
      expect(result.subTasks).toHaveLength(0);
      expect(result.hierarchy).toBe('error');
    });

    test('construit la représentation avec titre extrait du content string', async () => {
      const parentTask = { content: '<task>My Important Task Title</task>' };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent.json');

      expect(result.hierarchy).toContain('My Important Task Title');
    });

    test('titre par défaut si content est null', async () => {
      const parentTask = { content: null };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent.json');

      expect(result.hierarchy).toContain('Tâche sans titre');
    });

    test('titre par défaut si content array sans balises <task>', async () => {
      const parentTask = {
        content: [
          { type: 'text', text: 'No task tags here' }
        ]
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent.json');

      expect(result.hierarchy).toContain('Tâche sans titre');
    });

    test('hasTaskTags retourne false pour contenu sans balises', async () => {
      const parentTask = { content: 'regular content' };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(parentTask));
      mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
      // Sub tasks: no tags
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ content: 'no tags' }));

      const result = await pipeline.analyzeTaskHierarchy('/tasks/parent.json');

      expect(result.subTasks).toHaveLength(0);
    });
  });
});
