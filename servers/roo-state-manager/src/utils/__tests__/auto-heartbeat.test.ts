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
        it('devrait initialiser le module avec timestamp 0 (force first-call heartbeat)', () => {
            initAutoHeartbeat();

            const state = getAutoHeartbeatState();

            expect(state.isInitialized).toBe(true);
            expect(state.lastHeartbeatAt).toBe(0);
        });

        it('devrait rester à 0 si appelé plusieurs fois (idempotent)', () => {
            initAutoHeartbeat();
            const firstTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            vi.setSystemTime(new Date('2026-04-25T12:00:01Z'));
            initAutoHeartbeat();

            const secondTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            expect(secondTimestamp).toBe(firstTimestamp);
            expect(secondTimestamp).toBe(0);
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

        it('devrait trigger heartbeat sur premier appel (lastHeartbeatAt=0)', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat(); // sets lastHeartbeatAt = 0

            const result = await autoHeartbeat('test-tool');

            // First call should ALWAYS trigger because Date.now() - 0 > 15min
            expect(result).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
                triggeredBy: 'test-tool',
            });
        });

        it('devrait retourner false si dans intervalle (15min) après un heartbeat', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            initAutoHeartbeat();
            await autoHeartbeat('first-call'); // triggers heartbeat, sets lastHeartbeatAt = Date.now()

            const result = await autoHeartbeat('test-tool'); // within 15min

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
            expect(oldTimestamp).toBe(0);

            // No need to advance time — first call always triggers (lastHeartbeatAt=0)
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
            expect(state.lastHeartbeatAt).toBe(0);
        });

        it('devrait refléter la mise à jour après un heartbeat', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            initAutoHeartbeat();
            await autoHeartbeat('test-tool');

            const state = getAutoHeartbeatState();
            expect(state.lastHeartbeatAt).toBeGreaterThan(0);
        });
    });

    describe('edge cases', () => {
        it('devrait gérer plusieurs appels rapprochés sans erreur', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            initAutoHeartbeat();

            const results = await Promise.all([
                autoHeartbeat('tool1'),
                autoHeartbeat('tool2'),
                autoHeartbeat('tool3'),
            ]);

            // First call triggers (lastHeartbeatAt=0), subsequent calls within interval
            const trueCount = results.filter(r => r === true).length;
            expect(trueCount).toBeGreaterThanOrEqual(1);
        });

        it('devrait respecter la limite exacte de 15 minutes après le premier heartbeat', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat(); // lastHeartbeatAt = 0

            // First call triggers immediately (lastHeartbeatAt=0 means "never sent")
            const result0 = await autoHeartbeat('test');
            expect(result0).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

            // Reset call count for boundary testing
            mockRegisterHeartbeat.mockClear();

            // Exactement 14 minutes 59 secondes après - devrait skip
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

            initAutoHeartbeat(); // lastHeartbeatAt = 0

            // Premier appel à 12:00 - trigger (lastHeartbeatAt=0, always triggers)
            vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
            const result1 = await autoHeartbeat('tool1');
            expect(result1).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

            // Deuxième appel à 12:01 - skip (within 15min of first heartbeat)
            vi.setSystemTime(new Date('2026-04-25T12:01:00Z'));
            const result2 = await autoHeartbeat('tool2');
            expect(result2).toBe(false);

            // Troisième appel à 12:16 - trigger (15+ min since first heartbeat)
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));
            const result3 = await autoHeartbeat('tool3');
            expect(result3).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(2);
        });
    });
});
