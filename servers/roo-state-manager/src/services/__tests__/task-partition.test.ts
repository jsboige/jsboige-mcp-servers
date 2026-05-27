import { describe, it, expect } from 'vitest';
import { fnv1a32, parseFleetRoster, getTaskOwner, shouldIndexTask } from '../task-partition.js';

describe('task-partition', () => {
	describe('fnv1a32', () => {
		it('returns deterministic hash for same input', () => {
			expect(fnv1a32('task-abc')).toBe(fnv1a32('task-abc'));
		});

		it('returns different hashes for different inputs', () => {
			expect(fnv1a32('task-abc')).not.toBe(fnv1a32('task-def'));
		});

		it('returns unsigned 32-bit integer', () => {
			const hash = fnv1a32('any-input');
			expect(hash).toBeGreaterThanOrEqual(0);
			expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
			expect(Number.isInteger(hash)).toBe(true);
		});
	});

	describe('parseFleetRoster', () => {
		it('returns null for undefined', () => {
			expect(parseFleetRoster(undefined)).toBeNull();
		});

		it('returns null for empty string', () => {
			expect(parseFleetRoster('')).toBeNull();
			expect(parseFleetRoster('   ')).toBeNull();
		});

		it('parses comma-separated machines', () => {
			const roster = parseFleetRoster('myia-po-2023,myia-po-2026');
			expect(roster).toEqual(['myia-po-2023', 'myia-po-2026']);
		});

		it('sorts alphabetically and deduplicates', () => {
			const roster = parseFleetRoster('myia-web1,myia-ai-01,myia-web1,myia-po-2023');
			expect(roster).toEqual(['myia-ai-01', 'myia-po-2023', 'myia-web1']);
		});

		it('normalizes to lowercase', () => {
			const roster = parseFleetRoster('MyIA-AI-01,MYIA-WEB1');
			expect(roster).toEqual(['myia-ai-01', 'myia-web1']);
		});

		it('trims whitespace', () => {
			const roster = parseFleetRoster(' myia-ai-01 , myia-web1 ');
			expect(roster).toEqual(['myia-ai-01', 'myia-web1']);
		});
	});

	describe('getTaskOwner', () => {
		it('returns null for null roster', () => {
			expect(getTaskOwner('task-123', null)).toBeNull();
		});

		it('returns null for empty roster', () => {
			expect(getTaskOwner('task-123', [])).toBeNull();
		});

		it('returns a machine from the roster', () => {
			const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2026'];
			const owner = getTaskOwner('task-123', roster);
			expect(roster).toContain(owner);
		});

		it('distributes tasks across roster members', () => {
			const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2026', 'myia-web1'];
			const owners = new Set<string>();
			for (let i = 0; i < 100; i++) {
				owners.add(getTaskOwner(`task-${i}`, roster)!);
			}
			// With 100 tasks and 4 machines, we expect at least 2 distinct owners
			expect(owners.size).toBeGreaterThanOrEqual(2);
		});
	});

	describe('shouldIndexTask', () => {
		it('returns true when no roster (partition disabled)', () => {
			expect(shouldIndexTask('task-123', 'myia-po-2026', null)).toBe(true);
			expect(shouldIndexTask('task-123', 'myia-po-2026', [])).toBe(true);
		});

		it('returns true when machine owns the task', () => {
			const roster = ['myia-ai-01', 'myia-po-2026'];
			const owner = getTaskOwner('task-123', roster);
			expect(shouldIndexTask('task-123', owner!, roster)).toBe(true);
		});

		it('returns false when machine does not own the task', () => {
			const roster = ['myia-ai-01', 'myia-po-2026'];
			const owner = getTaskOwner('task-123', roster);
			const otherMachine = roster.find(m => m !== owner)!;
			expect(shouldIndexTask('task-123', otherMachine, roster)).toBe(false);
		});

		it('every task is owned by exactly one machine', () => {
			const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];
			for (let i = 0; i < 200; i++) {
				const taskId = `task-${i}`;
				let owners = 0;
				for (const machine of roster) {
					if (shouldIndexTask(taskId, machine, roster)) owners++;
				}
				expect(owners, `Task ${taskId} should have exactly 1 owner`).toBe(1);
			}
		});
	});
});
