import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';

vi.unmock('../../../src/utils/hierarchy-pipeline.js');
import { HierarchyPipeline } from '../../../src/utils/hierarchy-pipeline';

function createMockCoordinator(extractResult: any = { instructions: [], processedMessages: 0, matchedPatterns: [], errors: [] }) {
  return {
    extractFromMessages: vi.fn().mockReturnValue(extractResult),
    // Include any other methods the real class might have
    initializeExtractors: vi.fn()
  } as any;
}

describe('HierarchyPipeline', () => {
  const testDir = join(process.cwd(), 'test-temp-hierarchy');

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try { await fs.rm(testDir, { recursive: true, force: true }); } catch {}
  });

  // --- extractNewTaskInstructionsFromUI ---

  describe('extractNewTaskInstructionsFromUI', () => {
    it('should return empty array for non-existent file', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);
      const result = await pipeline.extractNewTaskInstructionsFromUI(join(testDir, 'no-file.json'));
      expect(result).toEqual([]);
    });

    it('should return empty array for directory path (not a file)', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);
      const result = await pipeline.extractNewTaskInstructionsFromUI(testDir);
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array JSON content', async () => {
      const filePath = join(testDir, 'not-array.json');
      await fs.writeFile(filePath, JSON.stringify({ key: 'value' }));

      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);
      const result = await pipeline.extractNewTaskInstructionsFromUI(filePath);

      expect(result).toEqual([]);
    });

    it('should return empty array for invalid JSON', async () => {
      const filePath = join(testDir, 'invalid.json');
      await fs.writeFile(filePath, '{bad json}');

      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);
      const result = await pipeline.extractNewTaskInstructionsFromUI(filePath);

      expect(result).toEqual([]);
    });

    it('should extract instructions using coordinator', async () => {
      const instructions = [
        { mode: 'code-simple', message: 'Fix bug', sourceIndex: 0 }
      ];
      const coordinator = createMockCoordinator({
        instructions,
        processedMessages: 2,
        matchedPatterns: ['new_task'],
        errors: []
      });
      const pipeline = new HierarchyPipeline(coordinator);

      const messages = [
        { type: 'ask', text: '<new_task><message>Fix bug</message></new_task>' }
      ];
      const filePath = join(testDir, 'ui_messages.json');
      await fs.writeFile(filePath, JSON.stringify(messages));

      const result = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      expect(result).toEqual(instructions);
      expect(coordinator.extractFromMessages).toHaveBeenCalledWith(messages, {
        patterns: ['new_task'],
        minLength: 20,
        maxLength: 500
      });
    });

    it('should return empty array when coordinator returns no instructions', async () => {
      const coordinator = createMockCoordinator({
        instructions: [],
        processedMessages: 0,
        matchedPatterns: [],
        errors: []
      });
      const pipeline = new HierarchyPipeline(coordinator);

      const filePath = join(testDir, 'ui_messages.json');
      await fs.writeFile(filePath, JSON.stringify([]));

      const result = await pipeline.extractNewTaskInstructionsFromUI(filePath);
      expect(result).toEqual([]);
    });
  });

  // --- analyzeTaskHierarchy ---

  describe('analyzeTaskHierarchy', () => {
    it('should return null parentTask for non-existent file', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);

      const result = await pipeline.analyzeTaskHierarchy(join(testDir, 'no-file.json'));
      expect(result.parentTask).toBeNull();
      expect(result.subTasks).toEqual([]);
      expect(result.hierarchy).toBe('error');
    });

    it('should parse parent task and find sub-tasks with <task> tags', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);

      // Create parent task
      const parentContent = {
        content: '<task>Parent task title</task> with details'
      };
      await fs.writeFile(join(testDir, 'parent.json'), JSON.stringify(parentContent));

      // readDirectory stub returns 'ui_messages.json' and 'task_metadata.json'
      // Create those files in testDir with task tags
      const subContent = {
        content: '<task>Sub task one</task> details'
      };
      await fs.writeFile(join(testDir, 'ui_messages.json'), JSON.stringify(subContent));

      const result = await pipeline.analyzeTaskHierarchy(join(testDir, 'parent.json'));
      expect(result.parentTask).toEqual(parentContent);
      expect(result.subTasks).toHaveLength(1);
      expect(result.hierarchy).toContain('Parent task title');
    });

    it('should skip sub-task files without <task> tags', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);

      const parentContent = { content: '<task>Main task</task>' };
      await fs.writeFile(join(testDir, 'parent.json'), JSON.stringify(parentContent));

      // Sub-file without task tags
      const noTaskContent = { content: 'No task tags here' };
      await fs.writeFile(join(testDir, 'ui_messages.json'), JSON.stringify(noTaskContent));

      const result = await pipeline.analyzeTaskHierarchy(join(testDir, 'parent.json'));
      expect(result.subTasks).toHaveLength(0);
    });

    it('should handle parent task with array content', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);

      const parentContent = {
        content: [
          { type: 'text', text: '<task>Array parent task</task>' }
        ]
      };
      await fs.writeFile(join(testDir, 'parent.json'), JSON.stringify(parentContent));

      const subContent = {
        content: [
          { type: 'text', text: '<task>Array sub task</task>' }
        ]
      };
      await fs.writeFile(join(testDir, 'ui_messages.json'), JSON.stringify(subContent));

      const result = await pipeline.analyzeTaskHierarchy(join(testDir, 'parent.json'));
      expect(result.subTasks).toHaveLength(1);
    });

    it('should handle parent task with no content', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);

      const parentContent = { noContent: true };
      await fs.writeFile(join(testDir, 'parent.json'), JSON.stringify(parentContent));

      const result = await pipeline.analyzeTaskHierarchy(join(testDir, 'parent.json'));
      expect(result.parentTask).toEqual(parentContent);
      expect(result.hierarchy).toContain('Tâche sans titre');
    });

    it('should handle invalid JSON sub-task files gracefully', async () => {
      const coordinator = createMockCoordinator();
      const pipeline = new HierarchyPipeline(coordinator);

      const parentContent = { content: '<task>Parent</task>' };
      await fs.writeFile(join(testDir, 'parent.json'), JSON.stringify(parentContent));
      await fs.writeFile(join(testDir, 'ui_messages.json'), '{invalid json}');

      // Should not throw, sub-task just skipped
      const result = await pipeline.analyzeTaskHierarchy(join(testDir, 'parent.json'));
      expect(result.subTasks).toHaveLength(0);
    });
  });
});
