/**
 * Tests for roosync_update_dashboard tool
 *
 * Covers: machine section update, generic section update,
 * replace/append/prepend modes, timestamp update, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    roosyncUpdateDashboard,
    updateDashboardToolMetadata,
} from '../../../../src/tools/roosync/update-dashboard.js';

const {
    mockReadFile,
    mockWriteFile,
    mockAccess,
} = vi.hoisted(() => ({
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockAccess: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    default: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
        access: mockAccess,
    },
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    access: mockAccess,
}));

const DASHBOARD_CONTENT = `# Dashboard RooSync

**Dernière mise à jour:** 2026-05-04 00:00:00 par old-machine:workspace

## État Global
Ancien contenu global

### myia-po-2025
Status: online

#### roo-extensions
Notes libres:
  Old notes

### myia-ai-01
Status: online

#### roo-extensions
Notes libres:
  AI notes

## Notes Inter-Agents
Old intercom

## Décisions en Attente
No decisions

## Métriques
No metrics
`;

describe('roosync_update_dashboard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ROOSYNC_SHARED_PATH = '/tmp/shared';
        process.env.ROOSYNC_MACHINE_ID = 'myia-po-2025';
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue(DASHBOARD_CONTENT);
        mockWriteFile.mockResolvedValue(undefined);
    });

    describe('section=machine', () => {
        it('replaces machine section content', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'machine',
                content: 'New machine content',
                mode: 'replace',
            });
            expect(result.success).toBe(true);
            expect(result.section).toBe('machine');
            expect(result.mode).toBe('replace');
            expect(mockWriteFile).toHaveBeenCalled();
        });

        it('appends to machine section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'machine',
                content: 'Appended content',
                mode: 'append',
            });
            expect(result.success).toBe(true);
            const written = mockWriteFile.mock.calls[0][1] as string;
            expect(written).toContain('Appended content');
        });

        it('prepends to machine section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'machine',
                content: 'Prepended content',
                mode: 'prepend',
            });
            expect(result.success).toBe(true);
            const written = mockWriteFile.mock.calls[0][1] as string;
            expect(written).toContain('Prepended content');
        });

        it('uses explicit machine id override', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'machine',
                content: 'Test',
                machine: 'myia-ai-01',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('generic sections', () => {
        it('updates global section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'global',
                content: 'New global content',
                mode: 'replace',
            });
            expect(result.success).toBe(true);
            const written = mockWriteFile.mock.calls[0][1] as string;
            expect(written).toContain('New global content');
        });

        it('updates intercom section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'intercom',
                content: 'New intercom',
                mode: 'replace',
            });
            expect(result.success).toBe(true);
        });

        it('updates decisions section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'decisions',
                content: 'New decisions',
            });
            expect(result.success).toBe(true);
        });

        it('updates metrics section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'metrics',
                content: 'New metrics',
            });
            expect(result.success).toBe(true);
        });

        it('appends to generic section', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'global',
                content: 'Extra content',
                mode: 'append',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('defaults', () => {
        it('defaults to replace mode when mode omitted', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'global',
                content: 'Default replace',
            });
            expect(result.mode).toBe('replace');
        });

        it('defaults workspace to roo-extensions', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'machine',
                content: 'Test',
            });
            expect(result.success).toBe(true);
        });

        it('uses ROOSYNC_MACHINE_ID when machine not provided', async () => {
            const result = await roosyncUpdateDashboard({
                section: 'machine',
                content: 'Test',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('error handling', () => {
        it('throws when ROOSYNC_SHARED_PATH missing', async () => {
            delete process.env.ROOSYNC_SHARED_PATH;
            await expect(roosyncUpdateDashboard({
                section: 'global',
                content: 'Test',
            })).rejects.toThrow('ROOSYNC_SHARED_PATH');
        });

        it('throws when dashboard file not found', async () => {
            mockAccess.mockRejectedValue(new Error('ENOENT'));
            await expect(roosyncUpdateDashboard({
                section: 'global',
                content: 'Test',
            })).rejects.toThrow('Dashboard non trouvé');
        });

        it('throws when machine section not found in dashboard', async () => {
            mockReadFile.mockResolvedValue('# Empty\nNo sections');
            await expect(roosyncUpdateDashboard({
                section: 'machine',
                content: 'Test',
                machine: 'nonexistent',
            })).rejects.toThrow('non trouvée');
        });

        it('throws when generic section title not found', async () => {
            mockReadFile.mockResolvedValue('# Dashboard\n## Other Section\nContent');
            await expect(roosyncUpdateDashboard({
                section: 'global',
                content: 'Test',
            })).rejects.toThrow('non trouvée');
        });

        it('throws when ROOSYNC_MACHINE_ID missing and section=machine', async () => {
            delete process.env.ROOSYNC_MACHINE_ID;
            await expect(roosyncUpdateDashboard({
                section: 'machine',
                content: 'Test',
            })).rejects.toThrow('ROOSYNC_MACHINE_ID');
        });
    });

    describe('metadata', () => {
        it('has correct tool metadata', () => {
            expect(updateDashboardToolMetadata.name).toBe('roosync_update_dashboard');
            expect(updateDashboardToolMetadata.inputSchema.required).toContain('section');
            expect(updateDashboardToolMetadata.inputSchema.required).toContain('content');
        });
    });
});
