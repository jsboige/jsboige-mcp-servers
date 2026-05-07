/**
 * Noise filtering for Qdrant indexation (#1987 Phase 3a)
 *
 * Multi-criteria heuristic to identify low-value semantic tasks.
 * Sanctuary (.jsonl source) is NEVER touched — this only controls Qdrant indexation.
 *
 * Design principle: conservative combinations, not single indicators.
 * Size alone is NOT a noise criterion (user condition #1987 comment).
 */

import { SkeletonHeader } from '../types/conversation.js';

export interface NoiseFilterResult {
    isNoise: boolean;
    reason: string;
    /** Which criteria pattern matched */
    pattern?: 'blacklist' | 'scheduled-repetitive' | 'runaway-spiral' | 'cold-orphan';
}

/**
 * Recognized scheduled/automated mode names.
 * Tasks with these modes are typically repetitive with low semantic variability.
 */
const SCHEDULED_MODES = [
    'scheduled',
    'cron',
    'worker',
    'scheduler',
    'patrol',
    'meta-audit',
    'meta-analyst',
];

/**
 * TaskId prefixes that indicate automated/scheduled origin.
 */
const AUTOMATED_TASK_ID_PATTERNS = [
    /^worker-/i,
    /^scheduled-/i,
    /^patrol-/i,
    /^meta-audit-/i,
    /^meta-analyst-/i,
    /^auto-/i,
];

export class NoiseFilter {
    private blacklistedTaskIds: Set<string> = new Set();
    private blacklistLoaded = false;

    // Configurable thresholds via env vars
    private readonly scheduledAgeDays: number;
    private readonly scheduledMinMessages: number;
    private readonly runawayMessageThreshold: number;
    private readonly runawaySizeBytes: number;
    private readonly toolDominanceRatio: number;
    private readonly coldOrphanDays: number;
    private readonly coldOrphanMaxMessages: number;

    constructor() {
        this.scheduledAgeDays = parseInt(process.env.NOISE_FILTER_SCHEDULED_AGE_DAYS || '30', 10);
        this.scheduledMinMessages = parseInt(process.env.NOISE_FILTER_SCHEDULED_MIN_MESSAGES || '200', 10);
        this.runawayMessageThreshold = parseInt(process.env.NOISE_FILTER_RUNAWAY_MESSAGES || '10000', 10);
        this.runawaySizeBytes = parseInt(process.env.NOISE_FILTER_RUNAWAY_SIZE_MB || '100', 10) * 1024 * 1024;
        this.toolDominanceRatio = parseFloat(process.env.NOISE_FILTER_TOOL_RATIO || '0.85');
        this.coldOrphanDays = parseInt(process.env.NOISE_FILTER_COLD_ORPHAN_DAYS || '180', 10);
        this.coldOrphanMaxMessages = parseInt(process.env.NOISE_FILTER_COLD_ORPHAN_MAX_MSG || '5', 10);
    }

    /**
     * Load blacklisted task IDs from an array (typically loaded from shared state JSON).
     */
    loadBlacklist(taskIds: string[]): void {
        this.blacklistedTaskIds = new Set(taskIds);
        this.blacklistLoaded = true;
    }

    /**
     * Returns the current blacklist size (for diagnostics).
     */
    get blacklistSize(): number {
        return this.blacklistedTaskIds.size;
    }

    /**
     * Check if a task matches any noise pattern.
     * Returns result with reason and pattern name for audit logging.
     */
    isNoiseTask(skeleton: SkeletonHeader): NoiseFilterResult {
        if (!skeleton.metadata) {
            return { isNoise: false, reason: 'No metadata available for noise check' };
        }

        // Pattern 0: Blacklist (manual override, highest priority)
        if (this.blacklistedTaskIds.has(skeleton.taskId)) {
            return {
                isNoise: true,
                reason: `Task blacklisted (${this.blacklistedTaskIds.size} entries loaded)`,
                pattern: 'blacklist',
            };
        }

        const now = Date.now();
        const lastActivity = new Date(skeleton.metadata.lastActivity).getTime();
        const ageDays = (now - lastActivity) / (1000 * 60 * 60 * 24);
        const messageCount = skeleton.metadata.messageCount || 0;
        const actionCount = skeleton.metadata.actionCount || 0;
        const totalSize = skeleton.metadata.totalSize || 0;
        const mode = (skeleton.metadata.mode || '').toLowerCase();

        // Pattern 1: Scheduled repetitive
        // Must match BOTH: (mode OR taskId pattern) AND (age > threshold) AND (volume > threshold)
        const isScheduledMode = SCHEDULED_MODES.some(m => mode.includes(m));
        const isAutomatedId = AUTOMATED_TASK_ID_PATTERNS.some(p => p.test(skeleton.taskId));
        if ((isScheduledMode || isAutomatedId) && ageDays > this.scheduledAgeDays && messageCount > this.scheduledMinMessages) {
            return {
                isNoise: true,
                reason: `Scheduled repetitive: mode='${mode}', age=${Math.round(ageDays)}d, msgs=${messageCount}`,
                pattern: 'scheduled-repetitive',
            };
        }

        // Pattern 2: Runaway/error spiral
        // Must match BOTH: (huge volume) AND (tool-dominated content)
        const toolRatio = messageCount > 0 ? actionCount / messageCount : 0;
        const isHugeVolume = messageCount > this.runawayMessageThreshold || totalSize > this.runawaySizeBytes;
        if (isHugeVolume && toolRatio > this.toolDominanceRatio) {
            return {
                isNoise: true,
                reason: `Runaway spiral: msgs=${messageCount}, size=${Math.round(totalSize / 1024 / 1024)}MB, toolRatio=${toolRatio.toFixed(2)}`,
                pattern: 'runaway-spiral',
            };
        }

        // Pattern 3: Cold orphan (abandoned stubs)
        // Must match ALL: old + tiny + no parent
        if (ageDays > this.coldOrphanDays
            && messageCount < this.coldOrphanMaxMessages
            && !skeleton.parentTaskId) {
            return {
                isNoise: true,
                reason: `Cold orphan: age=${Math.round(ageDays)}d, msgs=${messageCount}, no parent`,
                pattern: 'cold-orphan',
            };
        }

        return { isNoise: false, reason: 'No noise pattern matched' };
    }
}
