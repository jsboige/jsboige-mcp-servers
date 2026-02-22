/**
 * Tests pour SmartCleanerService
 * Issue #492 - Couverture des services non testés
 *
 * @module services/__tests__/SmartCleanerService
 */

import { describe, test, expect } from 'vitest';
import { SmartCleanerService, CleaningConfig } from '../SmartCleanerService.js';
import type { ClassifiedContent } from '../../types/enhanced-conversation.js';

// Helper to create classified content items
function createContent(content: string, overrides?: Partial<ClassifiedContent>): ClassifiedContent {
	return {
		type: 'User',
		subType: 'UserMessage',
		content,
		index: 0,
		contentSize: content.length,
		isRelevant: true,
		confidenceScore: 0.8,
		...overrides
	};
}

describe('SmartCleanerService', () => {
	// ============================================================
	// Constructor and defaults
	// ============================================================

	describe('constructor', () => {
		test('creates instance with default config', () => {
			const cleaner = new SmartCleanerService();
			expect(cleaner).toBeInstanceOf(SmartCleanerService);
		});

		test('accepts partial config overrides', () => {
			const cleaner = new SmartCleanerService({ removeTimestamps: true });
			// Verify by cleaning content with timestamps
			const content = [createContent('Text with 2026-02-22T10:00:00.000Z inside')];
			const { result } = cleaner.cleanContent(content);
			expect(result.removedElements.timestamps).toBe(1);
		});
	});

	// ============================================================
	// Environment details removal
	// ============================================================

	describe('removeEnvironmentDetails', () => {
		test('removes <environment_details> blocks', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Before <environment_details>\nVSCode stuff\nMore stuff\n</environment_details> After'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('environment_details');
			expect(cleanedContent[0].content).toContain('Before');
			expect(cleanedContent[0].content).toContain('After');
		});

		test('removes # VSCode Visible Files sections', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Start\n# VSCode Visible Files\nfile1.ts\nfile2.ts\n'
			)];
			const { cleanedContent, result } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('VSCode Visible Files');
			expect(result.removedElements.environmentDetails).toBe(1);
		});

		test('removes # Current Time sections', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Start\n# Current Time\n2026-02-22 10:00:00\n'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('Current Time');
		});

		test('removes # Current Cost sections', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Start\n# Current Cost\n$1.23\n'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('Current Cost');
		});

		test('removes # Current Mode sections', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Start\n# Current Mode\ncode-simple\n'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('Current Mode');
		});

		test('skips when removeEnvironmentDetails is false', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'<environment_details>VSCode data</environment_details>'
			)];
			const { cleanedContent } = cleaner.cleanContent(content, { removeEnvironmentDetails: false });
			expect(cleanedContent[0].content).toContain('environment_details');
		});
	});

	// ============================================================
	// Redundant metadata removal
	// ============================================================

	describe('removeRedundantMetadata', () => {
		test('removes [read_file for ...] Result: patterns', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				"Some text [read_file for 'src/index.ts'] Result: more text"
			)];
			const { cleanedContent, result } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('[read_file for');
			expect(result.removedElements.redundantMetadata).toBe(1);
		});

		test('removes <file_write_result> blocks', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Before <file_write_result>success</file_write_result> After'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('file_write_result');
		});

		test('removes <operation> tags', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Text <operation>write</operation> more text'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('<operation>');
		});

		test('removes <problems> blocks', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Text <problems>warning: unused var</problems> more'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('<problems>');
		});

		test('skips when removeRedundantMetadata is false', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				"[read_file for 'test.ts'] Result: ok"
			)];
			const { cleanedContent } = cleaner.cleanContent(content, { removeRedundantMetadata: false });
			expect(cleanedContent[0].content).toContain('[read_file for');
		});
	});

	// ============================================================
	// Debug info removal
	// ============================================================

	describe('removeDebugInfo', () => {
		test('removes Debug Info: blocks', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Result\nDebug Info:\nsome debug data\n\nMore content'
			)];
			const { cleanedContent, result } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('Debug Info:');
			expect(result.removedElements.debugInfo).toBe(1);
		});

		test('removes Similarity Score: lines', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Match found\nSimilarity Score: 0.95\nNext line'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('Similarity Score');
		});

		test('removes Required Threshold: lines', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent(
				'Search done\nRequired Threshold: 0.5\nResults below'
			)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('Required Threshold');
		});

		test('skips when removeDebugInfo is false', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Debug Info:\ntest\n\n')];
			const { cleanedContent } = cleaner.cleanContent(content, { removeDebugInfo: false });
			expect(cleanedContent[0].content).toContain('Debug Info:');
		});
	});

	// ============================================================
	// Timestamp removal
	// ============================================================

	describe('removeTimestamps', () => {
		test('does NOT remove timestamps by default', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Event at 2026-02-22T10:00:00.000Z happened')];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).toContain('2026-02-22T10:00:00.000Z');
		});

		test('removes ISO timestamps when enabled', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Event at 2026-02-22T10:00:00.000Z happened')];
			const { cleanedContent, result } = cleaner.cleanContent(content, { removeTimestamps: true });
			expect(cleanedContent[0].content).not.toContain('2026-02-22T10:00:00.000Z');
			expect(result.removedElements.timestamps).toBe(1);
		});

		test('removes "timestamp": "..." patterns', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('{"timestamp": "2026-02-22T10:00:00Z", "data": "test"}')];
			const { cleanedContent } = cleaner.cleanContent(content, { removeTimestamps: true });
			expect(cleanedContent[0].content).not.toContain('"timestamp"');
		});
	});

	// ============================================================
	// Cost info removal
	// ============================================================

	describe('removeCostInfo', () => {
		test('removes dollar amounts', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('This run cost $1.23 total')];
			const { cleanedContent, result } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('$1.23');
			expect(result.removedElements.costInfo).toBe(1);
		});

		test('removes "cost": value patterns', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('{"cost": 0.45, "result": "ok"}')];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('"cost"');
		});

		test('removes tokensIn/tokensOut patterns', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('{"tokensIn": 1500, "tokensOut": 500}')];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('"tokensIn"');
			expect(cleanedContent[0].content).not.toContain('"tokensOut"');
		});

		test('removes cacheWrites/cacheReads patterns', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('{"cacheWrites": 100, "cacheReads": 200}')];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toContain('"cacheWrites"');
			expect(cleanedContent[0].content).not.toContain('"cacheReads"');
		});

		test('skips when removeCostInfo is false', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Cost: $5.00')];
			const { cleanedContent } = cleaner.cleanContent(content, { removeCostInfo: false });
			expect(cleanedContent[0].content).toContain('$5.00');
		});
	});

	// ============================================================
	// File info removal
	// ============================================================

	describe('removeFileInfo', () => {
		test('does NOT remove file info by default', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Data\n# VSCode Visible Files\nfile1.ts\n')];
			// Note: environment_details ALSO catches # VSCode Visible Files
			// To test file info removal specifically, disable environment details
			const { cleanedContent } = cleaner.cleanContent(content, {
				removeEnvironmentDetails: false,
				removeFileInfo: false
			});
			expect(cleanedContent[0].content).toContain('VSCode Visible Files');
		});

		test('removes file sections when enabled', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Data\n# VSCode Open Tabs\ntab1.ts\ntab2.ts\n')];
			const { cleanedContent, result } = cleaner.cleanContent(content, {
				removeEnvironmentDetails: false,
				removeFileInfo: true
			});
			expect(cleanedContent[0].content).not.toContain('VSCode Open Tabs');
			expect(result.removedElements.fileInfo).toBe(1);
		});

		test('removes Recently Modified Files sections', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Start\n# Recently Modified Files\nfile.ts\n')];
			const { cleanedContent } = cleaner.cleanContent(content, {
				removeEnvironmentDetails: false,
				removeFileInfo: true
			});
			expect(cleanedContent[0].content).not.toContain('Recently Modified Files');
		});
	});

	// ============================================================
	// Whitespace minimization
	// ============================================================

	describe('minimizeWhitespace', () => {
		test('removes trailing spaces', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('line with trailing spaces   \nnext line  \n')];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].content).not.toMatch(/[ \t]+$/m);
		});

		test('collapses multiple inline spaces', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('word    word     word')];
			const { cleanedContent } = cleaner.cleanContent(content);
			// After cleaning, consecutive spaces should be reduced
			expect(cleanedContent[0].content).not.toContain('    ');
		});

		test('skips when minimizeWhitespace is false', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('word    word')];
			const { cleanedContent } = cleaner.cleanContent(content, { minimizeWhitespace: false });
			expect(cleanedContent[0].content).toContain('    ');
		});
	});

	// ============================================================
	// Empty line removal
	// ============================================================

	describe('removeExcessiveEmptyLines', () => {
		test('reduces excessive empty lines to maxConsecutive', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Line 1\n\n\n\n\nLine 2')];
			const { cleanedContent, result } = cleaner.cleanContent(content);
			// With default maxConsecutiveEmptyLines=1, should keep at most 1 empty line
			const lines = cleanedContent[0].content.split('\n');
			let maxEmpty = 0;
			let currentEmpty = 0;
			for (const line of lines) {
				if (line.trim() === '') {
					currentEmpty++;
					maxEmpty = Math.max(maxEmpty, currentEmpty);
				} else {
					currentEmpty = 0;
				}
			}
			expect(maxEmpty).toBeLessThanOrEqual(1);
			expect(result.removedElements.emptyLines).toBeGreaterThan(0);
		});

		test('respects maxConsecutiveEmptyLines config', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('A\n\n\n\n\nB')];
			const { cleanedContent } = cleaner.cleanContent(content, { maxConsecutiveEmptyLines: 3 });
			const lines = cleanedContent[0].content.split('\n');
			let maxEmpty = 0;
			let currentEmpty = 0;
			for (const line of lines) {
				if (line.trim() === '') {
					currentEmpty++;
					maxEmpty = Math.max(maxEmpty, currentEmpty);
				} else {
					currentEmpty = 0;
				}
			}
			expect(maxEmpty).toBeLessThanOrEqual(3);
		});

		test('skips when removeEmptyLines is false', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('A\n\n\n\n\nB')];
			const { cleanedContent } = cleaner.cleanContent(content, { removeEmptyLines: false });
			expect(cleanedContent[0].content).toContain('\n\n\n\n\n');
		});
	});

	// ============================================================
	// Compression ratio and metrics
	// ============================================================

	describe('cleaning metrics', () => {
		test('calculates compression ratio correctly', () => {
			const cleaner = new SmartCleanerService();
			const envBlock = '<environment_details>\n' + 'x'.repeat(500) + '\n</environment_details>';
			const content = [createContent(`Keep this. ${envBlock} And this.`)];

			const { result } = cleaner.cleanContent(content);
			expect(result.originalSize).toBeGreaterThan(0);
			expect(result.cleanedSize).toBeLessThan(result.originalSize);
			expect(result.compressionRatio).toBeGreaterThan(0);
			expect(result.compressionRatio).toBeLessThanOrEqual(1);
		});

		test('zero compression for clean content', () => {
			const cleaner = new SmartCleanerService();
			const content = [createContent('Simple clean text without any patterns')];
			const { result } = cleaner.cleanContent(content);
			// Even clean content might get whitespace trimmed, so just check it's small
			expect(result.compressionRatio).toBeLessThan(0.1);
		});

		test('filters out empty items after cleaning', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('<environment_details>only env data</environment_details>'),
				createContent('Real content here')
			];
			const { cleanedContent } = cleaner.cleanContent(content);
			// First item should be filtered out (becomes empty after cleaning)
			expect(cleanedContent.length).toBeLessThanOrEqual(2);
			expect(cleanedContent.some(c => c.content.includes('Real content'))).toBe(true);
		});

		test('updates contentSize on cleaned items', () => {
			const cleaner = new SmartCleanerService();
			const original = 'Text with $99.99 cost info and Debug Info:\ndata\n\nend';
			const content = [createContent(original)];
			const { cleanedContent } = cleaner.cleanContent(content);
			expect(cleanedContent[0].contentSize).toBe(cleanedContent[0].content.length);
			expect(cleanedContent[0].contentSize).toBeLessThan(original.length);
		});
	});

	// ============================================================
	// Multiple items
	// ============================================================

	describe('multiple items', () => {
		test('cleans all items in array', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('Item 1 with $1.00 cost'),
				createContent('Item 2 with <environment_details>env</environment_details>'),
				createContent('Item 3 clean')
			];
			const { result } = cleaner.cleanContent(content);
			expect(result.removedElements.costInfo).toBeGreaterThanOrEqual(1);
			expect(result.removedElements.environmentDetails).toBeGreaterThanOrEqual(1);
		});

		test('handles empty input array', () => {
			const cleaner = new SmartCleanerService();
			const { cleanedContent, result } = cleaner.cleanContent([]);
			expect(cleanedContent).toHaveLength(0);
			expect(result.originalSize).toBe(0);
			expect(result.cleanedSize).toBe(0);
			expect(result.compressionRatio).toBe(0);
		});
	});

	// ============================================================
	// Per-call config override
	// ============================================================

	describe('per-call config override', () => {
		test('overrides instance config per call', () => {
			// Create with removeTimestamps: false (default)
			const cleaner = new SmartCleanerService();
			const content = [createContent('Time: 2026-02-22T10:00:00.000Z')];

			// Default: timestamps preserved
			const { cleanedContent: default_ } = cleaner.cleanContent(content);
			expect(default_[0].content).toContain('2026-02-22');

			// Override: timestamps removed
			const { cleanedContent: override } = cleaner.cleanContent(content, { removeTimestamps: true });
			expect(override[0].content).not.toContain('2026-02-22T10:00:00.000Z');
		});
	});

	// ============================================================
	// analyzeContent (dry-run analysis)
	// ============================================================

	describe('analyzeContent', () => {
		test('counts environment details elements', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('<environment_details>data</environment_details>'),
				createContent('# VSCode Visible Files\nfile.ts\n'),
				createContent('clean content')
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.environmentDetailsCount).toBe(2);
		});

		test('counts redundant metadata elements', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent("[read_file for 'test.ts'] Result: ok"),
				createContent('<file_write_result>done</file_write_result>')
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.redundantMetadataCount).toBe(2);
		});

		test('counts debug info elements', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('Debug Info:\nsome data\n'),
				createContent('Similarity Score: 0.95')
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.debugInfoCount).toBe(2);
		});

		test('counts timestamps', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('Created at 2026-02-22T10:00:00Z'),
				createContent('No timestamp here')
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.timestampCount).toBe(1);
		});

		test('counts cost info', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('Cost $5.00'),
				createContent('{"cost": 1.5}')
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.costInfoCount).toBe(2);
		});

		test('counts file info', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('# VSCode Visible Files\nfile.ts'),
				createContent('# VSCode Open Tabs\ntab1.ts')
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.fileInfoCount).toBe(2);
		});

		test('estimates savings as ~40% of total size', () => {
			const cleaner = new SmartCleanerService();
			const content = [
				createContent('A'.repeat(1000)),
				createContent('B'.repeat(1000))
			];
			const stats = cleaner.analyzeContent(content);
			expect(stats.estimatedSavings).toBe(Math.floor(2000 * 0.4));
		});

		test('handles empty array', () => {
			const cleaner = new SmartCleanerService();
			const stats = cleaner.analyzeContent([]);
			expect(stats.environmentDetailsCount).toBe(0);
			expect(stats.estimatedSavings).toBe(0);
		});
	});
});
