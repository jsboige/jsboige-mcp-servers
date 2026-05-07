/**
 * Tests pour auto-heartbeat utility (#1609)
 * Updated for #2030: initAutoHeartbeat() now sets lastHeartbeatAt = 0
 * so first tool call after server restart always triggers heartbeat.
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
        it('devrait initialiser le module avec lastHeartbeatAt = 0 (#2030)', () => {
            initAutoHeartbeat();

            const state = getAutoHeartbeatState();

            expect(state.isInitialized).toBe(true);
            // #2030: Initialize to 0 so first call always triggers heartbeat
            expect(state.lastHeartbeatAt).toBe(0);
        });

        it('devrait réinitialiser à 0 si appelé plusieurs fois (#2030)', () => {
            initAutoHeartbeat();
            const firstTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            initAutoHeartbeat();
            const secondTimestamp = getAutoHeartbeatState().lastHeartbeatAt;

            // Both should be 0 — always ensures first call triggers
            expect(firstTimestamp).toBe(0);
            expect(secondTimestamp).toBe(0);
        });
    });

    describe('autoHeartbeat', () => {
        it('devrait initialiser automatiquement si pas initialisé', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            await autoHeartbeat('test-tool');

            const stateAfter = getAutoHeartbeatState();
            expect(stateAfter.isInitialized).toBe(true);
        });

        it('devrait toujours trigger sur premier appel après init (#2030)', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();

            // First call should trigger (lastHeartbeatAt = 0, so interval elapsed)
            const result = await autoHeartbeat('test-tool');

            expect(result).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
                triggeredBy: 'test-tool',
            });
        });

        it('devrait retourner false si dans intervalle après premier trigger', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            initAutoHeartbeat();
            // First call triggers
            await autoHeartbeat('first-call');

            // Second call within interval — skip
            const result = await autoHeartbeat('test-tool');
            expect(result).toBe(false);
        });

        it('devrait appeler registerHeartbeat si intervalle écoulé', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();
            // First call triggers (init with 0)
            await autoHeartbeat('first-call');
            mockRegisterHeartbeat.mockClear();

            // Advance past 15min
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

            // First call triggers (init with 0) at 12:00:00
            await autoHeartbeat('test-tool');

            const newTimestamp = getAutoHeartbeatState().lastHeartbeatAt;
            expect(newTimestamp).toBeGreaterThan(oldTimestamp);
        });

        it('devrait gérer les erreurs sans bloquer', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockRejectedValue(new Error('RooSync error'));

            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            initAutoHeartbeat();
            // First call triggers (init with 0) but service rejects

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
            // First call triggers (init with 0)
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
            // First call triggers (init with 0)
            const result = await autoHeartbeat('');

            expect(result).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledWith({
                triggeredBy: '',
            });
        });
    });

    describe('getAutoHeartbeatState', () => {
        it('devrait retourner lastHeartbeatAt = 0 après initialisation (#2030)', () => {
            initAutoHeartbeat();
            const state = getAutoHeartbeatState();

            expect(state.isInitialized).toBe(true);
            expect(state.lastHeartbeatAt).toBe(0);
        });

        it('devrait retourner lastHeartbeatAt mis à jour après trigger', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: vi.fn().mockResolvedValue(undefined),
            } as any);

            initAutoHeartbeat();
            await autoHeartbeat('test-tool');

            const state = getAutoHeartbeatState();
            // After first trigger, lastHeartbeatAt should be Date.now() (12:00:00 = mocked time)
            expect(state.lastHeartbeatAt).toBe(Date.now());
        });
    });

    describe('edge cases', () => {
        it('devrait gérer plusieurs appels rapprochés: premier trigger, autres skip (#2030)', async () => {
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

            // First call triggers (init with 0), others within interval → skip
            // Note: race condition in parallel — at least one should trigger
            const triggerCount = results.filter(r => r === true).length;
            expect(triggerCount).toBeGreaterThanOrEqual(1);
            const skipCount = results.filter(r => r === false).length;
            expect(skipCount).toBeGreaterThanOrEqual(1);
        });

        it('devrait respecter la limite exacte de 15 minutes après premier trigger', async () => {
            const { getRooSyncService } = await import('../../services/lazy-roosync.js');
            const mockRegisterHeartbeat = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getRooSyncService).mockResolvedValue({
                registerHeartbeat: mockRegisterHeartbeat,
            } as any);

            initAutoHeartbeat();
            // First call triggers immediately (init with 0)
            const result0 = await autoHeartbeat('first');
            expect(result0).toBe(true);
            mockRegisterHeartbeat.mockClear();

            // 14min 59s after trigger — should skip
            vi.setSystemTime(new Date('2026-04-25T12:14:59Z'));
            const result1 = await autoHeartbeat('test');
            expect(result1).toBe(false);
            expect(mockRegisterHeartbeat).not.toHaveBeenCalled();

            // 15min 1s after trigger — should trigger
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

            // Premier appel à 12:00 — trigger (init with 0)
            vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
            const result1 = await autoHeartbeat('tool1');
            expect(result1).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

            // Deuxième appel à 12:16 — trigger (15+ min depuis dernier)
            vi.setSystemTime(new Date('2026-04-25T12:16:01Z'));
            const result2 = await autoHeartbeat('tool2');
            expect(result2).toBe(true);
            expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(2);

            // Troisième appel à 12:17 — skip (déjà fait heartbeat)
            vi.setSystemTime(new Date('2026-04-25T12:17:00Z'));
            const result3 = await autoHeartbeat('tool3');
            expect(result3).toBe(false);
        });
    });
});
