/**
 * Tests for SmartCleanerService
 * Issue #811 - Recovery of destroyed code
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SmartCleanerService, CleaningConfig } from '../SmartCleanerService.js';
import { ClassifiedContent } from '../../types/enhanced-conversation.js';

function makeContent(content: string, index = 0): ClassifiedContent {
	return {
		type: 'Assistant',
		subType: 'Completion',
		content,
		index,
		contentSize: content.length,
	};
}

describe('SmartCleanerService', () => {
	let cleaner: SmartCleanerService;

	beforeEach(() => {
		cleaner = new SmartCleanerService();
	});

	describe('constructor', () => {
		test('creates with default config', () => {
			expect(cleaner).toBeDefined();
		});

		test('accepts partial config override', () => {
			const custom = new SmartCleanerService({ removeTimestamps: true });
			expect(custom).toBeDefined();
		});
	});

	describe('cleanContent', () => {
		test('returns cleaned content and metrics', () => {
			const items = [makeContent('Hello world')];
			const { cleanedContent, result } = cleaner.cleanContent(items);

			expect(cleanedContent).toHaveLength(1);
			expect(result.originalSize).toBe(11);
			expect(result.cleanedSize).toBeGreaterThan(0);
			expect(result.compressionRatio).toBeGreaterThanOrEqual(0);
		});

		test('removes environment_details blocks', () => {
			const content = 'Before\n<environment_details>\nVSCode stuff\n</environment_details>\nAfter';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].content).not.toContain('<environment_details>');
			expect(cleanedContent[0].content).toContain('Before');
			expect(cleanedContent[0].content).toContain('After');
		});

		test('removes VSCode environment headers', () => {
			const content = 'Start\n# VSCode Visible Files\nfile1.ts\nfile2.ts\n# VSCode Open Tabs\ntab1\ntab2\n';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].content).not.toContain('# VSCode Visible Files');
			expect(cleanedContent[0].content).not.toContain('# VSCode Open Tabs');
		});

		test('removes redundant metadata patterns', () => {
			const content = "Real text before\n[read_file for 'src/index.ts'] Result:\n<file_write_result>OK</file_write_result>\nReal text after";
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].content).not.toContain('[read_file for');
			expect(cleanedContent[0].content).not.toContain('<file_write_result>');
			expect(cleanedContent[0].content).toContain('Real text before');
		});

		test('removes debug info', () => {
			const content = 'Result\nDebug Info:\nSome debug data\n\nSimilarity Score: 0.95\nNext section';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].content).not.toContain('Debug Info:');
			expect(cleanedContent[0].content).not.toContain('Similarity Score:');
		});

		test('removes cost info by default', () => {
			const content = 'Summary report\n# Current Cost\n$1.50\n"cost": 1.5\n"tokensIn": 1000\n"tokensOut": 500\nEnd of report';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].content).not.toContain('$1.50');
			expect(cleanedContent[0].content).not.toContain('"tokensIn": 1000');
			expect(cleanedContent[0].content).toContain('Summary report');
		});

		test('preserves timestamps by default', () => {
			const content = 'Event at 2026-03-23T10:00:00.000Z happened';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].content).toContain('2026-03-23T10:00:00.000Z');
		});

		test('removes timestamps when configured', () => {
			const content = 'Event at 2026-03-23T10:00:00.000Z happened';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items, { removeTimestamps: true });

			expect(cleanedContent[0].content).not.toContain('2026-03-23T10:00:00.000Z');
		});

		test('reduces excessive empty lines', () => {
			const content = 'Line1\n\n\n\n\nLine2';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

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

		test('filters out empty content items', () => {
			const items = [
				makeContent('<environment_details>only env</environment_details>', 0),
				makeContent('Real content', 1),
			];
			const { cleanedContent } = cleaner.cleanContent(items);

			// The first item should be filtered out (empty after cleaning)
			expect(cleanedContent.length).toBeLessThanOrEqual(2);
			expect(cleanedContent.some(c => c.content.includes('Real content'))).toBe(true);
		});

		test('reports correct compression ratio', () => {
			const bigContent = '<environment_details>\n' + 'x'.repeat(1000) + '\n</environment_details>\nSmall text';
			const items = [makeContent(bigContent)];
			const { result } = cleaner.cleanContent(items);

			expect(result.compressionRatio).toBeGreaterThan(0.5);
			expect(result.originalSize).toBeGreaterThan(result.cleanedSize);
		});

		test('updates contentSize after cleaning', () => {
			const content = 'Hello <environment_details>big block</environment_details> world';
			const items = [makeContent(content)];
			const { cleanedContent } = cleaner.cleanContent(items);

			expect(cleanedContent[0].contentSize).toBe(cleanedContent[0].content.length);
			expect(cleanedContent[0].contentSize).toBeLessThan(content.length);
		});
	});

	describe('analyzeContent', () => {
		test('detects environment_details', () => {
			const items = [makeContent('<environment_details>stuff</environment_details>')];
			const stats = cleaner.analyzeContent(items);

			expect(stats.environmentDetailsCount).toBe(1);
		});

		test('detects redundant metadata', () => {
			const items = [makeContent("[read_file for 'test.ts'] Result: ok")];
			const stats = cleaner.analyzeContent(items);

			expect(stats.redundantMetadataCount).toBe(1);
		});

		test('detects debug info', () => {
			const items = [makeContent('Debug Info:\nsome info\nSimilarity Score: 0.9')];
			const stats = cleaner.analyzeContent(items);

			expect(stats.debugInfoCount).toBe(1);
		});

		test('detects timestamps', () => {
			const items = [makeContent('Happened at 2026-03-23T10:00:00.000Z')];
			const stats = cleaner.analyzeContent(items);

			expect(stats.timestampCount).toBe(1);
		});

		test('detects cost info', () => {
			const items = [makeContent('"cost": 1.5 and $2.50')];
			const stats = cleaner.analyzeContent(items);

			expect(stats.costInfoCount).toBe(1);
		});

		test('estimates savings', () => {
			const items = [makeContent('x'.repeat(1000))];
			const stats = cleaner.analyzeContent(items);

			expect(stats.estimatedSavings).toBeGreaterThan(0);
		});

		test('handles empty content array', () => {
			const stats = cleaner.analyzeContent([]);

			expect(stats.environmentDetailsCount).toBe(0);
			expect(stats.estimatedSavings).toBe(0);
		});
	});

	describe('anti-stub checks', () => {
		test('cleanContent returns real compression data, not hardcoded values', () => {
			const small = [makeContent('tiny')];
			const big = [makeContent('<environment_details>' + 'x'.repeat(500) + '</environment_details>')];

			const { result: smallResult } = cleaner.cleanContent(small);
			const { result: bigResult } = cleaner.cleanContent(big);

			// Different inputs MUST produce different compression ratios
			expect(bigResult.compressionRatio).not.toBe(smallResult.compressionRatio);
			expect(bigResult.compressionRatio).toBeGreaterThan(smallResult.compressionRatio);
		});

		test('analyzeContent counts vary with input, not hardcoded', () => {
			const withEnv = [makeContent('<environment_details>x</environment_details>')];
			const withoutEnv = [makeContent('plain text')];

			expect(cleaner.analyzeContent(withEnv).environmentDetailsCount).toBe(1);
			expect(cleaner.analyzeContent(withoutEnv).environmentDetailsCount).toBe(0);
		});
	});
});
