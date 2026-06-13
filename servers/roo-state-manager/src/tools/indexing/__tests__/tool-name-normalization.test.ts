/**
 * Tests for normalizeToolName — #2336 tool_usage_stats key normalization.
 *
 * Bug (reported ai-01 2026-06-10): the same tool was counted under 3 distinct
 * key variants (`mcp__srv__tool` / `mcp--srv--tool` / bare `tool`), inflating
 * unique_tools (~103 vs ~15 real) and fragmenting per-tool totals.
 *
 * @module tools/indexing/__tests__/tool-name-normalization
 */

import { describe, test, expect } from 'vitest';
import { normalizeToolName } from '../roosync-indexing.tool.js';

describe('normalizeToolName (#2336 — canonical tool key)', () => {
	test('strips Claude Code double-underscore prefix', () => {
		expect(normalizeToolName('mcp__roo-state-manager__roosync_dashboard')).toBe('roosync_dashboard');
		expect(normalizeToolName('mcp__playwright__browser_click')).toBe('browser_click');
	});

	test('strips double-dash variant prefix', () => {
		expect(normalizeToolName('mcp--roo-state-manager--roosync_dashboard')).toBe('roosync_dashboard');
		expect(normalizeToolName('mcp--win-cli--execute_command')).toBe('execute_command');
	});

	test('converges all variants of the same tool to one canonical key', () => {
		// Regression: before the fix these three counted as distinct tools.
		const variants = [
			'mcp__roo-state-manager__roosync_dashboard',
			'mcp--roo-state-manager--roosync_dashboard',
			'roosync_dashboard',
		];
		const canonical = new Set(variants.map(normalizeToolName));
		expect(canonical.size).toBe(1);
		expect([...canonical][0]).toBe('roosync_dashboard');
	});

	test('handles server names containing the separator char (4_5v_mcp)', () => {
		// Server `4_5v_mcp` contains underscores — naive `mcp__[^_]+__` regex
		// would fail; split-and-take-last is robust.
		expect(normalizeToolName('mcp__4_5v_mcp__analyze_image')).toBe('analyze_image');
		expect(normalizeToolName('mcp--4_5v_mcp--analyze_image')).toBe('analyze_image');
	});

	test('passes built-in and bare tool names through unchanged', () => {
		expect(normalizeToolName('Bash')).toBe('Bash');
		expect(normalizeToolName('Read')).toBe('Read');
		expect(normalizeToolName('TodoWrite')).toBe('TodoWrite');
		expect(normalizeToolName('roosync_search')).toBe('roosync_search');
	});

	test('trims surrounding whitespace', () => {
		expect(normalizeToolName('  mcp__searxng__searxng_web_search  ')).toBe('searxng_web_search');
	});

	test('handles multi-segment server names (roo-state-manager has dashes)', () => {
		// double-dash split: 'mcp--roo--state--manager--roosync_dashboard'
		// → last segment is the tool name.
		expect(normalizeToolName('mcp--roo-state-manager--roosync_messages')).toBe('roosync_messages');
	});

	test('returns empty string fallback preserves original on malformed input', () => {
		// 'mcp__' alone → split yields ['mcp', ''] → last is '' → fallback to original
		expect(normalizeToolName('mcp__')).toBe('mcp__');
		expect(normalizeToolName('')).toBe('');
	});
});
