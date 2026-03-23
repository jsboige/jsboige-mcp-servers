/**
 * Tests pour SmartCleanerService (récupéré depuis git history, issue #811)
 *
 * Ces tests vérifient le COMPORTEMENT RÉEL, pas juste l'existence des méthodes.
 * Anti-pattern stub: chaque assertion vérifie une valeur significative.
 */

import { describe, it, expect } from 'vitest';
import { SmartCleanerService, CleaningConfig } from '../SmartCleanerService.js';
import { ClassifiedContent } from '../../types/enhanced-conversation.js';

function makeContent(content: string, overrides?: Partial<ClassifiedContent>): ClassifiedContent {
	return {
		type: 'User',
		subType: 'UserMessage',
		content,
		index: 0,
		contentSize: content.length,
		isRelevant: true,
		confidenceScore: 0.9,
		...overrides
	};
}

describe('SmartCleanerService', () => {
	const cleaner = new SmartCleanerService();

	describe('environment_details removal', () => {
		it('should remove <environment_details> XML blocks', () => {
			const input = makeContent(
				'Hello\n<environment_details>\nVS Code version 1.80\nOS: Windows\n</environment_details>\nWorld'
			);
			const { cleanedContent, result } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).toContain('Hello');
			expect(cleanedContent[0].content).toContain('World');
			expect(cleanedContent[0].content).not.toContain('environment_details');
			expect(cleanedContent[0].content).not.toContain('VS Code version');
			expect(result.removedElements.environmentDetails).toBe(1);
		});

		it('should remove VSCode header sections', () => {
			const input = makeContent(
				'# VSCode Visible Files\nfile1.ts\nfile2.ts\n# Other Section\nContent here'
			);
			const { cleanedContent } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).not.toContain('VSCode Visible Files');
			expect(cleanedContent[0].content).toContain('Content here');
		});
	});

	describe('metadata removal', () => {
		it('should remove tool result prefixes', () => {
			const input = makeContent(
				"[read_file for 'src/index.ts'] Result:\nconst x = 1;"
			);
			const { cleanedContent, result } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).not.toContain('[read_file for');
			expect(cleanedContent[0].content).toContain('const x = 1;');
			expect(result.removedElements.redundantMetadata).toBe(1);
		});

		it('should remove file_write_result blocks', () => {
			const input = makeContent(
				'Before\n<file_write_result>\nSuccess\n</file_write_result>\nAfter'
			);
			const { cleanedContent } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).not.toContain('file_write_result');
			expect(cleanedContent[0].content).toContain('Before');
			expect(cleanedContent[0].content).toContain('After');
		});
	});

	describe('debug info removal', () => {
		it('should remove debug info blocks', () => {
			const input = makeContent(
				'Result:\nDebug Info:\nSimilarity Score: 0.85\nRequired Threshold: 0.7\nSearch Range: 100\n\nActual content'
			);
			const { cleanedContent, result } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).not.toContain('Debug Info');
			expect(cleanedContent[0].content).not.toContain('Similarity Score');
			expect(result.removedElements.debugInfo).toBeGreaterThan(0);
		});
	});

	describe('cost info removal', () => {
		it('should remove dollar amounts', () => {
			const input = makeContent('Total cost: $1.25 for this operation');
			const { cleanedContent, result } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).not.toContain('$1.25');
			expect(result.removedElements.costInfo).toBe(1);
		});

		it('should remove JSON cost fields', () => {
			const input = makeContent('{"cost": 0.05, "tokensIn": 1500, "tokensOut": 200}');
			const { cleanedContent } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).not.toContain('"cost":');
			expect(cleanedContent[0].content).not.toContain('"tokensIn":');
		});
	});

	describe('whitespace and empty lines', () => {
		it('should collapse excessive empty lines', () => {
			const input = makeContent('Line 1\n\n\n\n\nLine 2');
			const { cleanedContent } = cleaner.cleanContent([input]);

			const lines = cleanedContent[0].content.split('\n');
			let maxConsecutiveEmpty = 0;
			let currentEmpty = 0;
			for (const line of lines) {
				if (line.trim() === '') {
					currentEmpty++;
					maxConsecutiveEmpty = Math.max(maxConsecutiveEmpty, currentEmpty);
				} else {
					currentEmpty = 0;
				}
			}
			expect(maxConsecutiveEmpty).toBeLessThanOrEqual(1);
		});

		it('should trim trailing whitespace', () => {
			const input = makeContent('Line with trailing spaces   \nAnother line\t\t');
			const { cleanedContent } = cleaner.cleanContent([input]);

			const lines = cleanedContent[0].content.split('\n');
			for (const line of lines) {
				expect(line).toBe(line.trimEnd());
			}
		});
	});

	describe('compression metrics', () => {
		it('should report accurate compression ratio', () => {
			const bigContent = makeContent(
				'Real content\n<environment_details>\n' + 'x'.repeat(500) + '\n</environment_details>\nEnd'
			);
			const { result } = cleaner.cleanContent([bigContent]);

			expect(result.originalSize).toBeGreaterThan(result.cleanedSize);
			expect(result.compressionRatio).toBeGreaterThan(0);
			expect(result.compressionRatio).toBeLessThan(1);
			// NOT a stub check — we verify actual compression happened
			expect(result.cleanedSize).toBeLessThan(result.originalSize);
		});

		it('should handle empty content without crashing', () => {
			const empty = makeContent('');
			const { cleanedContent, result } = cleaner.cleanContent([empty]);

			expect(result.compressionRatio).toBe(0);
			// Empty content is filtered out
			expect(cleanedContent.length).toBe(0);
		});
	});

	describe('config overrides', () => {
		it('should respect removeTimestamps=true', () => {
			const input = makeContent('Event at 2026-03-23T14:30:00.000Z happened');
			const { cleanedContent } = cleaner.cleanContent([input], { removeTimestamps: true });

			expect(cleanedContent[0].content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});

		it('should preserve timestamps by default', () => {
			const input = makeContent('Event at 2026-03-23T14:30:00.000Z happened');
			const { cleanedContent } = cleaner.cleanContent([input]);

			expect(cleanedContent[0].content).toContain('2026-03-23T14:30:00.000Z');
		});
	});

	describe('analyzeContent', () => {
		it('should detect cleanable elements without modifying content', () => {
			const content = [
				makeContent('<environment_details>stuff</environment_details>'),
				makeContent('[read_file for "x"] Result: ok'),
				makeContent('$5.00 cost'),
			];
			const stats = cleaner.analyzeContent(content);

			expect(stats.environmentDetailsCount).toBe(1);
			expect(stats.redundantMetadataCount).toBe(1);
			expect(stats.costInfoCount).toBe(1);
			expect(stats.estimatedSavings).toBeGreaterThan(0);
		});
	});
});
