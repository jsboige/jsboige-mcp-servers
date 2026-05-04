/**
 * Tests for modes-management internal API
 *
 * Covers: readCustomModes, listModesSummary, backupCustomModes,
 * writeCustomModes, updateModeField, compareModes, getCustomModesPath
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    readCustomModes,
    listModesSummary,
    backupCustomModes,
    writeCustomModes,
    updateModeField,
    compareModes,
    getCustomModesPath,
} from '../../../../src/tools/roosync/modes-management.js';
import type { CustomModesData } from '../../../../src/tools/roosync/modes-management.js';

const {
    mockReadFile,
    mockWriteFile,
    mockMkdir,
    mockAccess,
} = vi.hoisted(() => ({
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
    mockAccess: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    access: mockAccess,
}));

const MOCK_YAML = `customModes:
  - slug: code-simple
    name: Code Simple
    roleDefinition: You are a coder
    groups:
      - read
      - edit
    customInstructions: Use vitest
  - slug: debug-simple
    name: Debug Simple
    groups:
      - read
      - edit
      - browser
`;

const MOCK_DATA: CustomModesData = {
    customModes: [
        {
            slug: 'code-simple',
            name: 'Code Simple',
            roleDefinition: 'You are a coder',
            groups: ['read', 'edit'],
            customInstructions: 'Use vitest',
        },
        {
            slug: 'debug-simple',
            name: 'Debug Simple',
            groups: ['read', 'edit', 'browser'],
        },
    ],
};

describe('modes-management', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getCustomModesPath', () => {
        it('returns path under APPDATA', () => {
            process.env.APPDATA = 'C:/Users/test/AppData/Roaming';
            const result = getCustomModesPath();
            expect(result).toContain('rooveterinaryinc.roo-cline');
            expect(result).toContain('custom_modes.yaml');
            delete process.env.APPDATA;
        });

        it('falls back to homedir when APPDATA unset', () => {
            delete process.env.APPDATA;
            const result = getCustomModesPath();
            expect(result).toContain('custom_modes.yaml');
        });
    });

    describe('readCustomModes', () => {
        it('reads and parses YAML successfully', async () => {
            mockReadFile.mockResolvedValue(MOCK_YAML);
            const result = await readCustomModes('/tmp/test.yaml');
            expect(result?.customModes).toHaveLength(2);
            expect(result?.customModes[0].slug).toBe('code-simple');
        });

        it('returns null when file not found', async () => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            mockReadFile.mockRejectedValue(err);
            const result = await readCustomModes('/tmp/missing.yaml');
            expect(result).toBeNull();
        });

        it('throws on invalid YAML content', async () => {
            mockReadFile.mockResolvedValue('not: yaml\nno_custom_modes: true');
            await expect(readCustomModes('/tmp/invalid.yaml'))
                .rejects.toThrow('missing customModes array');
        });

        it('throws on other read errors', async () => {
            mockReadFile.mockRejectedValue(new Error('Permission denied'));
            await expect(readCustomModes('/tmp/forbidden.yaml'))
                .rejects.toThrow('Permission denied');
        });
    });

    describe('listModesSummary', () => {
        it('returns empty array when no modes file', async () => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            mockReadFile.mockRejectedValue(err);
            const result = await listModesSummary('/tmp/missing.yaml');
            expect(result).toEqual([]);
        });

        it('returns summary with correct fields', async () => {
            mockReadFile.mockResolvedValue(MOCK_YAML);
            const result = await listModesSummary('/tmp/test.yaml');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                slug: 'code-simple',
                name: 'Code Simple',
                groups: ['read', 'edit'],
                hasCustomInstructions: true,
                hasRoleDefinition: true,
            });
            expect(result[1].hasCustomInstructions).toBe(false);
        });
    });

    describe('backupCustomModes', () => {
        it('creates backup file with timestamp', async () => {
            mockReadFile.mockResolvedValue(MOCK_YAML);
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);
            const result = await backupCustomModes('/tmp/custom_modes.yaml');
            expect(result).toContain('custom_modes.');
            expect(result).toContain('.yaml');
            expect(mockMkdir).toHaveBeenCalledWith(
                expect.stringContaining('backups'),
                { recursive: true }
            );
        });
    });

    describe('writeCustomModes', () => {
        it('writes YAML with proper formatting options', async () => {
            mockWriteFile.mockResolvedValue(undefined);
            await writeCustomModes(MOCK_DATA, '/tmp/test.yaml');
            expect(mockWriteFile).toHaveBeenCalledWith(
                '/tmp/test.yaml',
                expect.any(String),
                'utf-8'
            );
            const writtenYaml = mockWriteFile.mock.calls[0][1] as string;
            expect(writtenYaml).toContain('code-simple');
        });
    });

    describe('updateModeField', () => {
        it('updates a field and returns backup + previous value', async () => {
            mockReadFile.mockResolvedValue(MOCK_YAML);
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);
            const result = await updateModeField(
                'code-simple', 'customInstructions', 'New instructions', '/tmp/test.yaml'
            );
            expect(result.backupPath).toContain('custom_modes.');
            expect(result.previousValue).toBe('Use vitest');
            // Two writes: backup + update
            expect(mockWriteFile).toHaveBeenCalledTimes(2);
        });

        it('throws when modes file not found', async () => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            mockReadFile.mockRejectedValue(err);
            await expect(updateModeField('code-simple', 'name', 'X', '/tmp/missing.yaml'))
                .rejects.toThrow('not found');
        });

        it('throws when slug not found', async () => {
            mockReadFile.mockResolvedValue(MOCK_YAML);
            await expect(updateModeField('nonexistent', 'name', 'X', '/tmp/test.yaml'))
                .rejects.toThrow('not found. Available:');
        });
    });

    describe('compareModes', () => {
        it('detects local-only modes', () => {
            const local: CustomModesData = {
                customModes: [
                    { slug: 'a', name: 'A', groups: ['read'] },
                    { slug: 'b', name: 'B', groups: ['read'] },
                ],
            };
            const remote: CustomModesData = {
                customModes: [
                    { slug: 'a', name: 'A', groups: ['read'] },
                ],
            };
            const result = compareModes(local, remote);
            expect(result.localOnly).toEqual(['b']);
            expect(result.remoteOnly).toEqual([]);
            expect(result.common).toEqual(['a']);
        });

        it('detects remote-only modes', () => {
            const local: CustomModesData = {
                customModes: [{ slug: 'a', name: 'A', groups: ['read'] }],
            };
            const remote: CustomModesData = {
                customModes: [
                    { slug: 'a', name: 'A', groups: ['read'] },
                    { slug: 'c', name: 'C', groups: ['edit'] },
                ],
            };
            const result = compareModes(local, remote);
            expect(result.remoteOnly).toEqual(['c']);
        });

        it('detects field differences in common modes', () => {
            const local: CustomModesData = {
                customModes: [{ slug: 'a', name: 'Local A', groups: ['read'] }],
            };
            const remote: CustomModesData = {
                customModes: [{ slug: 'a', name: 'Remote A', groups: ['edit'] }],
            };
            const result = compareModes(local, remote);
            expect(result.diffs).toHaveLength(1);
            expect(result.diffs[0].slug).toBe('a');
            expect(result.diffs[0].differences.length).toBeGreaterThanOrEqual(1);
        });

        it('returns empty diffs for identical modes', () => {
            const data: CustomModesData = {
                customModes: [{ slug: 'a', name: 'A', groups: ['read'] }],
            };
            const result = compareModes(data, data);
            expect(result.localOnly).toEqual([]);
            expect(result.remoteOnly).toEqual([]);
            expect(result.diffs).toEqual([]);
            expect(result.common).toEqual(['a']);
        });

        it('compares complex fields like roleDefinition', () => {
            const local: CustomModesData = {
                customModes: [{ slug: 'a', name: 'A', groups: ['read'], roleDefinition: 'Role v1' }],
            };
            const remote: CustomModesData = {
                customModes: [{ slug: 'a', name: 'A', groups: ['read'], roleDefinition: 'Role v2' }],
            };
            const result = compareModes(local, remote);
            const diff = result.diffs[0]?.differences.find(d => d.field === 'roleDefinition');
            expect(diff).toBeDefined();
            expect(diff?.localValue).toBe('Role v1');
            expect(diff?.remoteValue).toBe('Role v2');
        });
    });
});
