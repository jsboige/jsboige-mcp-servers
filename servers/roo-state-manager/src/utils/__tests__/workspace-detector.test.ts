/**
 * Tests unitaires pour WorkspaceDetector
 *
 * Couvre :
 * - detect : orchestration dual (metadata -> environment_details -> none)
 * - detectFromMetadata : lecture task_metadata.json
 * - detectFromEnvironmentDetails : extraction patterns
 * - extractWorkspaceFromMessage : 3 patterns regex
 * - isValidWorkspacePath : validation format
 * - normalizePath : séparateurs, slash final
 * - validateWorkspaceExistence : boost/réduction confiance
 * - Cache : hit, miss, clear, stats
 * - Fonctions utilitaires : detectWorkspace, detectWorkspaceWithDetails
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs/promises BEFORE import
vi.mock('fs/promises', () => ({
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn().mockResolvedValue('{}'),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}));

import { WorkspaceDetector, type WorkspaceDetectionResult } from '../workspace-detector.js';
import * as fs from 'fs/promises';

describe('WorkspaceDetector', () => {
  let detector: WorkspaceDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup default mocks after clearAllMocks
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    detector = new WorkspaceDetector({ enableCache: false, validateExistence: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // === Constructor ===

  describe('constructor', () => {
    it('should create with default options', () => {
      const d = new WorkspaceDetector();
      expect(d).toBeDefined();
    });

    it('should accept custom options', () => {
      const d = new WorkspaceDetector({
        enableCache: false,
        validateExistence: true,
        normalizePaths: false,
      });
      expect(d).toBeDefined();
    });
  });

  // === detectFromMetadata ===

  describe('detectFromMetadata', () => {
    it('should return null when metadata file does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      const result = await detector.detectFromMetadata('/task/dir');
      expect(result).toBeNull();
    });

    it('should extract workspace from task_metadata.json', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: 'D:/Dev/project' })
      );

      const result = await detector.detectFromMetadata('/task/dir');

      expect(result).not.toBeNull();
      expect(result!.workspace).toBe('D:/Dev/project');
      expect(result!.source).toBe('metadata');
      expect(result!.confidence).toBe(0.95);
    });

    it('should handle BOM in metadata file', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        '\uFEFF' + JSON.stringify({ workspace: '/home/user/project' })
      );

      const result = await detector.detectFromMetadata('/task/dir');

      expect(result).not.toBeNull();
      expect(result!.workspace).toBe('/home/user/project');
    });

    it('should return null when metadata has no workspace field', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ title: 'Some task', other: 'data' })
      );

      const result = await detector.detectFromMetadata('/task/dir');
      expect(result).toBeNull();
    });

    it('should return null when workspace is empty string', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: '   ' })
      );

      const result = await detector.detectFromMetadata('/task/dir');
      expect(result).toBeNull();
    });

    it('should handle invalid JSON gracefully', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue('not-valid-json');

      const result = await detector.detectFromMetadata('/task/dir');
      expect(result).toBeNull();
    });
  });

  // === detectFromEnvironmentDetails ===

  describe('detectFromEnvironmentDetails', () => {
    it('should return null when ui_messages.json does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      const result = await detector.detectFromEnvironmentDetails('/task/dir');
      expect(result).toBeNull();
    });

    it('should extract workspace from Current Workspace Directory pattern', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: '# Current Workspace Directory (D:/Dev/roo-extensions) Files\n...',
        },
      ]));

      const result = await detector.detectFromEnvironmentDetails('/task/dir');

      expect(result).not.toBeNull();
      expect(result!.workspace).toBe('D:/Dev/roo-extensions');
      expect(result!.source).toBe('environment_details');
      expect(result!.confidence).toBe(0.85);
    });

    it('should extract workspace from colon pattern', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([
        {
          ts: 1000,
          type: 'say',
          say: 'text',
          text: 'Current Workspace Directory: /home/user/project',
        },
      ]));

      const result = await detector.detectFromEnvironmentDetails('/task/dir');

      expect(result).not.toBeNull();
      expect(result!.workspace).toBe('/home/user/project');
    });

    it('should extract workspace from JSON pattern', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([
        {
          ts: 1000,
          type: 'ask',
          ask: 'followup',
          text: '{"workspace": "C:/Users/dev/app"}',
        },
      ]));

      const result = await detector.detectFromEnvironmentDetails('/task/dir');

      expect(result).not.toBeNull();
      expect(result!.workspace).toBe('C:/Users/dev/app');
    });

    it('should return null for messages without workspace info', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([
        { ts: 1000, type: 'say', say: 'text', text: 'Regular text' },
      ]));

      const result = await detector.detectFromEnvironmentDetails('/task/dir');
      expect(result).toBeNull();
    });

    it('should return null for empty messages array', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue('[]');

      const result = await detector.detectFromEnvironmentDetails('/task/dir');
      expect(result).toBeNull();
    });

    it('should handle BOM in ui_messages.json', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        '\uFEFF' + JSON.stringify([
          {
            ts: 1000,
            type: 'say',
            say: 'text',
            text: '# Current Workspace Directory (/home/test) Files',
          },
        ])
      );

      const result = await detector.detectFromEnvironmentDetails('/task/dir');
      expect(result).not.toBeNull();
      expect(result!.workspace).toBe('/home/test');
    });
  });

  // === detect (orchestration) ===

  describe('detect', () => {
    it('should prioritize metadata over environment_details', async () => {
      // First call (metadata access) succeeds, second (ui_messages access) would also
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify({ workspace: 'D:/metadata-workspace' })) // task_metadata.json
        .mockResolvedValueOnce(JSON.stringify([                                        // ui_messages.json
          { ts: 1, type: 'say', text: '# Current Workspace Directory (/env-workspace) Files' },
        ]));

      const result = await detector.detect('/task/dir');

      expect(result.workspace).toContain('metadata-workspace');
      expect(result.source).toBe('metadata');
    });

    it('should fallback to environment_details when no metadata', async () => {
      // Metadata access fails, ui_messages access succeeds
      vi.mocked(fs.access)
        .mockRejectedValueOnce(new Error('ENOENT'))  // task_metadata.json missing
        .mockResolvedValueOnce(undefined);            // ui_messages.json exists
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify([
        { ts: 1, type: 'say', say: 'text', text: '# Current Workspace Directory (/fallback/ws) Files' },
      ]));

      const result = await detector.detect('/task/dir');

      expect(result.workspace).toContain('fallback');
      expect(result.source).toBe('environment_details');
    });

    it('should return none when both strategies fail', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      const result = await detector.detect('/task/dir');

      expect(result.workspace).toBeNull();
      expect(result.source).toBe('none');
      expect(result.confidence).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Permission denied'));

      const result = await detector.detect('/task/dir');
      expect(result.workspace).toBeNull();
      expect(result.source).toBe('none');
    });
  });

  // === Cache ===

  describe('cache', () => {
    it('should cache results when enableCache is true', async () => {
      const cachedDetector = new WorkspaceDetector({ enableCache: true });
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      await cachedDetector.detect('/task/1');
      await cachedDetector.detect('/task/1'); // Should use cache

      // access should be called only for the first call (2 times: metadata + ui_messages)
      // not for the second call (cached)
      const accessCalls = vi.mocked(fs.access).mock.calls.length;
      expect(accessCalls).toBeLessThanOrEqual(2);
    });

    it('should not cache when enableCache is false', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      await detector.detect('/task/1');
      await detector.detect('/task/1');

      // Without cache, both calls hit fs
      const accessCalls = vi.mocked(fs.access).mock.calls.length;
      expect(accessCalls).toBeGreaterThanOrEqual(4);
    });

    it('should clear cache', () => {
      const cachedDetector = new WorkspaceDetector({ enableCache: true });
      cachedDetector.clearCache();
      const stats = cachedDetector.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('should return cache stats', async () => {
      const cachedDetector = new WorkspaceDetector({ enableCache: true });
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      await cachedDetector.detect('/task/a');
      await cachedDetector.detect('/task/b');

      const stats = cachedDetector.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.keys).toContain('/task/a');
      expect(stats.keys).toContain('/task/b');
    });
  });

  // === isValidWorkspacePath (tested indirectly) ===

  describe('path validation', () => {
    it('should accept Windows paths (C:/)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: 'C:/Users/test' })
      );

      const result = await detector.detectFromMetadata('/task');
      expect(result).not.toBeNull();
    });

    it('should accept Unix paths (/home)', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: '/home/user' })
      );

      const result = await detector.detectFromMetadata('/task');
      expect(result).not.toBeNull();
    });

    it('should reject too short paths', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify([
        { ts: 1, type: 'say', say: 'text', text: '# Current Workspace Directory (ab) Files' },
      ]));

      const result = await detector.detectFromEnvironmentDetails('/task');
      expect(result).toBeNull();
    });
  });

  // === Normalize paths ===

  describe('path normalization', () => {
    it('should normalize paths when enabled', async () => {
      const normDetector = new WorkspaceDetector({
        enableCache: false,
        normalizePaths: true,
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: 'D:/Dev/project/' })
      );

      const result = await normDetector.detect('/task');

      // Trailing slash should be removed
      expect(result.workspace).not.toMatch(/[\/\\]$/);
    });

    it('should not normalize paths when disabled', async () => {
      const rawDetector = new WorkspaceDetector({
        enableCache: false,
        normalizePaths: false,
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: 'D:/Dev/project' })
      );

      const result = await rawDetector.detect('/task');
      expect(result.workspace).toBe('D:/Dev/project');
    });
  });

  // === Validate existence ===

  describe('validateExistence', () => {
    it('should boost confidence when workspace exists as directory', async () => {
      const validDetector = new WorkspaceDetector({
        enableCache: false,
        validateExistence: true,
        normalizePaths: false,
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: '/real/dir' })
      );
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);

      const result = await validDetector.detect('/task');

      // confidence should be boosted (0.95 + 0.1 = 1.0 capped)
      expect(result.confidence).toBe(1.0);
    });

    it('should reduce confidence when path is not a directory', async () => {
      const validDetector = new WorkspaceDetector({
        enableCache: false,
        validateExistence: true,
        normalizePaths: false,
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: '/some/file' })
      );
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);

      const result = await validDetector.detect('/task');

      expect(result.confidence).toBeLessThan(0.95);
    });

    it('should strongly reduce confidence when path does not exist', async () => {
      const validDetector = new WorkspaceDetector({
        enableCache: false,
        validateExistence: true,
        normalizePaths: false,
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ workspace: '/nonexistent' })
      );
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

      const result = await validDetector.detect('/task');

      expect(result.confidence).toBeLessThan(0.5);
    });
  });
});
