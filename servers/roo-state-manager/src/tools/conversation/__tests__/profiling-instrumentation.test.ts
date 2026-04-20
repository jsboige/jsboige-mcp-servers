/**
 * Tests pour profiling-instrumentation.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROFILING_PHASES, logProfilingReport } from '../profiling-instrumentation';

describe('profiling-instrumentation', () => {
    describe('PROFILING_PHASES', () => {
        it('devrait avoir toutes les phases de profiling définies', () => {
            expect(PROFILING_PHASES.DISK_SCAN_ROO).toBe('diskScanRoo');
            expect(PROFILING_PHASES.CLAUDE_SESSION_SCAN).toBe('claudeSessionScan');
            expect(PROFILING_PHASES.WORKSPACE_FILTER).toBe('workspaceFilter');
            expect(PROFILING_PHASES.PENDING_SUBTASK_FILTER).toBe('pendingSubtaskFilter');
            expect(PROFILING_PHASES.CONTENT_PATTERN_FILTER).toBe('contentPatternFilter');
            expect(PROFILING_PHASES.SORTING).toBe('sorting');
            expect(PROFILING_PHASES.SKELETON_NODE_CREATION).toBe('skeletonNodeCreation');
            expect(PROFILING_PHASES.SYNTHESIS_DETECTION).toBe('synthesisDetection');
            expect(PROFILING_PHASES.PAGINATION_SERIALIZATION).toBe('paginationSerialization');
            expect(PROFILING_PHASES.TOTAL_HANDLER_TIME).toBe('totalHandlerTime');
        });

        it('devrait être un objet immutable (as const)', () => {
            // Vérifier que l'objet a les propriétés attendues
            expect(Object.keys(PROFILING_PHASES)).toHaveLength(10);
            expect(Object.keys(PROFILING_PHASES)).toContain('DISK_SCAN_ROO');
            expect(Object.keys(PROFILING_PHASES)).toContain('TOTAL_HANDLER_TIME');
        });

        it('devrait avoir des valeurs de chaîne valides', () => {
            const values = Object.values(PROFILING_PHASES);
            values.forEach(value => {
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            });
        });
    });

    describe('logProfilingReport', () => {
        let consoleLogSpy: any;

        beforeEach(() => {
            // Espionner console.log pour vérifier les appels
            consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleLogSpy.mockRestore();
        });

        it('devrait logger un rapport de profiling complet', () => {
            const timings = {
                totalHandlerTime: 1000,
                diskScanRoo: 200,
                claudeSessionScan: 150,
                workspaceFilter: 50,
                pendingSubtaskFilter: 30,
                contentPatternFilter: 40,
                sorting: 20,
                skeletonNodeCreation: 100,
                synthesisDetection: 50,
                paginationSerialization: 30,
            };

            const metadata = {
                totalSkeletons: 100,
                cacheHit: true,
            };

            logProfilingReport(timings, metadata);

            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
            const loggedMessage = consoleLogSpy.mock.calls[0][0];

            expect(loggedMessage).toContain('conversation_browser(list) - Performance Report');
            expect(loggedMessage).toContain('1000 ms');
            expect(loggedMessage).toContain('Total skeletons processed: 100');
            expect(loggedMessage).toContain('Cache hit rate: 100%');
            expect(loggedMessage).toContain('(cache hit)');
        });

        it('devrait gérer les timings manquants avec N/A', () => {
            const timings = {
                totalHandlerTime: 500,
                // timings partiels
                diskScanRoo: 100,
            };

            const metadata = {
                totalSkeletons: 50,
            };

            logProfilingReport(timings, metadata);

            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
            const loggedMessage = consoleLogSpy.mock.calls[0][0];

            expect(loggedMessage).toContain('500 ms');
            expect(loggedMessage).toContain('100 ms');
            expect(loggedMessage).toContain('N/A'); // pour les timings manquants
            expect(loggedMessage).toContain('Cache hit rate: 0%'); // pas de cacheHit
        });

        it('devrait afficher "cache miss" quand cacheHit est false', () => {
            const timings = {
                totalHandlerTime: 800,
                diskScanRoo: 200,
            };

            const metadata = {
                totalSkeletons: 75,
                cacheHit: false,
            };

            logProfilingReport(timings, metadata);

            const loggedMessage = consoleLogSpy.mock.calls[0][0];
            expect(loggedMessage).toContain('(cache miss)');
            expect(loggedMessage).toContain('Cache hit rate: 0%');
        });

        it('devrait formater correctement le rapport avec des timings zéro', () => {
            const timings = {
                totalHandlerTime: 0,
                diskScanRoo: 0,
                claudeSessionScan: 0,
            };

            const metadata = {
                totalSkeletons: 0,
                cacheHit: false,
            };

            logProfilingReport(timings, metadata);

            const loggedMessage = consoleLogSpy.mock.calls[0][0];
            expect(loggedMessage).toContain('0 ms');
            expect(loggedMessage).toContain('Total skeletons processed: 0');
        });

        it('devrait inclure toutes les phases de profiling dans le rapport', () => {
            const timings = {
                totalHandlerTime: 1000,
            };

            const metadata = {
                totalSkeletons: 10,
            };

            logProfilingReport(timings, metadata);

            const loggedMessage = consoleLogSpy.mock.calls[0][0];

            // Vérifier que toutes les phases sont mentionnées
            expect(loggedMessage).toContain(PROFILING_PHASES.DISK_SCAN_ROO);
            expect(loggedMessage).toContain(PROFILING_PHASES.CLAUDE_SESSION_SCAN);
            expect(loggedMessage).toContain(PROFILING_PHASES.WORKSPACE_FILTER);
            expect(loggedMessage).toContain(PROFILING_PHASES.PENDING_SUBTASK_FILTER);
            expect(loggedMessage).toContain(PROFILING_PHASES.CONTENT_PATTERN_FILTER);
            expect(loggedMessage).toContain(PROFILING_PHASES.SORTING);
            expect(loggedMessage).toContain(PROFILING_PHASES.SKELETON_NODE_CREATION);
            expect(loggedMessage).toContain(PROFILING_PHASES.SYNTHESIS_DETECTION);
            expect(loggedMessage).toContain(PROFILING_PHASES.PAGINATION_SERIALIZATION);
        });
    });
});
