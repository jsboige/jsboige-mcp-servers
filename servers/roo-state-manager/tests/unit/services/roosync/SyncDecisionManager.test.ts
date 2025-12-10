import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncDecisionManager } from '../../../../src/services/roosync/SyncDecisionManager.js';
import { RooSyncConfig } from '../../../../src/config/roosync-config.js';
import { PowerShellExecutor } from '../../../../src/services/PowerShellExecutor.js';
import { promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import * as roosyncParsers from '../../../../src/utils/roosync-parsers.js';

vi.mock('fs', () => ({
    promises: {
        access: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
    },
    readFileSync: vi.fn(),
    existsSync: vi.fn()
}));

vi.mock('../../../../src/services/PowerShellExecutor.js');
vi.mock('../../../../src/utils/roosync-parsers.js', () => ({
    parseRoadmapMarkdown: vi.fn(),
    filterDecisionsByStatus: vi.fn(),
    filterDecisionsByMachine: vi.fn(),
    findDecisionById: vi.fn()
}));

describe('SyncDecisionManager', () => {
    let manager: SyncDecisionManager;
    let mockConfig: RooSyncConfig;
    let mockExecutor: any;

    beforeEach(() => {
        mockConfig = {
            machineId: 'test-machine',
            sharedPath: '/tmp/shared'
        } as RooSyncConfig;

        mockExecutor = {
            executeScript: vi.fn()
        };

        manager = new SyncDecisionManager(mockConfig, mockExecutor as unknown as PowerShellExecutor);
        vi.clearAllMocks();
    });

    describe('loadDecisions', () => {
        it('should load decisions from roadmap', async () => {
            (fs.access as any).mockResolvedValue(undefined);
            (roosyncParsers.parseRoadmapMarkdown as any).mockReturnValue([{ id: 'decision-1' }]);

            const decisions = await manager.loadDecisions();
            expect(decisions).toHaveLength(1);
            expect(decisions[0].id).toBe('decision-1');
        });

        it('should throw error if roadmap file does not exist', async () => {
            (fs.access as any).mockRejectedValue(new Error('File not found'));
            await expect(manager.loadDecisions()).rejects.toThrow('Fichier RooSync introuvable');
        });
    });

    describe('executeDecision', () => {
        it('should execute decision successfully', async () => {
            const decisionId = 'decision-1';
            const roadmapContent = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->
            `;
            
            (fs.access as any).mockResolvedValue(undefined);
            (fs.readFile as any).mockResolvedValue(roadmapContent);
            
            // Mock parsers
            (roosyncParsers.parseRoadmapMarkdown as any).mockReturnValue([{ id: decisionId }]);
            (roosyncParsers.findDecisionById as any).mockReturnValue({ id: decisionId });

            // Mock executeScript
            mockExecutor.executeScript.mockResolvedValue({
                success: true,
                stdout: 'Configuration de référence mise à jour avec succès',
                stderr: '',
                executionTime: 100
            });

            const result = await manager.executeDecision(decisionId);
            
            expect(result.success).toBe(true);
            expect(result.changes.filesModified).toContain('sync-config.ref.json');
            expect(mockExecutor.executeScript).toHaveBeenCalledWith(
                'src/sync-manager.ps1',
                ['-Action', 'Apply-Decisions'],
                expect.any(Object)
            );
        });

        it('should handle execution failure', async () => {
            const decisionId = 'decision-1';
            const roadmapContent = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->
            `;
            
            (fs.access as any).mockResolvedValue(undefined);
            (fs.readFile as any).mockResolvedValue(roadmapContent);
            
            (roosyncParsers.parseRoadmapMarkdown as any).mockReturnValue([{ id: decisionId }]);
            (roosyncParsers.findDecisionById as any).mockReturnValue({ id: decisionId });

            mockExecutor.executeScript.mockResolvedValue({
                success: false,
                stdout: '',
                stderr: 'Error executing script',
                executionTime: 100
            });

            const result = await manager.executeDecision(decisionId);
            
            expect(result.success).toBe(false);
            expect(result.error).toContain('PowerShell execution failed');
        });

        it('should return error if decision not found', async () => {
            (fs.access as any).mockResolvedValue(undefined);
            (roosyncParsers.parseRoadmapMarkdown as any).mockReturnValue([]);
            (roosyncParsers.findDecisionById as any).mockReturnValue(undefined);

            const result = await manager.executeDecision('non-existent');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });
    });
});