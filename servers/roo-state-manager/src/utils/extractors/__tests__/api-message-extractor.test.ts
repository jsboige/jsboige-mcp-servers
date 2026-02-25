/**
 * Tests pour api-message-extractor.ts
 * Issue #492 - Couverture des extracteurs de patterns
 *
 * @module utils/extractors/__tests__/api-message-extractor
 */

import { describe, test, expect } from 'vitest';
import { ApiContentExtractor, ApiTextExtractor } from '../api-message-extractor.js';

describe('ApiContentExtractor', () => {
	const extractor = new ApiContentExtractor();

	describe('getPatternName', () => {
		test('returns correct name', () => {
			expect(extractor.getPatternName()).toBe('API Content Extractor');
		});
	});

	describe('canHandle', () => {
		test('handles api_req_started with newTask content object', () => {
			const msg = {
				type: 'api_req_started',
				content: { tool: 'newTask', content: 'Do something long enough' }
			};
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects non api_req_started type', () => {
			const msg = { type: 'say', content: { tool: 'newTask' } };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects when content is string', () => {
			const msg = { type: 'api_req_started', content: 'plain string' };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects when tool is not newTask', () => {
			const msg = { type: 'api_req_started', content: { tool: 'otherTool' } };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects when content is null', () => {
			const msg = { type: 'api_req_started', content: null };
			expect(extractor.canHandle(msg)).toBeFalsy();
		});
	});

	describe('extract', () => {
		test('extracts instruction from content field', () => {
			const msg = {
				type: 'api_req_started',
				timestamp: '2026-02-22T10:00:00Z',
				content: {
					tool: 'newTask',
					mode: 'code',
					content: 'Implement the user authentication module with JWT'
				}
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
			expect(result[0].message).toContain('authentication module');
		});

		test('extracts instruction from message field', () => {
			const msg = {
				type: 'api_req_started',
				timestamp: '2026-02-22T10:00:00Z',
				content: {
					tool: 'newTask',
					mode: 'debug',
					message: 'Debug the failing test in SmartCleanerService'
				}
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('debug');
		});

		test('returns empty for short content', () => {
			const msg = {
				type: 'api_req_started',
				content: { tool: 'newTask', mode: 'code', content: 'short' }
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('throws for invalid content structure', () => {
			const msg = {
				type: 'api_req_started',
				content: null
			};
			expect(() => extractor.extract(msg)).toThrow();
		});

		test('uses mode from content', () => {
			const msg = {
				type: 'api_req_started',
				content: {
					tool: 'newTask',
					mode: 'orchestrator-complex',
					content: 'Coordinate all machines to run smoke tests'
				}
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('orchestratorcomplex');
		});
	});
});

describe('ApiTextExtractor', () => {
	const extractor = new ApiTextExtractor();

	describe('getPatternName', () => {
		test('returns correct name', () => {
			expect(extractor.getPatternName()).toBe('API Text Extractor');
		});
	});

	describe('canHandle', () => {
		test('handles api_req_started with text string', () => {
			const msg = { type: 'api_req_started', text: '{"tool": "newTask"}' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('handles say/api_req_started with text string', () => {
			const msg = { type: 'say', say: 'api_req_started', text: '{"tool": "newTask"}' };
			expect(extractor.canHandle(msg)).toBe(true);
		});

		test('rejects when text is not string', () => {
			const msg = { type: 'api_req_started', text: { data: 'obj' } };
			expect(extractor.canHandle(msg)).toBe(false);
		});

		test('rejects unrelated type', () => {
			const msg = { type: 'tool_call', text: '{}' };
			expect(extractor.canHandle(msg)).toBe(false);
		});
	});

	describe('extract', () => {
		test('extracts from tool=newTask JSON', () => {
			const msg = {
				type: 'api_req_started',
				timestamp: '2026-02-22T10:00:00Z',
				text: JSON.stringify({
					tool: 'newTask',
					mode: 'code',
					content: 'Build the notification service for alerts'
				})
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].mode).toBe('code');
			expect(result[0].message).toContain('notification service');
		});

		test('extracts from request pattern [new_task in X: Y]', () => {
			const msg = {
				type: 'api_req_started',
				timestamp: '2026-02-22T10:00:00Z',
				text: JSON.stringify({
					request: "[new_task in code-simple: 'Run the full test suite and report results']"
				})
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(1);
			expect(result[0].message).toContain('test suite');
		});

		test('returns empty for invalid JSON text', () => {
			const msg = { type: 'api_req_started', text: 'not json' };
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('returns empty for unrelated JSON', () => {
			const msg = {
				type: 'api_req_started',
				text: JSON.stringify({ status: 'ok', data: 'unrelated' })
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});

		test('returns empty when content too short', () => {
			const msg = {
				type: 'api_req_started',
				text: JSON.stringify({ tool: 'newTask', mode: 'code', content: 'hi' })
			};
			const result = extractor.extract(msg);
			expect(result).toHaveLength(0);
		});
	});
});
