import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeathSpiralDetector } from '../death-spiral-detector.js';
import { ConversationSkeleton, MessageSkeleton } from '../../types/conversation.js';

// Build a ConversationSkeleton with the real type structure:
// sequence: (MessageSkeleton | ActionMetadata)[]
// MessageSkeleton: { role, content: string, timestamp: string, isTruncated }
function makeSkeleton(entries: Partial<MessageSkeleton>[]): ConversationSkeleton {
	return {
		taskId: 'test-task-id',
		metadata: {
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			messageCount: entries.length,
			actionCount: 0,
			totalSize: 0,
		},
		sequence: entries.map((e) => ({
			role: e.role ?? 'user',
			content: e.content ?? '',
			timestamp: e.timestamp ?? new Date().toISOString(),
			isTruncated: false,
		})) as MessageSkeleton[],
	};
}

function msg(role: 'user' | 'assistant', text: string, timestampMs: number): Partial<MessageSkeleton> {
	return {
		role,
		content: text,
		timestamp: new Date(timestampMs).toISOString(),
	};
}

function userMsg(text: string, ts: number) { return msg('user', text, ts); }
function assistantMsg(text: string, ts: number) { return msg('assistant', text, ts); }
function errorMsg(text: string, ts: number) { return msg('user', text, ts); }

const NOW = new Date('2026-04-28T12:00:00Z').getTime();

describe('DeathSpiralDetector', () => {
	let cache: Map<string, ConversationSkeleton>;

	beforeEach(() => {
		cache = new Map();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('healthy tasks', () => {
		it('should return empty results for healthy tasks', async () => {
			cache.set('healthy-task', makeSkeleton([
				assistantMsg('Working on task...', NOW - 60000),
				userMsg('Good progress', NOW - 30000),
				assistantMsg('Completed', NOW),
			]));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['healthy-task'], cache);

			expect(result.deathSpirals).toHaveLength(0);
			expect(result.tasksAtRisk).toHaveLength(0);
			expect(result.immediateActions).toHaveLength(0);
			expect(result.recommendations).toHaveLength(1);
			expect(result.recommendations[0]).toContain('Aucun death spiral');
		});

		it('should skip tasks not in cache', async () => {
			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['missing-task'], cache);

			expect(result.deathSpirals).toHaveLength(0);
			expect(result.tasksAtRisk).toHaveLength(0);
			expect(result.immediateActions).toHaveLength(0);
		});
	});

	describe('death spiral detection', () => {
		it('should detect death spiral with 10 errors, 0 assistant output', async () => {
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 10; i++) {
				entries.push(errorMsg('502 Bad Gateway error', NOW - (10 - i) * 60000));
			}
			cache.set('spiral-task', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['spiral-task'], cache);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].taskId).toBe('spiral-task');
			expect(result.deathSpirals[0].errorCount).toBe(10);
			expect(result.deathSpirals[0].errorRatio).toBe(1.0);
			expect(result.deathSpirals[0].assistantOutputCount).toBe(0);
			expect(result.deathSpirals[0].assistantOutputRatio).toBe(0);
			expect(result.deathSpirals[0].riskLevel).toBe('CRITICAL');
			expect(result.immediateActions).toHaveLength(1);
			expect(result.immediateActions[0].action).toBe('terminate');
			expect(result.immediateActions[0].taskId).toBe('spiral-task');
		});

		it('should produce CRITICAL for 15 consecutive errors with ratio > 0.9', async () => {
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 15; i++) {
				entries.push(errorMsg('502 Bad Gateway timeout error retry', NOW - (15 - i) * 120000));
			}
			cache.set('critical-task', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['critical-task'], cache);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].riskLevel).toBe('CRITICAL');
			expect(result.deathSpirals[0].errorCount).toBe(15);
			expect(result.deathSpirals[0].errorRatio).toBe(1.0);
			expect(result.immediateActions).toHaveLength(1);
			expect(result.immediateActions[0].action).toBe('terminate');
			expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
			expect(result.recommendations[0]).toContain('death spiral');
		});

		it('should NOT detect spiral when errorRatio < threshold (below 80%)', async () => {
			// 6 errors + 4 assistant = 60% error ratio, below 80% threshold
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 6; i++) {
				entries.push(errorMsg('502 Bad Gateway', NOW - (10 - i) * 60000));
			}
			for (let i = 0; i < 4; i++) {
				entries.push(assistantMsg('Processing data...', NOW - (4 - i) * 60000));
			}
			cache.set('moderate-task', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['moderate-task'], cache);

			// 6/10 = 0.6 < 0.8 threshold → NOT a death spiral
			expect(result.deathSpirals).toHaveLength(0);
		});

		it('should NOT detect spiral when totalMessages < 10 (size criteria)', async () => {
			// Only 5 messages, all errors — ratio is 100% but too few messages
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 5; i++) {
				entries.push(errorMsg('502 Bad Gateway', NOW - (5 - i) * 60000));
			}
			cache.set('small-task', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['small-task'], cache);

			expect(result.deathSpirals).toHaveLength(0);
		});
	});

	describe('error pattern detection', () => {
		it('should detect 502 Bad Gateway and report in triggers', async () => {
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 12; i++) {
				entries.push(errorMsg('Got 502 Bad Gateway from server', NOW - (12 - i) * 300000));
			}
			cache.set('task-502', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['task-502'], cache);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].lastError).toContain('502 Bad Gateway');
			expect(result.deathSpirals[0].triggers).toEqual(
				expect.arrayContaining([expect.stringContaining('502 Bad Gateway')]),
			);
		});

		it('should detect timeout errors', async () => {
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 10; i++) {
				entries.push(errorMsg('Request timeout after 30000ms', NOW - (10 - i) * 300000));
			}
			cache.set('task-timeout', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['task-timeout'], cache);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].errorCount).toBe(10);
			expect(result.deathSpirals[0].lastError).toContain('timeout');
		});

		it('should detect MCP errors', async () => {
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 10; i++) {
				entries.push(errorMsg('MCP error: tool not found', NOW - (10 - i) * 300000));
			}
			cache.set('task-mcp', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['task-mcp'], cache);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].errorCount).toBe(10);
			expect(result.deathSpirals[0].triggers).toEqual(
				expect.arrayContaining([expect.stringContaining('MCP Error')]),
			);
		});

		it('should detect rate limit errors', async () => {
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 10; i++) {
				entries.push(errorMsg('rate limit exceeded', NOW - (10 - i) * 300000));
			}
			cache.set('task-ratelimit', makeSkeleton(entries));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['task-ratelimit'], cache);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].errorCount).toBe(10);
			expect(result.deathSpirals[0].triggers).toEqual(
				expect.arrayContaining([expect.stringContaining('Rate Limit')]),
			);
		});
	});

	describe('threshold customization', () => {
		it('strict thresholds detect spirals that loose thresholds miss', async () => {
			// 10 messages: 9 errors + 1 assistant = 0.9 error ratio, 0.1 assistant ratio
			const entries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 9; i++) {
				entries.push(errorMsg('502 Bad Gateway', NOW - (9 - i) * 30000));
			}
			entries.push(assistantMsg('one output', NOW));
			cache.set('custom-task-10', makeSkeleton(entries));

			const strictResult = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
				['custom-task-10'],
				cache,
				{ errorRatio: 0.5, assistantOutputRatio: 0.5, consecutiveErrors: 1, rapidErrorCount: 1, timeWindowMinutes: 60 },
			);

			const looseResult = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
				['custom-task-10'],
				cache,
				{ errorRatio: 0.99, assistantOutputRatio: 0.01, consecutiveErrors: 100, rapidErrorCount: 100, timeWindowMinutes: 1 },
			);

			// Strict: 0.9 >= 0.5, 0.1 < 0.5, consecutiveErrors=9 >= 1 → YES
			expect(strictResult.deathSpirals).toHaveLength(1);
			// Loose: 0.9 < 0.99 → NO (fails ratio criteria)
			expect(looseResult.deathSpirals).toHaveLength(0);
			// Strict detects strictly more
			expect(strictResult.deathSpirals.length).toBeGreaterThan(looseResult.deathSpirals.length);
		});
	});

	describe('edge cases', () => {
		it('should return empty results for empty sequence', async () => {
			cache.set('empty-task', makeSkeleton([]));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['empty-task'], cache);

			expect(result.deathSpirals).toHaveLength(0);
			expect(result.tasksAtRisk).toHaveLength(0);
			expect(result.immediateActions).toHaveLength(0);
		});

		it('should handle empty content strings', async () => {
			cache.set('empty-content', makeSkeleton([
				{ role: 'user', content: '', timestamp: new Date(NOW).toISOString() },
				{ role: 'assistant', content: '', timestamp: new Date(NOW).toISOString() },
			]));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(['empty-content'], cache);

			expect(result.deathSpirals).toHaveLength(0);
		});

		it('should analyze multiple tasks in one call', async () => {
			const spiralEntries: Partial<MessageSkeleton>[] = [];
			for (let i = 0; i < 12; i++) {
				spiralEntries.push(errorMsg('502 Bad Gateway', NOW - (12 - i) * 300000));
			}
			cache.set('task-spiral', makeSkeleton(spiralEntries));
			cache.set('task-healthy', makeSkeleton([assistantMsg('Healthy output', NOW)]));
			cache.set('task-empty', makeSkeleton([]));

			const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
				['task-spiral', 'task-healthy', 'task-empty', 'missing-task'],
				cache,
			);

			expect(result.deathSpirals).toHaveLength(1);
			expect(result.deathSpirals[0].taskId).toBe('task-spiral');
			expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
		});
	});
});
