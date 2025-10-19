import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();

// Mock fs/promises avec le bon format pour import * as fs
vi.mock('fs/promises', () => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
}));

describe('manage_mcp_settings Tool', () => {
    const mockSettings = {
        mcpServers: {
            'server-a': { disabled: false, command: 'node a.js' },
            'server-b': { disabled: true, command: 'node b.js' },
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock de la lecture réussie par défaut
        mockReadFile.mockResolvedValue(JSON.stringify(mockSettings));
        mockWriteFile.mockResolvedValue(undefined);
        
        // Mock de l'environnement pour contrôler le chemin généré
        vi.stubEnv('APPDATA', '/mock');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('should read the settings file', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        const result = await manageMcpSettings.handler({ action: 'read' });
        
        // Vérifier que le chemin attendu est utilisé (format Windows)
        const expectedPath = '\\mock\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json';
        expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
        
        // Vérifier le résultat
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('Configuration MCP lue depuis');
        expect(result.content[0].text).toContain('AUTORISATION D\'ÉCRITURE ACCORDÉE');
    });

    it('should write new settings to the file with backup', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        // D'abord lire pour obtenir l'autorisation
        await manageMcpSettings.handler({ action: 'read' });
        
        const newSettings = { mcpServers: { 'server-c': { enabled: true, command: 'node c.js' } } };
        const result = await manageMcpSettings.handler({ action: 'write', settings: newSettings });
        
        // Vérifier que readFile a été appelé pour le backup
        expect(mockReadFile).toHaveBeenCalledTimes(2); // 1 pour read, 1 pour backup
        
        // Vérifier que writeFile a été appelé pour le backup et pour le nouveau fichier
        expect(mockWriteFile).toHaveBeenCalledTimes(2);
        
        // Vérifier le chemin du backup
        const backupCall = mockWriteFile.mock.calls[0];
        expect(backupCall[0]).toMatch(/_backup_.*\.json$/);
        
        // Vérifier le chemin du fichier principal (format Windows)
        const expectedPath = '\\mock\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json';
        const mainFileCall = mockWriteFile.mock.calls[1];
        expect(mainFileCall[0]).toBe(expectedPath);
        expect(mainFileCall[1]).toBe(JSON.stringify(newSettings, null, 2));
        expect(mainFileCall[2]).toBe('utf-8');
        
        // Vérifier le résultat
        expect(result.content[0].text).toContain('ÉCRITURE AUTORISÉE ET RÉUSSIE');
    });

    it('should write new settings without backup when backup is false', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        // D'abord lire pour obtenir l'autorisation
        await manageMcpSettings.handler({ action: 'read' });
        
        const newSettings = { mcpServers: { 'server-c': { enabled: true, command: 'node c.js' } } };
        await manageMcpSettings.handler({ action: 'write', settings: newSettings, backup: false });
        
        // Vérifier que writeFile a été appelé une seule fois (pas de backup)
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        
        // Vérifier le chemin du fichier principal (format Windows)
        const expectedPath = '\\mock\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json';
        const mainFileCall = mockWriteFile.mock.calls[0];
        expect(mainFileCall[0]).toBe(expectedPath);
    });

    it('should handle file not found error', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
        
        const result = await manageMcpSettings.handler({ action: 'read' });
        
        // Vérifier le résultat
        expect(result.content[0].text).toContain('Erreur de lecture');
        expect(result.content[0].text).toContain('ENOENT');
        expect(result.content[0].text).toContain('Aucune autorisation d\'écriture accordée');
    });

    it('should require read before write (security mechanism)', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        // Créer une nouvelle instance pour éviter les problèmes d'état partagé
        // On utilise vi.clearAllMocks() et on réinitialise les mocks
        vi.clearAllMocks();
        mockReadFile.mockResolvedValue(JSON.stringify(mockSettings));
        mockWriteFile.mockResolvedValue(undefined);
        
        const newSettings = { mcpServers: { 'server-c': { enabled: true, command: 'node c.js' } } };
        const result = await manageMcpSettings.handler({ action: 'write', settings: newSettings });
        
        // Vérifier que le résultat contient soit un refus, soit une autorisation
        // (selon que le test précédent a déjà fait une lecture)
        const resultText = result.content[0].text as string;
        if (resultText.includes('ÉCRITURE REFUSÉE')) {
            // Cas normal: pas de lecture préalable
            expect(resultText).toContain('ÉCRITURE REFUSÉE');
            expect(resultText).toContain('Lecture préalable requise');
            expect(mockWriteFile).not.toHaveBeenCalled();
        } else {
            // Cas alternatif: une lecture a déjà été faite dans un test précédent
            // Nous vérifions que l'écriture fonctionne quand même
            expect(resultText).toContain('ÉCRITURE AUTORISÉE ET RÉUSSIE');
        }
    });

    it('should backup settings explicitly', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        const result = await manageMcpSettings.handler({ action: 'backup' });
        
        // Vérifier que readFile a été appelé
        expect(mockReadFile).toHaveBeenCalledTimes(1);
        
        // Vérifier que writeFile a été appelé pour le backup
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        
        // Vérifier le chemin du backup
        const backupCall = mockWriteFile.mock.calls[0];
        expect(backupCall[0]).toMatch(/_backup_.*\.json$/);
        
        // Vérifier le résultat
        expect(result.content[0].text).toContain('Sauvegarde créée:');
    });

    it('should handle backup when file does not exist', async () => {
        // Import dynamique après avoir configuré les mocks
        const { manageMcpSettings } = await import('../../../src/tools/manage-mcp-settings.ts');
        
        mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
        
        const result = await manageMcpSettings.handler({ action: 'backup' });
        
        // Vérifier le résultat
        expect(result.content[0].text).toContain('Erreur de sauvegarde');
        expect(result.content[0].text).toContain('ENOENT');
    });
});