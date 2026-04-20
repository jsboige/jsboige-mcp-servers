/**
 * Unit tests for SmartCleanerService
 * @module tests/unit/services/SmartCleanerService.test
 */

import { describe, it, expect } from 'vitest';
import { SmartCleanerService } from '../../../src/services/SmartCleanerService.js';
import { ClassifiedContent } from '../../../src/types/enhanced-conversation.js';

function makeContent(content: string, overrides: Partial<ClassifiedContent> = {}): ClassifiedContent {
	return {
		type: 'User',
		subType: 'UserMessage',
		content,
		index: 0,
		contentSize: content.length,
		isRelevant: true,
		confidenceScore: 1.0,
		...overrides,
	};
}

describe('SmartCleanerService', () => {
	const service = new SmartCleanerService();

	describe('cleanContent', () => {
		it('should return empty array for empty input', () => {
			const { cleanedContent, result } = service.cleanContent([]);
			expect(cleanedContent).toEqual([]);
			expect(result.originalSize).toBe(0);
			expect(result.compressionRatio).toBe(0);
		});

		it('should preserve clean content unchanged', () => {
			const items = [makeContent('Hello world')];
			const { cleanedContent, result } = service.cleanContent(items);
			expect(cleanedContent.length).toBe(1);
			expect(cleanedContent[0].content).toBe('Hello world');
			expect(result.compressionRatio).toBe(0);
		});

		it('should remove empty items after cleaning', () => {
			const items = [makeContent('<environment_details>foo</environment_details>')];
			const { cleanedContent } = service.cleanContent(items);
			expect(cleanedContent.length).toBe(0);
		});

		it('should compute compression ratio', () => {
			const items = [makeContent('Hello <environment_details>big block</environment_details> world')];
			const { result } = service.cleanContent(items);
			expect(result.originalSize).toBeGreaterThan(result.cleanedSize);
			expect(result.compressionRatio).toBeGreaterThan(0);
		});
	});

	describe('environment_details removal', () => {
		it('should remove XML environment_details blocks', () => {
			const items = [makeContent('before <environment_details>secret</environment_details> after')];
			const { cleanedContent, result } = service.cleanContent(items);
			expect(cleanedContent[0].content).toContain('before');
			expect(cleanedContent[0].content).toContain('after');
			expect(cleanedContent[0].content).not.toContain('environment_details');
			expect(result.removedElements.environmentDetails).toBe(1);
		});

		it('should remove VSCode metadata headers', () => {
			const items = [makeContent('# VSCode Visible Files\nfile1.ts\n# Current Time\n12:00\nreal content')];
			const { result } = service.cleanContent(items);
			expect(result.removedElements.environmentDetails).toBeGreaterThanOrEqual(1);
		});
	});

	describe('redundant metadata removal', () => {
		it('should remove file operation result markers', () => {
			const items = [makeContent("[read_file for 'config.ts'] Result:\nfile content here")];
			const { cleanedContent, result } = service.cleanContent(items);
			expect(cleanedContent[0].content).not.toContain('[read_file for');
			expect(result.removedElements.redundantMetadata).toBe(1);
		});

		it('should remove file_write_result XML blocks', () => {
			const items = [makeContent('before <file_write_result>ok</file_write_result> after')];
			const { cleanedContent, result } = service.cleanContent(items);
			expect(cleanedContent[0].content).not.toContain('file_write_result');
			expect(result.removedElements.redundantMetadata).toBe(1);
		});

		it('should remove problems and notice blocks', () => {
			const items = [makeContent('<problems>err</problems> <notice>warn</notice>')];
			const { result } = service.cleanContent(items);
			expect(result.removedElements.redundantMetadata).toBeGreaterThanOrEqual(1);
		});
	});

	describe('debug info removal', () => {
		it('should remove Debug Info sections', () => {
			const items = [makeContent('Debug Info: some debug\ncritical data')];
			const { result } = service.cleanContent(items);
			expect(result.removedElements.debugInfo).toBe(1);
		});

		it('should remove similarity scores', () => {
			const items = [makeContent('Similarity Score: 0.95\nactual content')];
			const { result } = service.cleanContent(items);
			expect(result.removedElements.debugInfo).toBe(1);
		});
	});

	describe('timestamp removal', () => {
		it('should remove ISO timestamps when enabled', () => {
			const items = [makeContent('Event at 2026-04-20T12:30:00.000Z happened')];
			const { cleanedContent, result } = service.cleanContent(items, { removeTimestamps: true });
			expect(cleanedContent[0].content).not.toContain('2026-04-20T12:30:00.000Z');
			expect(result.removedElements.timestamps).toBe(1);
		});

		it('should keep timestamps by default', () => {
			const items = [makeContent('Event at 2026-04-20T12:30:00.000Z happened')];
			const { cleanedContent, result } = service.cleanContent(items);
			expect(cleanedContent[0].content).toContain('2026-04-20T12:30:00.000Z');
			expect(result.removedElements.timestamps).toBe(0);
		});
	});

	describe('cost info removal', () => {
		it('should remove dollar amounts', () => {
			const items = [makeContent('Total: $12.34 for this operation')];
			const { cleanedContent, result } = service.cleanContent(items);
			expect(cleanedContent[0].content).not.toContain('$12.34');
			expect(result.removedElements.costInfo).toBe(1);
		});

		it('should remove JSON cost fields', () => {
			const items = [makeContent('"cost": 0.05, "tokensIn": 100')];
			const { result } = service.cleanContent(items);
			expect(result.removedElements.costInfo).toBeGreaterThanOrEqual(1);
		});
	});

	describe('whitespace handling', () => {
		it('should collapse excessive empty lines', () => {
			const items = [makeContent('line1\n\n\n\n\nline2')];
			const { cleanedContent } = service.cleanContent(items);
			const content = cleanedContent[0].content;
			const consecutiveEmpty = content.split('\n').reduce((max, line, i, arr) => {
				if (line.trim() === '' && i > 0 && arr[i - 1].trim() === '') return max + 1;
				return max;
			}, 0);
			expect(consecutiveEmpty).toBeLessThanOrEqual(1);
		});

		it('should trim trailing spaces', () => {
			const items = [makeContent('line with spaces   \nnext line')];
			const { cleanedContent } = service.cleanContent(items);
			expect(cleanedContent[0].content).not.toMatch(/ {2,}$/m);
		});
	});

	describe('constructor config override', () => {
		it('should accept custom config', () => {
			const custom = new SmartCleanerService({ removeTimestamps: true });
			const items = [makeContent('At 2026-04-20T12:30:00.000Z')];
			const { result } = custom.cleanContent(items);
			expect(result.removedElements.timestamps).toBe(1);
		});

		it('should allow disabling all removal steps', () => {
			const minimal = new SmartCleanerService({
				removeEnvironmentDetails: false,
				removeRedundantMetadata: false,
				removeDebugInfo: false,
				removeCostInfo: false,
				minimizeWhitespace: false,
				removeEmptyLines: false,
			});
			const items = [makeContent('<environment_details>keep</environment_details>')];
			const { cleanedContent } = minimal.cleanContent(items);
			expect(cleanedContent[0].content).toContain('environment_details');
		});
	});

	describe('analyzeContent', () => {
		it('should detect environment details without removing', () => {
			const items = [makeContent('<environment_details>data</environment_details>')];
			const stats = service.analyzeContent(items);
			expect(stats.environmentDetailsCount).toBe(1);
		});

		it('should detect timestamps', () => {
			const items = [makeContent('At 2026-04-20T12:30:00.000Z')];
			const stats = service.analyzeContent(items);
			expect(stats.timestampCount).toBe(1);
		});

		it('should estimate savings', () => {
			const items = [makeContent('x'.repeat(1000))];
			const stats = service.analyzeContent(items);
			expect(stats.estimatedSavings).toBeGreaterThan(0);
		});

		it('should return zeros for clean content', () => {
			const items = [makeContent('clean content only')];
			const stats = service.analyzeContent(items);
			expect(stats.environmentDetailsCount).toBe(0);
			expect(stats.redundantMetadataCount).toBe(0);
			expect(stats.debugInfoCount).toBe(0);
		});
	});
});
