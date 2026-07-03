/**
 * #833 Sprint C3 — NoiseFilter branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `noise-filter.test.ts` (21 tests) covers the four noise patterns and their
 * negative cases well, plus the no-metadata guard. It leaves three clusters cold, all
 * pinned here against source lines of `noise-filter.ts`:
 *
 * - **Constructor env-var overrides (L60-66)** — 7 thresholds are parsed from env
 *   (`NOISE_FILTER_SCHEDULED_AGE_DAYS`, `_MIN_MESSAGES`, `_RUNAWAY_MESSAGES`,
 *   `_RUNAWAY_SIZE_MB`, `_TOOL_RATIO`, `_COLD_ORPHAN_DAYS`, `_COLD_ORPHAN_MAX_MSG`).
 *   The base always uses defaults → every `process.env.X || 'default'` override arm is
 *   cold, AND the `* 1024 * 1024` MB→bytes conversion (L63) is never exercised with a
 *   custom value.
 * - **Reason-string contracts** — the base asserts `pattern` but never the `reason`
 *   format. Six reasons carry audit-logged detail: no-metadata (L90), blacklist count
 *   (L97), scheduled mode/age/msgs (L117), runaway msgs/size/ratio (L129), cold-orphan
 *   age/msgs (L141), and the no-match fallback (L146).
 * - **Untested pattern arms in the scheduled-repetitive matchers** — `SCHEDULED_MODES`
 *   (L24-32) has 7 entries; the base only exercises `mode: 'scheduled'` (exact). The
 *   `.includes(m)` substring semantics (L112) and the other 6 modes (`cron`, `worker`,
 *   `scheduler`, `patrol`, `meta-audit`, `meta-analyst`) are cold. `AUTOMATED_TASK_ID_
 *   PATTERNS` (L37-44) has 6 regexes; the base only exercises `^worker-`. The other 5
 *   (`scheduled-`, `patrol-`, `meta-audit-`, `meta-analyst-`, `auto-`) are cold.
 *
 * No production code touched (#1936 anti-churn).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { NoiseFilter } from '../noise-filter.js';
import type { SkeletonHeader } from '../../types/conversation.js';

function makeSkeleton(overrides: Partial<SkeletonHeader['metadata']> & {
    taskId?: string; parentTaskId?: string;
}): SkeletonHeader {
    return {
        taskId: overrides.taskId || 'cov-task-001',
        parentTaskId: overrides.parentTaskId,
        metadata: {
            lastActivity: overrides.lastActivity || new Date().toISOString(),
            createdAt: overrides.createdAt || new Date().toISOString(),
            messageCount: overrides.messageCount ?? 50,
            actionCount: overrides.actionCount ?? 20,
            totalSize: overrides.totalSize ?? 10000,
            mode: overrides.mode,
        },
    };
}

function daysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('NoiseFilter — branch coverage (#833 C3, source-grounded)', () => {
    const originalEnv = { ...process.env };
    const NOISE_ENV_KEYS = [
        'NOISE_FILTER_SCHEDULED_AGE_DAYS',
        'NOISE_FILTER_SCHEDULED_MIN_MESSAGES',
        'NOISE_FILTER_RUNAWAY_MESSAGES',
        'NOISE_FILTER_RUNAWAY_SIZE_MB',
        'NOISE_FILTER_TOOL_RATIO',
        'NOISE_FILTER_COLD_ORPHAN_DAYS',
        'NOISE_FILTER_COLD_ORPHAN_MAX_MSG',
    ];

    beforeEach(() => {
        for (const k of NOISE_ENV_KEYS) delete process.env[k];
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    // ============================================================
    // Constructor — env-var overrides (L60-66)
    // ============================================================
    describe('constructor — env-var overrides (L60-66)', () => {
        test('NOISE_FILTER_SCHEDULED_AGE_DAYS lowers the scheduled-repetitive age gate (L60)', () => {
            // Default age gate = 30d. Set to 5d → a 10d-old scheduled task with volume now matches.
            process.env.NOISE_FILTER_SCHEDULED_AGE_DAYS = '5';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                mode: 'scheduled', lastActivity: daysAgo(10), messageCount: 300,
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('scheduled-repetitive');
            // With the default 30d gate, the same skeleton would NOT match (10 < 30) — pin both.
            delete process.env.NOISE_FILTER_SCHEDULED_AGE_DAYS;
            const defaultFilter = new NoiseFilter();
            expect(defaultFilter.isNoiseTask(skeleton).isNoise).toBe(false);
        });

        test('NOISE_FILTER_SCHEDULED_MIN_MESSAGES lowers the volume gate (L61)', () => {
            process.env.NOISE_FILTER_SCHEDULED_MIN_MESSAGES = '50';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                mode: 'scheduled', lastActivity: daysAgo(60), messageCount: 100, // > 50 (custom), < 200 (default)
            });
            expect(filter.isNoiseTask(skeleton).isNoise).toBe(true);
        });

        test('NOISE_FILTER_RUNAWAY_MESSAGES lowers the runaway message gate (L62)', () => {
            process.env.NOISE_FILTER_RUNAWAY_MESSAGES = '100';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                messageCount: 500, actionCount: 480, totalSize: 10000, // ratio 0.96 > 0.85
            });
            // 500 > 100 (custom threshold) → huge-volume arm fires → runaway.
            expect(filter.isNoiseTask(skeleton).pattern).toBe('runaway-spiral');
        });

        test('NOISE_FILTER_RUNAWAY_SIZE_MB applies the *1024*1024 bytes conversion (L63)', () => {
            // Set size gate to 1 MB. A 2 MB task with tool dominance → runaway via the size arm.
            process.env.NOISE_FILTER_RUNAWAY_SIZE_MB = '1';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                messageCount: 10, actionCount: 10, totalSize: 2 * 1024 * 1024, // 2 MB > 1 MB gate
            });
            const result = filter.isNoiseTask(skeleton);
            expect(result.isNoise).toBe(true);
            expect(result.pattern).toBe('runaway-spiral');
            // The reason reports Math.round(totalSize/1024/1024) = 2 MB (L129).
            expect(result.reason).toContain('size=2MB');
        });

        test('NOISE_FILTER_TOOL_RATIO tightens the tool-dominance gate (L64)', () => {
            // Default ratio 0.85. Set to 0.5 → a 0.6-ratio huge task now matches.
            process.env.NOISE_FILTER_RUNAWAY_MESSAGES = '100';
            process.env.NOISE_FILTER_TOOL_RATIO = '0.5';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                messageCount: 200, actionCount: 120, totalSize: 10000, // ratio 0.6
            });
            expect(filter.isNoiseTask(skeleton).pattern).toBe('runaway-spiral');
            // With default 0.85, 0.6 would NOT match — pin.
            delete process.env.NOISE_FILTER_TOOL_RATIO;
            const defaultFilter = new NoiseFilter();
            expect(defaultFilter.isNoiseTask(skeleton).isNoise).toBe(false);
        });

        test('NOISE_FILTER_COLD_ORPHAN_DAYS lowers the cold-orphan age gate (L65)', () => {
            process.env.NOISE_FILTER_COLD_ORPHAN_DAYS = '10';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                lastActivity: daysAgo(20), messageCount: 2, // 20 > 10 (custom), < default 180
            });
            expect(filter.isNoiseTask(skeleton).pattern).toBe('cold-orphan');
        });

        test('NOISE_FILTER_COLD_ORPHAN_MAX_MSG raises the orphan message ceiling (L66)', () => {
            process.env.NOISE_FILTER_COLD_ORPHAN_DAYS = '10';
            process.env.NOISE_FILTER_COLD_ORPHAN_MAX_MSG = '20';
            const filter = new NoiseFilter();
            const skeleton = makeSkeleton({
                lastActivity: daysAgo(20), messageCount: 10, // 10 < 20 (custom ceiling), > default 5
            });
            expect(filter.isNoiseTask(skeleton).pattern).toBe('cold-orphan');
        });
    });

    // ============================================================
    // Reason-string contracts (L90, L97, L117, L129, L141, L146)
    // ============================================================
    describe('reason-string contracts', () => {
        test('no-metadata reason (L90)', () => {
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask({ taskId: 'x', metadata: undefined } as SkeletonHeader);
            expect(result.reason).toBe('No metadata available for noise check');
        });

        test('blacklist reason includes the loaded-entry count (L97)', () => {
            const filter = new NoiseFilter();
            filter.loadBlacklist(['a', 'b', 'c']);
            const result = filter.isNoiseTask(makeSkeleton({ taskId: 'a' }));
            // L97: `Task blacklisted (${size} entries loaded)`
            expect(result.reason).toBe('Task blacklisted (3 entries loaded)');
        });

        test('scheduled-repetitive reason includes mode/age/msgs (L117)', () => {
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({
                mode: 'scheduled', lastActivity: daysAgo(60), messageCount: 500,
            }));
            // L117: `Scheduled repetitive: mode='${mode}', age=${round}d, msgs=${count}`
            expect(result.reason).toContain("mode='scheduled'");
            expect(result.reason).toContain('age=60d');
            expect(result.reason).toContain('msgs=500');
        });

        test('runaway-spiral reason includes msgs/size/ratio (L129)', () => {
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({
                messageCount: 15000, actionCount: 13500, totalSize: 200 * 1024 * 1024,
            }));
            // ratio = 13500/15000 = 0.90 → toFixed(2) = '0.90'
            expect(result.reason).toContain('msgs=15000');
            expect(result.reason).toContain('size=200MB');
            expect(result.reason).toContain('toolRatio=0.90');
        });

        test('cold-orphan reason includes age/msgs/no-parent (L141)', () => {
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({
                lastActivity: daysAgo(200), messageCount: 2,
            }));
            expect(result.reason).toContain('age=200d');
            expect(result.reason).toContain('msgs=2');
            expect(result.reason).toContain('no parent');
        });

        test('no-match reason (L146)', () => {
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({ mode: 'code', messageCount: 100 }));
            expect(result.reason).toBe('No noise pattern matched');
        });
    });

    // ============================================================
    // Untested SCHEDULED_MODES + substring semantics (L112, L24-32)
    // ============================================================
    describe('SCHEDULED_MODES — other modes + substring match (L112)', () => {
        const otherModes: Array<[string, string]> = [
            ['cron', 'cron'],
            ['worker', 'worker'],
            ['scheduler', 'scheduler'],
            ['patrol', 'patrol'],
            ['meta-audit', 'meta-audit'],
            ['meta-analyst', 'meta-analyst'],
        ];
        for (const [label, mode] of otherModes) {
            test(`mode '${label}' triggers scheduled-repetitive (L112 SCHEDULED_MODES)`, () => {
                const filter = new NoiseFilter();
                const result = filter.isNoiseTask(makeSkeleton({
                    mode, lastActivity: daysAgo(60), messageCount: 500,
                }));
                expect(result.isNoise).toBe(true);
                expect(result.pattern).toBe('scheduled-repetitive');
            });
        }

        test('substring match: mode containing a scheduled keyword matches (L112 .includes)', () => {
            // `.includes(m)` → 'my-custom-cron-job' contains 'cron' → match. Base only used exact 'scheduled'.
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({
                mode: 'my-custom-cron-job', lastActivity: daysAgo(60), messageCount: 500,
            }));
            expect(result.pattern).toBe('scheduled-repetitive');
        });

        test('mode matching is case-insensitive (L108 .toLowerCase + L112)', () => {
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({
                mode: 'SCHEDULED', lastActivity: daysAgo(60), messageCount: 500,
            }));
            expect(result.pattern).toBe('scheduled-repetitive');
        });
    });

    // ============================================================
    // Untested AUTOMATED_TASK_ID_PATTERNS (L113, L37-44)
    // ============================================================
    describe('AUTOMATED_TASK_ID_PATTERNS — other prefixes (L113)', () => {
        const otherPrefixes = ['scheduled-', 'patrol-', 'meta-audit-', 'meta-analyst-', 'auto-'];
        for (const prefix of otherPrefixes) {
            test(`taskId '${prefix}...' triggers scheduled-repetitive (L113)`, () => {
                const filter = new NoiseFilter();
                const result = filter.isNoiseTask(makeSkeleton({
                    taskId: `${prefix}task-001`, lastActivity: daysAgo(60), messageCount: 500,
                }));
                expect(result.isNoise).toBe(true);
                expect(result.pattern).toBe('scheduled-repetitive');
            });
        }

        test('automated-id match works without any mode set (L113 OR arm)', () => {
            // isScheduledMode=false (no mode) BUT isAutomatedId=true → the `(isScheduledMode || isAutomatedId)`
            // arm fires. Base 'worker-' test sets no mode, but only covers one prefix.
            const filter = new NoiseFilter();
            const result = filter.isNoiseTask(makeSkeleton({
                taskId: 'auto-recovery-9', lastActivity: daysAgo(60), messageCount: 500,
            }));
            expect(result.pattern).toBe('scheduled-repetitive');
        });
    });
});
