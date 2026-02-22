/**
 * Tests pour ui-message-extractor.ts
 * Issue #492 - Couverture des extracteurs de patterns
 *
 * @module utils/extractors/__tests__/ui-message-extractor
 */

import { describe, test, expect } from 'vitest';
import {
	UiAskToolExtractor,
	UiObjectExtractor,
	UiXmlPatternExtractor,
	UiSimpleTaskExtractor,
	UiLegacyExtractor
} from '../ui-message-extractor.js';

// ============================================================
// UiAskToolExtractor
// ============================================================

describe('UiAskToolExtractor', () => {
	const extractor = new UiAskToolExtractor();

	test('getPatternName returns correct name', () => {
		expect(extractor.getPatternName()).toBe('UI Ask/Tool Extractor');
	});

	describe('canHandle', () => {
		test('handles ask/tool with text string', () => {
			const msg = { type: 'ask', ask: 'tool', text: '{"tool":"newTask"}' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects non-ask type', () => {
			const msg = { type: 'say', ask: 'tool', text: '{}' };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects non-tool ask', () => {
			const msg = { type: 'ask', ask: 'command', text: '{}' };
			expect(extractor.canHandle(msg)).toBe(false);
		});
	});

	describe('extract', () => {
		test('extracts newTask from JSON text', () => {
			const msg = {
				type: 'ask',
				ask: 'tool',
				timestamp: '2026-02-22T10:00:00Z',
				text: JSON.stringify({
					tool: 'newTask',
					mode: 'code',
					content: 'Fix the authentication bug in the login module'
				})
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
		});

		test('returns empty for non-newTask tool', () => {
			const msg = {
				type: 'ask',
				ask: 'tool',
				text: JSON.stringify({ tool: 'read_file', path: '/test' })
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('returns empty for invalid JSON', () => {
			const msg = { type: 'ask', ask: 'tool', text: 'not json!' };
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});
	});
});

// ============================================================
// UiObjectExtractor
// ============================================================

describe('UiObjectExtractor', () => {
	const extractor = new UiObjectExtractor();

	test('getPatternName returns correct name', () => {
		expect(extractor.getPatternName()).toBe('UI Object Extractor');
	});

	describe('canHandle', () => {
		test('handles object text', () => {
			const msg = { text: { tool: 'newTask' } };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles object content', () => {
			const msg = { content: { tool: 'newTask' } };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles array content (OpenAI format)', () => {
			const msg = { content: [{ type: 'text', text: 'hello' }] };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects string text', () => {
			const msg = { text: 'plain string' };
			expect(extractor.canHandle(msg)).toBe(false);
		});
	});

	describe('extract', () => {
		test('extracts from text object with newTask', () => {
			const msg = {
				timestamp: '2026-02-22T10:00:00Z',
				text: {
					tool: 'newTask',
					mode: 'code',
					content: 'Implement the caching layer for API responses'
				}
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
		});

		test('extracts from content object with newTask', () => {
			const msg = {
				timestamp: '2026-02-22T10:00:00Z',
				content: {
					tool: 'newTask',
					mode: 'debug',
					content: 'Debug the configuration sync issue across machines'
				}
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('debug');
		});

		test('extracts <task> tags from OpenAI array format', () => {
			const msg = {
				timestamp: '2026-02-22T10:00:00Z',
				content: [{
					type: 'text',
					text: 'Please do this: <task>Fix the validation logic in the form handler for user registration</task>'
				}]
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].message).toContain('validation logic');
		});

		test('ignores short task content in arrays', () => {
			const msg = {
				content: [{ type: 'text', text: '<task>short</task>' }]
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('returns empty for non-newTask object', () => {
			const msg = { text: { tool: 'read_file', path: '/test' } };
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});
	});
});

// ============================================================
// UiXmlPatternExtractor
// ============================================================

describe('UiXmlPatternExtractor', () => {
	const extractor = new UiXmlPatternExtractor();

	test('getPatternName returns correct name', () => {
		expect(extractor.getPatternName()).toBe('UI XML Pattern Extractor');
	});

	describe('canHandle', () => {
		test('handles tool_result with string content', () => {
			const msg = { type: 'tool_result', content: '<new_task>...</new_task>' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles say with text', () => {
			const msg = { type: 'say', text: 'some text' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles user role with content', () => {
			const msg = { role: 'user', content: 'some content' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles assistant role with array content', () => {
			const msg = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects ask type', () => {
			const msg = { type: 'ask', text: 'something' };
			expect(extractor.canHandle(msg)).toBe(false);
		});
	});

	describe('extract', () => {
		test('extracts closed <new_task> XML pattern', () => {
			const msg = {
				type: 'say',
				timestamp: '2026-02-22T10:00:00Z',
				text: '<new_task><mode>code</mode><message>Implement the error handler</message></new_task>'
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
			expect(result[0].message).toContain('error handler');
		});

		test('extracts unclosed <new_task> XML pattern', () => {
			const msg = {
				type: 'say',
				timestamp: '2026-02-22T10:00:00Z',
				text: '<new_task><mode>debug</mode><message>Fix the regression</message>'
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('debug');
		});

		test('extracts multiple new_task patterns', () => {
			const msg = {
				type: 'say',
				text: '<new_task><mode>code</mode><message>Task one is long enough to pass</message></new_task>' +
					'<new_task><mode>test</mode><message>Task two is long enough to pass</message></new_task>'
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(2);
		});

		test('returns empty for text without new_task', () => {
			const msg = { type: 'say', text: 'Just a regular message' };
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('extracts from tool_result content', () => {
			const msg = {
				type: 'tool_result',
				content: '<new_task><mode>code</mode><message>Deploy the updated configuration to all machines</message></new_task>'
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
		});
	});
});

// ============================================================
// UiSimpleTaskExtractor
// ============================================================

describe('UiSimpleTaskExtractor', () => {
	const extractor = new UiSimpleTaskExtractor();

	test('getPatternName returns correct name', () => {
		expect(extractor.getPatternName()).toBe('UI Simple Task Extractor');
	});

	describe('canHandle', () => {
		test('handles say with text', () => {
			const msg = { type: 'say', text: '<task>stuff</task>' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles user role with content string', () => {
			const msg = { role: 'user', content: 'some content' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles assistant role with array content', () => {
			const msg = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects tool_call type', () => {
			const msg = { type: 'tool_call', text: '<task>x</task>' };
			expect(extractor.canHandle(msg)).toBe(false);
		});
	});

	describe('extract', () => {
		test('extracts <task> tag content', () => {
			const msg = {
				type: 'say',
				timestamp: '2026-02-22T10:00:00Z',
				text: 'Please do: <task>Build the authentication middleware for API routes</task>'
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('task');
			expect(result[0].message).toContain('authentication middleware');
		});

		test('ignores short task content', () => {
			const msg = { type: 'say', text: '<task>short</task>' };
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('extracts multiple task tags', () => {
			const msg = {
				type: 'say',
				text: '<task>First task that is long enough to pass validation</task> and <task>Second task that is also long enough to pass</task>'
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(2);
		});

		test('returns empty when no task tags', () => {
			const msg = { type: 'say', text: 'No task tags here' };
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});
	});
});

// ============================================================
// UiLegacyExtractor
// ============================================================

describe('UiLegacyExtractor', () => {
	const extractor = new UiLegacyExtractor();

	test('getPatternName returns correct name', () => {
		expect(extractor.getPatternName()).toBe('UI Legacy Extractor');
	});

	describe('canHandle', () => {
		test('handles tool_call with new_task', () => {
			const msg = { type: 'tool_call', content: { tool: 'new_task' } };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects non-tool_call', () => {
			const msg = { type: 'say', content: { tool: 'new_task' } };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects other tools', () => {
			const msg = { type: 'tool_call', content: { tool: 'read_file' } };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects missing content', () => {
			const msg = { type: 'tool_call' };
			expect(extractor.canHandle(msg)).toBeFalsy();
		});
	});

	describe('extract', () => {
		test('extracts from legacy format', () => {
			const msg = {
				type: 'tool_call',
				timestamp: '2026-02-22T10:00:00Z',
				content: {
					tool: 'new_task',
					mode: 'code',
					message: 'Legacy task instruction'
				}
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
			expect(result[0].message).toBe('Legacy task instruction');
		});

		test('uses "legacy" as default mode', () => {
			const msg = {
				type: 'tool_call',
				content: { tool: 'new_task', message: 'Do something' }
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('legacy');
		});

		test('handles empty message', () => {
			const msg = {
				type: 'tool_call',
				content: { tool: 'new_task', mode: 'code', message: '' }
			};
			const result = extractor.extract(msg);
			// minLength is 1 for legacy, empty string is still empty
			expect(result).toHaveLength(0);
		});
	});
});
