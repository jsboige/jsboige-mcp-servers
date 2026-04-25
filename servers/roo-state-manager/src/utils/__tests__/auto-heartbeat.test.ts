/**
 * Tests pour auto-heartbeat utility (#1609)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { initAutoHeartbeat, autoHeartbeat, getAutoHeartbeatState } from '../auto-heartbeat.js';

// Mock the lazy-roosync module
vi.mock('../../services/lazy-roosync.js', () => ({
    getRooSyncService: vi.fn(),
}));

describe('auto-heartbeat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('initAutoHeartbeat', () => {
        it('devrait initialiser le module avec timestamp actuel', () => {
            const beforeInit = Date.now();
            initAutoHeartbeat();
            const afterInit = Date.now();

            const state = getAutoHeartbeatState();

            expect(state.isInitialized).toBe(true);
            expect(state.lastHeartbeatAt).toBeGreaterThanOrEqual(beforeInit);
            expect(state.lastHeartbeatAt).toBeLessThanOrEqual(afterInit);
        });

        it('devrait réinitialiser le timestamp si appelé plusieurs fois', () => {
            initAutoHeartbeat();
            const firstTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            // Avancer le temps et réinitialiser
            vi.setSystemTime(new Date('2026-04-25T12:00:01Z'));
            initAutoHeartbeat();

            const secondTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            expect(secondTimestamp).toBeGreaterThan(firstTimestamp);
        });
    });

    describe('autoHeartbeat', () => {
        it('devrait initialiser automatiquement si pas initialisé', async () => {
            // Note: ce test vérifie que autoHeartbeat initialise si nécessaire,
            // mais comme les tests partagent le même module, l'état peut persister
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            // Si le module est déjà initialisé par un test précédent, on vérifie juste que ça ne plante pas
            await autoHeartbeat('test-tool');

            const stateAfter = getAutoHeartbeatState();
            expect(stateAfter.isInitialized).toBe(true);
        });

        it('devrait retourner false si dans intervalle (15min)', async () => {
            initAutoHeartbeat();

            const result = await autoHeartbeat('test-tool');

            expect(result).toBe(false);
        });

        it('devrait appeler registerHeartbeat si intervalle écoulé', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            // Initialiser puis avancer le temps de 16 minutes
            initAutoHeartbeat();
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));

            const result = await autoHeartbeat('test-tool');

            expect(result).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
                triggeredBy: 'test-tool',
            });
        });

        it('devrait mettre à jour lastHeartbeatAt après heartbeat réussi', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            initAutoHeartbeat();
            const oldTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            // Avancer le temps de 16 minutes
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));

            await autoHeartbeat('test-tool');

            const newTimestamp = getAutoHeartbeatState().lastHeartbeatAt;
            expect(newTimestamp).toBeGreaterThan(oldTimestamp);
        });

        it('devrait gérer les erreurs sans bloquer', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockRejectedValue(new Error('RooSync error'));

            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            initAutoHeartbeat();
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));

            const result = await autoHeartbeat('test-tool');

            expect(result).toBe(false);
            expect(consoleWarnSpy).toHaveBeenCalled();

            consoleWarnSpy.mockRestore();
        });

        it('devrait passer le nom du tool dans les métadonnées', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));

            await autoHeartbeat('my-custom-tool');

            expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
                triggeredBy: 'my-custom-tool',
            });
        });

        it('devrait fonctionner avec toolName vide', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));

            const result = await autoHeartbeat('');

            expect(result).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
                triggeredBy: '',
            });
        });
    });

    describe('getAutoHeartbeatState', () => {
        it('devrait retourner létat après initialisation', () => {
            initAutoHeartbeat();
            const state = getAutoHeartbeatState();

            expect(state.isInitialized).toBe(true);
            expect(state.lastHeartbeatAt).toBeGreaterThan(0);
        });

        it('devrait retourner lastHeartbeatAt qui évolue avec initAutoHeartbeat', () => {
            initAutoHeartbeat();
            const firstTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            // Avancer le temps
            vi.setSystemTime(new Date('2026-04-25T13:00:00Z'));
            initAutoHeartbeat();

            const secondTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            expect(secondTimestamp).toBeGreaterThan(firstTimestamp);
        });
    });

    describe('edge cases', () => {
        it('devrait gérer plusieurs appels rapprochés sans erreur', async () => {
            initAutoHeartbeat();

            const results = await Promise.all([
                autoHeartbeat('tool1'),
                autoHeartbeat('tool2'),
                autoHeartbeat('tool3'),
            ]);

            // Tous devraient retourner false car dans intervalle
            expect(results).toEqual([false, false, false]);
        });

        it('devrait respecter la limite exacte de 15 minutes', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();

            // Exactement 14 minutes 59 secondes - devrait skip
            vi.setSystemTime(new Date('2026-04-25T12:14:59Z'));

            const result1 = await autoHeartbeat('test');
            expect(result1).toBe(false);
            expect(mockRegisterHeartbeat).not.toHaveBeenCalled();

            // Exactement 15 minutes et 1 seconde - devrait trigger
            vi.setSystemTime(new Date('2026-04-25T12:15:01Z'));

            const result2 = await autoHeartbeat('test');
            expect(result2).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
        });

        it('devrait gérer plusieurs appels avec des timestamps différents', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();

            // Premier appel à 12:00 - skip
            vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
            const result1 = await autoHeartbeat('tool1');
            expect(result1).toBe(false);

            // Deuxième appel à 12:16 - trigger
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));
            const result2 = await autoHeartbeat('tool2');
            expect(result2).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

            // Troisième appel à 12:17 - skip (déjà fait heartbeat)
            vi.setSystemTime(new Date('2026-04-25T12:17:00Z'));
            const result3 = await autoHeartbeat('tool3');
            expect(result3).toBe(false);
        });
    });
});
