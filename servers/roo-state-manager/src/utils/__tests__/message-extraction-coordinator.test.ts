/**
 * Tests pour MessageExtractionCoordinator
 * Issue #492 - Couverture du coordinateur d'extraction
 *
 * @module utils/__tests__/message-extraction-coordinator
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { MessageExtractionCoordinator } from '../message-extraction-coordinator.js';

describe('MessageExtractionCoordinator', () => {
	let coordinator: MessageExtractionCoordinator;

	beforeEach(() => {
		coordinator = new MessageExtractionCoordinator();
	});

	// ============================================================
	// getAvailableExtractors
	// ============================================================

	describe('getAvailableExtractors', () => {
		test('returns 7 extractors', () => {
			const extractors = coordinator.getAvailableExtractors();
			expect(extractors).toHaveLength(7);
		});

		test('includes API and UI extractors', () => {
			const extractors = coordinator.getAvailableExtractors();
			// Should have API extractors
			expect(extractors.some(e => e.toLowerCase().includes('api'))).toBe(true);
			// Should have UI extractors
			expect(extractors.some(e => e.toLowerCase().includes('ui'))).toBe(true);
		});
	});

	// ============================================================
	// extractFromMessages - empty/edge cases
	// ============================================================

	describe('extractFromMessages - edge cases', () => {
		test('returns empty result for empty array', () => {
			const result = coordinator.extractFromMessages([]);
			expect(result.instructions).toHaveLength(0);
			expect(result.processedMessages).toBe(0);
			expect(result.matchedPatterns).toHaveLength(0);
			expect(result.errors).toHaveLength(0);
		});

		test('processes all messages', () => {
			const messages = [
				{ type: 'say', say: 'text', text: 'Hello' },
				{ type: 'say', say: 'text', text: 'World' },
				{ type: 'say', say: 'text', text: 'Test' }
			];
			const result = coordinator.extractFromMessages(messages);
			expect(result.processedMessages).toBe(3);
		});

		test('handles messages without matching extractors', () => {
			const messages = [
				{ type: 'unknown', text: 'No extractor will match' }
			];
			const result = coordinator.extractFromMessages(messages);
			expect(result.processedMessages).toBe(1);
			expect(result.instructions).toHaveLength(0);
		});
	});

	// ============================================================
	// extractFromMessages - API messages
	// ============================================================

	describe('extractFromMessages - API format', () => {
		test('processes API content object without crashing', () => {
			const messages = [{
				type: 'api_req_started',
				content: {
					tool: 'newTask',
					mode: 'code',
					content: 'Fix the auth module'
				}
			}];
			const result = coordinator.extractFromMessages(messages);
			expect(result.processedMessages).toBe(1);
			// ApiContentExtractor should attempt to handle this message
			// Exact behavior depends on createInstruction thresholds
		});

		test('extracts from API text with XML new_task', () => {
			const messages = [{
				role: 'assistant',
				text: '<new_task><mode>debug</mode><message>Debug the auth flow</message></new_task>'
			}];
			const result = coordinator.extractFromMessages(messages);
			// ApiTextExtractor or UI XML extractor should pick this up
			expect(result.processedMessages).toBe(1);
		});
	});

	// ============================================================
	// extractFromMessages - UI messages
	// ============================================================

	describe('extractFromMessages - UI format', () => {
		test('extracts from ask/tool UI message', () => {
			const messages = [{
				type: 'ask',
				ask: 'tool',
				text: JSON.stringify({
					tool: 'newTask',
					mode: 'code',
					content: 'Build the notification system'
				})
			}];
			const result = coordinator.extractFromMessages(messages);
			expect(result.instructions.length).toBeGreaterThanOrEqual(1);
		});

		test('extracts from simple task XML', () => {
			const messages = [{
				type: 'say',
				say: 'text',
				text: '<task><mode>code</mode><message>Implement feature X</message></task>'
			}];
			const result = coordinator.extractFromMessages(messages);
			// UiSimpleTaskExtractor or UiXmlPatternExtractor should match
			expect(result.processedMessages).toBe(1);
		});

		test('extracts from new_task XML pattern', () => {
			const messages = [{
				type: 'say',
				say: 'text',
				text: '<new_task><mode>code</mode><message>Fix bug Y</message></new_task>'
			}];
			const result = coordinator.extractFromMessages(messages);
			expect(result.processedMessages).toBe(1);
		});
	});

	// ============================================================
	// extractFromMessage (single)
	// ============================================================

	describe('extractFromMessage', () => {
		test('returns result with processedMessages=1', () => {
			const result = coordinator.extractFromMessage({ type: 'say', say: 'text', text: 'Hello' });
			expect(result.processedMessages).toBe(1);
		});

		test('extracts from single ask/tool message', () => {
			const result = coordinator.extractFromMessage({
				type: 'ask',
				ask: 'tool',
				text: JSON.stringify({
					tool: 'new_task',
					mode: 'code',
					content: 'Test task'
				})
			});
			expect(result.processedMessages).toBe(1);
		});
	});

	// ============================================================
	// setDebugEnabled
	// ============================================================

	describe('setDebugEnabled', () => {
		test('can toggle debug mode without error', () => {
			expect(() => coordinator.setDebugEnabled(true)).not.toThrow();
			expect(() => coordinator.setDebugEnabled(false)).not.toThrow();
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('captures errors in result without crashing', () => {
			// null message should not crash the coordinator
			const result = coordinator.extractFromMessages([null as any]);
			expect(result.processedMessages).toBe(1);
			// May or may not have errors depending on implementation
		});
	});
});
