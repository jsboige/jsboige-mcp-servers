/**
 * Tests unitaires pour diagnose_env
 * Vérifie la santé de l'environnement d'exécution
 *
 * Note: Le setup global (jest.setup.js) mock 'os' avec des valeurs limitées.
 * On unmock 'os' pour ces tests afin d'utiliser les vraies valeurs système.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock os pour utiliser les vraies valeurs système
vi.unmock('os');

// Mock fs/promises avec vi.hoisted
const { mockAccess } = vi.hoisted(() => ({
    mockAccess: vi.fn()
}));

vi.mock('fs/promises', () => ({
    access: mockAccess,
    constants: { R_OK: 4, W_OK: 2 }
}));

import { diagnoseEnv } from '../../../../src/tools/diagnostic/diagnose_env.js';

describe('diagnose_env', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Par défaut, tous les accès réussissent
        mockAccess.mockResolvedValue(undefined);
    });

    it('should return system information', async () => {
        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.system).toBeDefined();
        expect(report.system.platform).toBeDefined();
        expect(report.system.nodeVersion).toBe(process.version);
        expect(report.system.hostname).toBeDefined();
        expect(typeof report.system.hostname).toBe('string');
        expect(report.system.totalMemory).toBeGreaterThan(0);
        expect(report.system.freeMemory).toBeGreaterThan(0);
        expect(report.system.uptime).toBeGreaterThan(0);
    });

    it('should return OK status when all directories are accessible', async () => {
        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.status).toBe('OK');
        expect(report.directories['.']).toEqual({ exists: true, writable: true });
    });

    it('should return WARNING when a critical directory is inaccessible', async () => {
        mockAccess.mockImplementation(async (p: string) => {
            if (typeof p === 'string' && p.includes('.shared-state')) {
                const err: any = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
        });

        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.status).toBe('WARNING');
        expect(report.directories['.shared-state']).toEqual({
            exists: false,
            error: 'ENOENT'
        });
    });

    it('should report missing critical files', async () => {
        mockAccess.mockImplementation(async (p: string) => {
            if (typeof p === 'string' && p.includes('package.json')) {
                throw new Error('ENOENT');
            }
        });

        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.status).toBe('WARNING');
        expect(report.missingFiles).toContain('package.json');
    });

    it('should include environment variables info', async () => {
        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.envVars).toBeDefined();
        expect(report.envVars.hasPath).toBe(true);
        expect(report.envVars.cwd).toBe(process.cwd());
    });

    it('should include a timestamp', async () => {
        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.timestamp).toBeDefined();
        expect(new Date(report.timestamp).getTime()).not.toBeNaN();
    });

    it('should check all 5 critical directories', async () => {
        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        const expectedDirs = ['.', '.shared-state', 'roo-config', 'mcps', 'logs'];
        for (const dir of expectedDirs) {
            expect(report.directories[dir]).toBeDefined();
        }
    });

    it('should handle multiple inaccessible directories', async () => {
        mockAccess.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

        const result = await diagnoseEnv();
        const report = JSON.parse((result.content[0] as any).text);

        expect(report.status).toBe('WARNING');
        for (const dir of Object.keys(report.directories)) {
            expect(report.directories[dir].exists).toBe(false);
        }
    });
});
