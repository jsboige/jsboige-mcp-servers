/**
 * Tests pour modes-management.ts
 * Module interne de gestion des modes Roo (custom_modes.yaml)
 *
 * Issue #656 - Phase 2.4 : Couverture Tests
 * Priorité HAUTE - Gestion modes Roo (coordination)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';

// Mock fs
vi.mock('fs/promises');

// Module à tester (import après les mocks)
import {
  readCustomModes,
  listModesSummary,
  backupCustomModes,
  writeCustomModes,
  updateModeField,
  compareModes,
  getCustomModesPath,
  type RooMode,
  type CustomModesData,
  type ModesSummary,
  type ModesDiff,
  type ModesComparison
} from '../modes-management';

const mockedFsPromises = vi.mocked(fsPromises);

describe('modes-management', () => {
  const mockCustomModesPath = 'C:/Users/test/.claude/custom_modes.yaml';
  const mockBackupDir = 'C:/Users/test/.claude/backups';

  const mockCustomModesData: CustomModesData = {
    customModes: [
      {
        slug: 'code-simple',
        name: 'Code Simple',
        description: 'Simple coding tasks',
        roleDefinition: 'You are a simple coder',
        customInstructions: 'Test instructions',
        groups: ['read', 'edit', 'browser', 'mcp']
      },
      {
        slug: 'code-complex',
        name: 'Code Complex',
        description: 'Complex coding tasks',
        roleDefinition: 'You are a complex coder',
        customInstructions: 'Complex test instructions',
        groups: ['read', 'edit', 'browser', 'command', 'mcp']
      }
    ]
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCustomModesPath', () => {
    it('should return the correct path on Windows', () => {
      const result = getCustomModesPath();
      expect(result).toContain('custom_modes.yaml');
      expect(result).toContain('rooveterinaryinc.roo-cline');
    });
  });

  describe('readCustomModes', () => {
    it('should read and parse custom_modes.yaml file', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    description: Simple coding tasks
    groups:
      - read
      - edit
      `;

      mockedFsPromises.readFile.mockResolvedValue(yamlContent as any);

      const result = await readCustomModes(mockCustomModesPath);

      expect(result).toBeDefined();
      expect(result?.customModes).toBeInstanceOf(Array);
      expect(mockedFsPromises.readFile).toHaveBeenCalledWith(mockCustomModesPath, 'utf-8');
    });

    it('should return null if file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockedFsPromises.readFile.mockRejectedValue(error);

      const result = await readCustomModes(mockCustomModesPath);

      expect(result).toBeNull();
    });

    it('should throw error if customModes array is missing', async () => {
      mockedFsPromises.readFile.mockResolvedValue('invalid: yaml' as any);

      await expect(readCustomModes(mockCustomModesPath)).rejects.toThrow('Invalid custom_modes.yaml');
    });

    it('should use default path if not provided', async () => {
      mockedFsPromises.readFile.mockResolvedValue('customModes: []' as any);

      await readCustomModes();

      expect(mockedFsPromises.readFile).toHaveBeenCalled();
    });
  });

  describe('listModesSummary', () => {
    it('should return summary of all modes', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    groups:
      - read
      - edit
  - slug: code-complex
    name: Code Complex
    groups:
      - read
      - edit
      - command
      `;

      mockedFsPromises.readFile.mockResolvedValue(yamlContent as any);

      const summary = await listModesSummary(mockCustomModesPath);

      expect(summary).toHaveLength(2);
      expect(summary[0].slug).toBe('code-simple');
      expect(summary[1].slug).toBe('code-complex');
    });

    it('should return empty array if file not found', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockedFsPromises.readFile.mockRejectedValue(error);

      const summary = await listModesSummary(mockCustomModesPath);

      expect(summary).toEqual([]);
    });

    it('should include mode details in summary', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    roleDefinition: 'You are a coder'
    customInstructions: 'Test instructions'
    groups:
      - read
      - edit
      - browser
      - mcp
      `;

      mockedFsPromises.readFile.mockResolvedValue(yamlContent as any);

      const summary = await listModesSummary(mockCustomModesPath);

      expect(summary[0]).toMatchObject({
        slug: 'code-simple',
        name: 'Code Simple',
        groups: ['read', 'edit', 'browser', 'mcp'],
        hasCustomInstructions: true,
        hasRoleDefinition: true
      });
    });

    it('should handle modes without optional fields', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    groups: []
      `;

      mockedFsPromises.readFile.mockResolvedValue(yamlContent as any);

      const summary = await listModesSummary(mockCustomModesPath);

      expect(summary[0].hasCustomInstructions).toBe(false);
      expect(summary[0].hasRoleDefinition).toBe(false);
    });
  });

  describe('backupCustomModes', () => {
    it('should create backup file in backups directory', async () => {
      mockedFsPromises.readFile.mockResolvedValue('content' as any);
      mockedFsPromises.mkdir.mockResolvedValue(undefined);
      mockedFsPromises.writeFile.mockResolvedValue(undefined);

      const backupPath = await backupCustomModes(mockCustomModesPath);

      expect(backupPath).toContain('backups');
      expect(backupPath).toMatch(/custom_modes\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.yaml$/);
      // Normalize path for Windows backslash comparison
      expect(mockedFsPromises.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('backups'),
        { recursive: true }
      );
      expect(mockedFsPromises.writeFile).toHaveBeenCalled();
    });

    it('should throw error if original file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockedFsPromises.readFile.mockRejectedValue(error);

      await expect(backupCustomModes(mockCustomModesPath)).rejects.toThrow();
    });
  });

  describe('writeCustomModes', () => {
    it('should write modes data to YAML file', async () => {
      mockedFsPromises.writeFile.mockResolvedValue(undefined);

      await writeCustomModes(mockCustomModesData, mockCustomModesPath);

      expect(mockedFsPromises.writeFile).toHaveBeenCalledWith(
        mockCustomModesPath,
        expect.stringContaining('slug: code-simple'),
        'utf-8'
      );
    });

    it('should use default path if not provided', async () => {
      mockedFsPromises.writeFile.mockResolvedValue(undefined);

      await writeCustomModes(mockCustomModesData);

      expect(mockedFsPromises.writeFile).toHaveBeenCalled();
    });
  });

  describe('updateModeField', () => {
    it('should update a specific field in a mode', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    groups:
      - read
      - edit
  - slug: code-complex
    name: Code Complex
    groups:
      - read
      - edit
      - command
      `;

      mockedFsPromises.readFile.mockResolvedValue(yamlContent);
      mockedFsPromises.mkdir.mockResolvedValue(undefined);
      mockedFsPromises.writeFile.mockResolvedValue(undefined);

      const result = await updateModeField('code-simple', 'name', 'Updated Name', mockCustomModesPath);

      expect(result.backupPath).toContain('backups');
      expect(result.previousValue).toBe('Code Simple');
      expect(mockedFsPromises.writeFile).toHaveBeenCalled();
    });

    it('should throw error if mode slug not found', async () => {
      mockedFsPromises.readFile.mockResolvedValue('customModes: []' as any);

      await expect(
        updateModeField('non-existent', 'name', 'New Name', mockCustomModesPath)
      ).rejects.toThrow('Mode "non-existent" not found');
    });

    it('should throw error if file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockedFsPromises.readFile.mockRejectedValue(error);

      await expect(
        updateModeField('code-simple', 'name', 'New Name', mockCustomModesPath)
      ).rejects.toThrow('custom_modes.yaml not found');
    });
  });

  describe('compareModes', () => {
    const localData: CustomModesData = {
      customModes: [
        {
          slug: 'code-simple',
          name: 'Code Simple',
          description: 'Simple coding',
          groups: ['read', 'edit']
        },
        {
          slug: 'code-complex',
          name: 'Code Complex',
          description: 'Complex coding',
          groups: ['read', 'edit', 'command']
        }
      ]
    };

    const remoteData: CustomModesData = {
      customModes: [
        {
          slug: 'code-simple',
          name: 'Code Simple Updated', // changed
          description: 'Simple coding',
          groups: ['read', 'edit']
        },
        {
          slug: 'debug-simple', // new
          name: 'Debug Simple',
          description: 'Simple debugging',
          groups: ['read', 'mcp']
        }
      ]
    };

    it('should detect local-only, remote-only, and common modes', () => {
      const comparison: ModesComparison = compareModes(localData, remoteData);

      expect(comparison.localOnly).toContain('code-complex');
      expect(comparison.remoteOnly).toContain('debug-simple');
      expect(comparison.common).toContain('code-simple');
    });

    it('should detect field differences in common modes', () => {
      const comparison: ModesComparison = compareModes(localData, remoteData);

      const simpleDiff = comparison.diffs.find(d => d.slug === 'code-simple');
      expect(simpleDiff).toBeDefined();
      expect(simpleDiff?.differences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'name',
            localValue: 'Code Simple',
            remoteValue: 'Code Simple Updated'
          })
        ])
      );
    });

    it('should return empty diffs for identical modes', () => {
      const identicalData: CustomModesData = JSON.parse(JSON.stringify(localData));
      const comparison: ModesComparison = compareModes(localData, identicalData);

      expect(comparison.diffs).toHaveLength(0);
      expect(comparison.localOnly).toHaveLength(0);
      expect(comparison.remoteOnly).toHaveLength(0);
      expect(comparison.common).toHaveLength(2);
    });

    it('should handle empty datasets', () => {
      const emptyLocal: CustomModesData = { customModes: [] };
      const comparison: ModesComparison = compareModes(emptyLocal, remoteData);

      expect(comparison.localOnly).toHaveLength(0);
      expect(comparison.remoteOnly).toHaveLength(2);
      expect(comparison.common).toHaveLength(0);
    });
  });

  describe('integration scenarios', () => {
    it('should support read-update workflow', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    groups:
      - read
      - edit
      `;

      mockedFsPromises.readFile
        .mockResolvedValueOnce(yamlContent) // readCustomModes
        .mockResolvedValueOnce(yamlContent); // backupCustomModes

      mockedFsPromises.mkdir.mockResolvedValue(undefined);
      mockedFsPromises.writeFile.mockResolvedValue(undefined);

      // Update mode name
      await updateModeField('code-simple', 'name', 'Updated Name', mockCustomModesPath);

      expect(mockedFsPromises.writeFile).toHaveBeenCalledTimes(2); // backup + write
    });

    it('should support list-and-compare workflow', async () => {
      const yamlContent = `
customModes:
  - slug: code-simple
    name: Code Simple
    groups: []
      `;

      mockedFsPromises.readFile.mockResolvedValue(yamlContent as any);

      const summary = await listModesSummary(mockCustomModesPath);

      // Use the same data structure for comparison
      const localModes: CustomModesData = {
        customModes: [{ slug: 'code-simple', name: 'Code Simple', groups: [] }]
      };
      const remoteModes: CustomModesData = {
        customModes: [{ slug: 'code-simple', name: 'Code Simple', groups: [] }]
      };
      const comparison = compareModes(localModes, remoteModes);

      expect(summary).toHaveLength(1);
      expect(comparison.localOnly).toHaveLength(0);
      expect(comparison.remoteOnly).toHaveLength(0);
      expect(comparison.common).toHaveLength(1);
    });
  });
});
