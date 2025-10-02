import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RooStateManagerServer } from './index.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('RooStateManagerServer', () => {
    let server: RooStateManagerServer;
    let executeScriptSpy: any;

    beforeEach(() => {
        server = new RooStateManagerServer();
        // Empêcher le chargement asynchrone des squelettes qui maintient Jest en vie
        jest.spyOn(RooStateManagerServer.prototype as any, '_loadSkeletonsFromDisk').mockResolvedValue(undefined);

        // Espionner la méthode privée et la remplacer par un mock
        executeScriptSpy = jest.spyOn(server as any, '_executePowerShellScript');
        // Définir un comportement par défaut pour le mock
        executeScriptSpy.mockResolvedValue({ content: [{ type: 'text', text: 'Default mock response' }] });
    });

    afterEach(async () => {
        // Restaurer le spy après chaque test
        jest.restoreAllMocks();
        // S'assurer que le serveur est arrêté pour éviter les handles ouverts
        if (server) {
            await server.stop();
        }
    });

    // TESTS OBSOLÈTES COMMENTÉS TEMPORAIREMENT - PHASE 3 SYNTHÈSE
    // Ces méthodes n'existent plus dans RooStateManagerServer
    /*
    describe('handleDiagnoseRooState', () => {
        it('should call _executePowerShellScript with correct parameters', async () => {
            await server.handleDiagnoseRooState({});
            expect(executeScriptSpy).toHaveBeenCalledWith(
                'scripts/audit/audit-roo-tasks.ps1',
                ['-AsJson']
            );
        });

        it('should return the result from _executePowerShellScript on success', async () => {
            const mockResult: CallToolResult = { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
            executeScriptSpy.mockResolvedValue(mockResult);

            const response = await server.handleDiagnoseRooState({});
            expect(response).toEqual(mockResult);
        });

        it('should handle pagination parameters correctly', async () => {
            const args = { offset: 10, limit: 50 };
            await server.handleDiagnoseRooState(args);
            expect(executeScriptSpy).toHaveBeenCalledWith(
                'scripts/audit/audit-roo-tasks.ps1',
                ['-AsJson', '-Offset 10', '-Limit 50']
            );
        });
    });

    describe('handleRepairWorkspacePaths', () => {
        it('should call _executePowerShellScript with correctly formatted arguments', async () => {
            const args = {
                path_pairs: ["C:/old='D:/new'", "E:/other='F:/new other'"],
                whatIf: true,
                non_interactive: true
            };

            await server.handleRepairWorkspacePaths(args);

            const expectedScriptArgs = [
                "-PathPairs @('C:/old=''D:/new''','E:/other=''F:/new other''')",
                '-WhatIf',
                '-NonInteractive'
            ];

            expect(executeScriptSpy).toHaveBeenCalledWith(
                'scripts/repair/repair-roo-tasks.ps1',
                expectedScriptArgs
            );
        });

        it('should handle missing path_pairs argument', async () => {
            const args = { whatIf: true };
            await server.handleRepairWorkspacePaths(args);
            
            expect(executeScriptSpy).toHaveBeenCalledWith(
                'scripts/repair/repair-roo-tasks.ps1',
                ['-WhatIf', '-NonInteractive']
            );
        });

        it('should respect the whatIf=false flag', async () => {
            const args = { path_pairs: [], whatIf: false };
            await server.handleRepairWorkspacePaths(args);
            
            const calledArgs = executeScriptSpy.mock.calls[0][1] as string[];
            expect(calledArgs).not.toContain('-WhatIf');
        });

        it('should default to non_interactive=true if not specified', async () => {
            const args = { path_pairs: [] };
            await server.handleRepairWorkspacePaths(args);
            
            const calledArgs = executeScriptSpy.mock.calls[0][1] as string[];
            expect(calledArgs).toContain('-NonInteractive');
        });

        it('should respect the non_interactive=false flag', async () => {
            const args = { path_pairs: [], non_interactive: false };
            await server.handleRepairWorkspacePaths(args);
            
            const calledArgs = executeScriptSpy.mock.calls[0][1] as string[];
            expect(calledArgs).not.toContain('-NonInteractive');
        });

        it('should return the result from _executePowerShellScript', async () => {
            const mockResult: CallToolResult = { content: [{ type: 'text', text: 'Repair successful' }] };
            executeScriptSpy.mockResolvedValue(mockResult);

            const response = await server.handleRepairWorkspacePaths({});
            expect(response).toEqual(mockResult);
        });
    });
    */
});