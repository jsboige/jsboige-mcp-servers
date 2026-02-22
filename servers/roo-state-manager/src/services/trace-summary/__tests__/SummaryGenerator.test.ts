/**
 * Tests pour SummaryGenerator.ts (méthodes pures)
 * Issue #492 - Couverture du générateur de résumés
 *
 * @module services/trace-summary/__tests__/SummaryGenerator
 */

import { describe, test, expect } from 'vitest';
import { SummaryGenerator } from '../SummaryGenerator.js';
import type { ClassifiedContent } from '../ContentClassifier.js';
import type { ConversationSkeleton, MessageSkeleton } from '../../../types/conversation.js';

describe('SummaryGenerator', () => {
	let generator: SummaryGenerator;

	function createGenerator(): SummaryGenerator {
		return new SummaryGenerator();
	}

	// ============================================================
	// calculateStatistics
	// ============================================================

	describe('calculateStatistics', () => {
		test('counts UserMessage as user', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'UserMessage', content: 'Hello world', index: 0, contentSize: 11, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.userMessages).toBe(1);
			expect(stats.assistantMessages).toBe(0);
			expect(stats.toolResults).toBe(0);
		});

		test('counts ToolCall and Completion as assistant', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'Assistant', subType: 'ToolCall', content: 'Tool call', index: 0, contentSize: 9, isRelevant: true, confidenceScore: 1 },
				{ type: 'Assistant', subType: 'Completion', content: 'Done', index: 1, contentSize: 4, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.assistantMessages).toBe(2);
		});

		test('counts ToolResult separately', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'ToolResult', content: 'File content here...', index: 0, contentSize: 20, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.toolResults).toBe(1);
			expect(stats.toolResultsSize).toBe(20);
		});

		test('counts ErrorMessage as user message', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'ErrorMessage', content: 'Error occurred', index: 0, contentSize: 14, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.userMessages).toBe(1);
		});

		test('counts ContextCondensation as user message', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'ContextCondensation', content: 'Condensed context', index: 0, contentSize: 18, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.userMessages).toBe(1);
		});

		test('counts NewInstructions as user message', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'NewInstructions', content: 'New instructions', index: 0, contentSize: 16, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.userMessages).toBe(1);
		});

		test('calculates percentages correctly', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'UserMessage', content: 'A'.repeat(50), index: 0, contentSize: 50, isRelevant: true, confidenceScore: 1 },
				{ type: 'Assistant', subType: 'Completion', content: 'B'.repeat(30), index: 1, contentSize: 30, isRelevant: true, confidenceScore: 1 },
				{ type: 'User', subType: 'ToolResult', content: 'C'.repeat(20), index: 2, contentSize: 20, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.totalContentSize).toBe(100);
			expect(stats.userPercentage).toBe(50);
			expect(stats.assistantPercentage).toBe(30);
			expect(stats.toolResultsPercentage).toBe(20);
		});

		test('returns zeros for empty array', () => {
			generator = createGenerator();
			const stats = generator.calculateStatistics([]);
			expect(stats.totalSections).toBe(0);
			expect(stats.userMessages).toBe(0);
			expect(stats.assistantMessages).toBe(0);
			expect(stats.toolResults).toBe(0);
			expect(stats.totalContentSize).toBe(0);
			expect(stats.userPercentage).toBe(0);
		});

		test('totalSections matches array length', () => {
			generator = createGenerator();
			const content: ClassifiedContent[] = [
				{ type: 'User', subType: 'UserMessage', content: 'A', index: 0, contentSize: 1, isRelevant: true, confidenceScore: 1 },
				{ type: 'Assistant', subType: 'Completion', content: 'B', index: 1, contentSize: 1, isRelevant: true, confidenceScore: 1 },
				{ type: 'User', subType: 'ToolResult', content: 'C', index: 2, contentSize: 1, isRelevant: true, confidenceScore: 1 }
			];
			const stats = generator.calculateStatistics(content);
			expect(stats.totalSections).toBe(3);
		});
	});

	// ============================================================
	// mergeWithDefaultOptions
	// ============================================================

	describe('mergeWithDefaultOptions', () => {
		test('returns defaults for empty options', () => {
			generator = createGenerator();
			const opts = generator.mergeWithDefaultOptions({});
			expect(opts.detailLevel).toBe('Full');
			expect(opts.truncationChars).toBe(0);
			expect(opts.compactStats).toBe(false);
			expect(opts.includeCss).toBe(true);
			expect(opts.generateToc).toBe(true);
			expect(opts.outputFormat).toBe('markdown');
			expect(opts.enableDetailLevels).toBe(false);
			expect(opts.hideEnvironmentDetails).toBe(true);
		});

		test('preserves provided values', () => {
			generator = createGenerator();
			const opts = generator.mergeWithDefaultOptions({
				detailLevel: 'NoTools',
				truncationChars: 5000,
				compactStats: true,
				includeCss: false,
				generateToc: false
			});
			expect(opts.detailLevel).toBe('NoTools');
			expect(opts.truncationChars).toBe(5000);
			expect(opts.compactStats).toBe(true);
			expect(opts.includeCss).toBe(false);
			expect(opts.generateToc).toBe(false);
		});

		test('sets tocStyle=markdown for markdown output', () => {
			generator = createGenerator();
			const opts = generator.mergeWithDefaultOptions({ outputFormat: 'markdown' });
			expect(opts.tocStyle).toBe('markdown');
		});

		test('sets tocStyle=html for html output', () => {
			generator = createGenerator();
			const opts = generator.mergeWithDefaultOptions({ outputFormat: 'html' });
			expect(opts.tocStyle).toBe('html');
		});

		test('explicit tocStyle overrides default', () => {
			generator = createGenerator();
			const opts = generator.mergeWithDefaultOptions({ outputFormat: 'markdown', tocStyle: 'html' as any });
			expect(opts.tocStyle).toBe('html');
		});

		test('preserves startIndex and endIndex', () => {
			generator = createGenerator();
			const opts = generator.mergeWithDefaultOptions({ startIndex: 5, endIndex: 10 });
			expect(opts.startIndex).toBe(5);
			expect(opts.endIndex).toBe(10);
		});
	});

	// ============================================================
	// getEmptyStatistics
	// ============================================================

	describe('getEmptyStatistics', () => {
		test('returns all zeros', () => {
			generator = createGenerator();
			const stats = generator.getEmptyStatistics();
			expect(stats.totalSections).toBe(0);
			expect(stats.userMessages).toBe(0);
			expect(stats.assistantMessages).toBe(0);
			expect(stats.toolResults).toBe(0);
			expect(stats.userContentSize).toBe(0);
			expect(stats.assistantContentSize).toBe(0);
			expect(stats.toolResultsSize).toBe(0);
			expect(stats.totalContentSize).toBe(0);
			expect(stats.userPercentage).toBe(0);
			expect(stats.assistantPercentage).toBe(0);
			expect(stats.toolResultsPercentage).toBe(0);
		});
	});

	// ============================================================
	// getOriginalContentSize
	// ============================================================

	describe('getOriginalContentSize', () => {
		test('calculates total content size from messages', () => {
			generator = createGenerator();
			const conversation = {
				taskId: 'test-task',
				sequence: [
					{ role: 'user', content: 'Hello' },       // 5 chars
					{ role: 'assistant', content: 'World!!' }, // 7 chars
					{ role: 'user', content: 'OK' }           // 2 chars
				] as MessageSkeleton[],
				isCompleted: true
			} as ConversationSkeleton;
			expect(generator.getOriginalContentSize(conversation)).toBe(14);
		});

		test('returns 0 for empty sequence', () => {
			generator = createGenerator();
			const conversation = {
				taskId: 'test-task',
				sequence: [],
				isCompleted: true
			} as ConversationSkeleton;
			expect(generator.getOriginalContentSize(conversation)).toBe(0);
		});

		test('skips non-message items in sequence', () => {
			generator = createGenerator();
			const conversation = {
				taskId: 'test-task',
				sequence: [
					{ role: 'user', content: 'Hello' },       // 5 chars - is a MessageSkeleton
					{ toolName: 'read_file' },                 // Not a MessageSkeleton (no role/content)
					{ role: 'assistant', content: 'World' }    // 5 chars
				],
				isCompleted: true
			} as any;
			expect(generator.getOriginalContentSize(conversation)).toBe(10);
		});
	});
});
