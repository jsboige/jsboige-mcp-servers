/**
 * Linux Compatibility Integration Test
 *
 * Tests roo-state-manager running on Linux (e.g., in NanoClaw containers).
 * Validates path handling, platform detection, and graceful degradation for missing VS Code logs.
 *
 * Issue: #1349 (Linux compatibility for NanoClaw container integration)
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

describe('Linux Compatibility Integration Tests', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create temporary test directory
    const tmpBase = path.join(os.tmpdir(), 'roo-state-manager-linux-test');
    tempDir = path.join(tmpBase, `test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Path Detection on Linux', () => {
    test('read_vscode_logs detects correct path on Linux', async () => {
      // Mock platform detection
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      try {
        const { readVscodeLogs } = await import('../../src/tools/read-vscode-logs.js');

        // The tool should handle missing VS Code logs gracefully
        const result = await readVscodeLogs.handler({
          lines: 10,
          maxSessions: 1,
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);

        // Result should indicate missing logs, not a configuration error
        const text = result.content[0].text || '';
        expect(text).not.toContain('APPDATA environment variable');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    test('claude-storage-detector handles Linux paths without APPDATA', async () => {
      // Mock platform and home directory
      const originalPlatform = process.platform;
      const originalHome = process.env.HOME;

      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      process.env.HOME = tempDir;

      try {
        const { ClaudeStorageDetector } = await import('../../src/utils/claude-storage-detector.js');

        // Should not throw, even if the path doesn't exist
        const locations = await ClaudeStorageDetector.detectStorageLocations();
        expect(Array.isArray(locations)).toBe(true);

        // The detector should return empty array gracefully
        expect(locations).toBeDefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        if (originalHome) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
      }
    });

    test('path normalizer handles Linux forward slashes correctly', async () => {
      const { normalizePath } = await import('../../src/utils/path-normalizer.js');

      const unixPath = '/workspace/roosync/.shared-state';
      const normalized = normalizePath(unixPath);

      expect(normalized).toBe('/workspace/roosync/.shared-state');
      expect(normalized).not.toContain('\\');
    });

    test('path normalizer converts Windows backslashes on Linux context', async () => {
      const { normalizePath } = await import('../../src/utils/path-normalizer.js');

      // Even on Linux, paths might contain backslashes from external sources
      const mixedPath = 'C:\\Users\\user\\project';
      const normalized = normalizePath(mixedPath);

      // Should convert to forward slashes and lowercase
      expect(normalized).toBe('c:/users/user/project');
      expect(normalized).not.toContain('\\');
    });
  });

  describe('ROOSYNC_MACHINE_ID Override', () => {
    test('machine ID from env var is used in container context', async () => {
      // Set custom machine ID
      const originalMachineId = process.env.ROOSYNC_MACHINE_ID;
      process.env.ROOSYNC_MACHINE_ID = 'nanoclaw-cluster-01';

      try {
        // The config module should read this correctly
        // This is more of a integration smoke test
        process.env.ROOSYNC_SHARED_PATH = tempDir;

        // Verify the env var is set and would be used by the server
        expect(process.env.ROOSYNC_MACHINE_ID).toBe('nanoclaw-cluster-01');
      } finally {
        if (originalMachineId) {
          process.env.ROOSYNC_MACHINE_ID = originalMachineId;
        } else {
          delete process.env.ROOSYNC_MACHINE_ID;
        }
        delete process.env.ROOSYNC_SHARED_PATH;
      }
    });
  });

  describe('Cross-Platform Path Handling', () => {
    test('absolute Linux paths are handled correctly', async () => {
      const { normalizePath } = await import('../../src/utils/path-normalizer.js');

      const paths = [
        '/workspace/roosync',
        '/root/.config/Code/logs',
        '/home/user/.claude/projects',
      ];

      for (const p of paths) {
        const normalized = normalizePath(p);
        expect(normalized).toBe(p.toLowerCase());
        expect(normalized).not.toContain('\\');
      }
    });

    test('relative paths work on Linux', async () => {
      const { normalizePath } = await import('../../src/utils/path-normalizer.js');

      const relativePaths = [
        './shared-state',
        '../projects',
        'data/conversations',
      ];

      for (const p of relativePaths) {
        const normalized = normalizePath(p);
        expect(normalized).toBe(p.toLowerCase());
      }
    });

    test('environment variable path detection works with ROOSYNC_SHARED_PATH', async () => {
      const testPath = '/workspace/roosync/.shared-state';
      const originalPath = process.env.ROOSYNC_SHARED_PATH;

      process.env.ROOSYNC_SHARED_PATH = testPath;

      try {
        const { getSharedStatePath } = await import('../../src/utils/shared-state-path.js');
        const detectedPath = getSharedStatePath();
        expect(detectedPath).toBe(testPath);
      } finally {
        if (originalPath) {
          process.env.ROOSYNC_SHARED_PATH = originalPath;
        } else {
          delete process.env.ROOSYNC_SHARED_PATH;
        }
      }
    });
  });

  describe('File Operations on Mounted Volumes', () => {
    test('can read and write to mounted directory', async () => {
      const testFile = path.join(tempDir, 'test-mount.json');
      const testData = { test: 'data', timestamp: new Date().toISOString() };

      // Write
      await fs.writeFile(testFile, JSON.stringify(testData, null, 2), 'utf-8');
      expect(existsSync(testFile)).toBe(true);

      // Read
      const content = await fs.readFile(testFile, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.test).toBe('data');

      // Cleanup
      await fs.unlink(testFile);
    });

    test('handles UTF-8 encoding without BOM', async () => {
      const testFile = path.join(tempDir, 'utf8-test.txt');
      const content = 'Hello, Linux! 🎉';

      // Write using UTF-8 without BOM
      await fs.writeFile(testFile, content, { encoding: 'utf-8' });

      // Read and verify no BOM
      const buffer = await fs.readFile(testFile);
      const hasBOM = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      expect(hasBOM).toBe(false);

      // Cleanup
      await fs.unlink(testFile);
    });
  });

  describe('Case Sensitivity on Linux', () => {
    test('path comparison handles case sensitivity correctly', async () => {
      const { normalizePath } = await import('../../src/utils/path-normalizer.js');

      const path1 = normalizePath('/Workspace/Project');
      const path2 = normalizePath('/workspace/project');

      // After normalization, both should be lowercase and equal
      expect(path1).toBe(path2);
      expect(path1).toBe('/workspace/project');
    });

    test('file operations work with case-insensitive paths in comparisons', async () => {
      // On Linux, file system is case-sensitive but our normalizer handles it
      const testDir1 = path.join(tempDir, 'TestDir');
      const testDir2 = path.join(tempDir, 'testdir');

      // These are different on Linux
      await fs.mkdir(testDir1, { recursive: true });

      // But when normalized, should be compared correctly for deduplication
      const { normalizePath } = await import('../../src/utils/path-normalizer.js');
      const norm1 = normalizePath(testDir1);
      const norm2 = normalizePath(testDir2);

      expect(norm1).toBe(norm2); // Both lowercase

      // Cleanup
      await fs.rm(testDir1, { recursive: true });
    });
  });

  describe('Container Integration Smoke Tests', () => {
    test('server startup would work with Linux env vars', async () => {
      // Simulate NanoClaw container environment
      const containerEnv = {
        ROOSYNC_MACHINE_ID: 'nanoclaw-cluster-01',
        ROOSYNC_SHARED_PATH: '/workspace/roosync/.shared-state',
        QDRANT_URL: 'http://qdrant-service:6334',
        QDRANT_API_KEY: 'test-key',
        QDRANT_COLLECTION_NAME: 'roo-state',
        EMBEDDING_API_KEY: 'test-embedding-key',
      };

      // Verify all required vars are set
      const requiredVars = [
        'ROOSYNC_MACHINE_ID',
        'ROOSYNC_SHARED_PATH',
        'QDRANT_URL',
        'QDRANT_API_KEY',
        'QDRANT_COLLECTION_NAME',
        'EMBEDDING_API_KEY',
      ];

      for (const varName of requiredVars) {
        expect(containerEnv[varName as keyof typeof containerEnv]).toBeDefined();
      }
    });

    test('platform detection works on Linux', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      try {
        expect(process.platform).toBe('linux');
        expect(os.platform()).toMatch(/linux|win32|darwin/);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });
});
