/**
 * Coverage complement for format-hierarchical-tree.ts (#833 C3)
 *
 * The nominal suite (format-hierarchical-tree.test.ts, #492) covers the happy
 * rendering paths but leaves a silent-swap contract UNTVERIFIED:
 *
 *   - getModeEmoji (L24-35): branch coverage is 100% (object-literal entries
 *     are not counted as branches — only lookup-found vs default), so coverage
 *     tools report it "covered" after testing just `code`. But the SPECIFIC
 *     emoji character for each of the 7 modes is never asserted — only the
 *     mode *name* is checked. A regression swapping `'debug': '🪲'` → `'🐛'`
 *     would pass silently. This is the same silent-swap class as #728
 *     (NotificationService emoji mapping): deterministic per-enum output read
 *     by the UX. This file locks each mapping explicitly.
 *
 *   - formatDate (L40-50): the invalid-date arm at L43-44 (`isNaN → return
 *     dateStr`) is cold — every nominal fixture passes a valid ISO timestamp.
 *     The catch arm at L47-49 is unreachable-defensive (`new Date(string)`
 *     never throws — it returns Invalid Date), documented here as
 *     skip-with-evidence (#1936).
 *
 * Source-grounded: every assertion cites the source line whose contract it
 * locks. Tests-only, 0 source change.
 *
 * @module tools/task/__tests__/format-hierarchical-tree.coverage
 */

import { describe, test, expect } from 'vitest';
import { formatTaskTreeHierarchical } from '../format-hierarchical-tree.js';
import type { TaskTreeNode } from '../format-ascii-tree.js';

// Minimal node factory — only the fields read by the render path.
function node(mode: string, extra?: Partial<TaskTreeNode['metadata']>): TaskTreeNode {
	return {
		taskId: 't1',
		taskIdShort: 't1',
		title: 'Title',
		metadata: {
			isCompleted: false,
			truncatedInstruction: 'instr',
			messageCount: 0,
			totalSizeKB: 0,
			createdAt: '2026-02-22T09:00:00Z',
			mode,
			workspace: '/w',
			childrenCount: 0,
			depth: 0,
			...extra
		},
		children: []
	};
}

describe('format-hierarchical-tree — coverage complement (#833 C3)', () => {
	// ============================================================
	// getModeEmoji (L24-35) — silent-swap contract (#728 class).
	// Each mode must map to its SPECIFIC emoji, asserted by character.
	// The emoji is interpolated at L158:
	//   `${headerLevel} ${node.title} ${modeEmoji} ${instruction} (${mode})`
	// ============================================================
	describe('getModeEmoji — exact emoji per mode (L24-34, silent-swap #728 class)', () => {
		test('code → 💻', () => {
			expect(formatTaskTreeHierarchical(node('code'))).toContain('💻');
		});
		test('debug → 🪲', () => {
			expect(formatTaskTreeHierarchical(node('debug'))).toContain('🪲');
		});
		test('architect → 🏗️', () => {
			expect(formatTaskTreeHierarchical(node('architect'))).toContain('🏗️');
		});
		test('ask → ❓', () => {
			expect(formatTaskTreeHierarchical(node('ask'))).toContain('❓');
		});
		test('orchestrator → 🪃', () => {
			expect(formatTaskTreeHierarchical(node('orchestrator'))).toContain('🪃');
		});
		test('manager → 👨💼', () => {
			expect(formatTaskTreeHierarchical(node('manager'))).toContain('👨💼');
		});
		test('project-manager → 🏢', () => {
			expect(formatTaskTreeHierarchical(node('project-manager'))).toContain('🏢');
		});

		// L34: `modeMap[mode.toLowerCase()] || '📍'` — default fallback emoji.
		test('unknown mode → 📍 (default fallback, L34)', () => {
			expect(formatTaskTreeHierarchical(node('nonexistent-mode'))).toContain('📍');
		});

		// L34 `.toLowerCase()` — case-insensitivity contract.
		test('uppercase mode is lowercased before lookup (L34 .toLowerCase())', () => {
			// 'CODE' must still resolve to the 💻 emoji via .toLowerCase().
			expect(formatTaskTreeHierarchical(node('CODE'))).toContain('💻');
			expect(formatTaskTreeHierarchical(node('DEBUG'))).toContain('🪲');
		});
	});

	// ============================================================
	// formatDate (L40-50) — invalid-date defensive arm.
	// L43-44: `if (isNaN(date.getTime())) return dateStr` — cold because every
	// nominal fixture passes a valid ISO timestamp. The contract: a malformed
	// date string must be returned AS-IS rather than breaking the formatter.
	// (L47-49 catch is unreachable — `new Date(string)` never throws.)
	// ============================================================
	describe('formatDate — invalid-date arm (L43-44)', () => {
		test('returns malformed date string unchanged (L43-44)', () => {
			// 'Created:' line is rendered at L163:
			//   `**Created:** ${formatDate(node.metadata?.createdAt ?? 'Unknown')} |`
			// NOTE: V8 leniently parses date-like substrings (e.g. 'foo-2026'
			// → year inference), so use a definitively non-date string. Verified:
			// new Date('garbage') → Invalid Date → isNaN true → returns input.
			const garbage = 'garbage';
			const result = formatTaskTreeHierarchical(
				node('code', { createdAt: garbage })
			);
			// Invalid date → formatDate returns the input string verbatim.
			expect(result).toContain(`**Created:** ${garbage}`);
		});

		test('returns empty-string date unchanged (L43-44, empty is also Invalid Date)', () => {
			// new Date('') → Invalid Date → isNaN true → returns ''.
			const result = formatTaskTreeHierarchical(
				node('code', { createdAt: '' })
			);
			expect(result).toContain('**Created:**  |');
		});
	});

	// ============================================================
	// formatTaskNode — `?? 0` defensive fallbacks (L163-165).
	// Cold because the nominal factory always sets messageCount/totalSizeKB.
	// ============================================================
	describe('formatTaskNode — metadata-absent ?? 0 fallbacks (L163-165)', () => {
		test('defaults messageCount to 0 when absent', () => {
			const result = formatTaskTreeHierarchical({
				taskId: 't1', taskIdShort: 't1', title: 'T',
				metadata: { mode: 'code', createdAt: '2026-01-01' } as any,
				children: []
			});
			expect(result).toContain('**Messages:** 0');
		});
		test('defaults totalSizeKB to 0 when absent', () => {
			const result = formatTaskTreeHierarchical({
				taskId: 't1', taskIdShort: 't1', title: 'T',
				metadata: { mode: 'code', createdAt: '2026-01-01' } as any,
				children: []
			});
			expect(result).toContain('**Size:** 0 KB');
		});
		test('defaults childrenCount to 0 when absent (L175)', () => {
			const result = formatTaskTreeHierarchical({
				taskId: 't1', taskIdShort: 't1', title: 'T',
				metadata: { mode: 'code', createdAt: '2026-01-01' } as any,
				children: []
			});
			expect(result).toContain('### Children: 0');
		});
	});

	// ============================================================
	// getMaxDepth (L93) — `node.metadata?.depth ?? 0` fallback on a leaf.
	// Cold when depth is absent on a childless node.
	// ============================================================
	describe('getMaxDepth — depth ?? 0 fallback (L93, leaf node)', () => {
		test('depth defaults to 0 when absent on leaf node', () => {
			// Leaf node, no children, no depth → getMaxDepth returns ?? 0.
			// Profondeur maximale = 0 + 1 = 1 niveau (L104).
			const result = formatTaskTreeHierarchical({
				taskId: 't1', taskIdShort: 't1', title: 'T',
				metadata: { mode: 'code', createdAt: '2026-01-01' } as any,
				children: []
			});
			expect(result).toContain('Profondeur maximale** : 1 niveaux');
		});
	});
});
