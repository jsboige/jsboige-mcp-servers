/**
 * Tests pour InteractiveFormatter.ts
 * Issue #492 - Couverture du formateur interactif
 *
 * @module services/markdown-formatter/__tests__/InteractiveFormatter
 */

import { describe, test, expect } from 'vitest';
import { InteractiveFormatter } from '../InteractiveFormatter.js';
import type { ClassifiedContent } from '../../../types/enhanced-conversation.js';

function createMessage(type: string, subType: string, index: number): ClassifiedContent {
	return {
		type, subType, content: `Message ${index}`, index,
		contentSize: 100, isRelevant: true, confidenceScore: 0.8
	};
}

describe('InteractiveFormatter', () => {
	// ============================================================
	// generateNavigationAnchors
	// ============================================================

	describe('generateNavigationAnchors', () => {
		test('generates correct anchor format', () => {
			expect(InteractiveFormatter.generateNavigationAnchors(0, 'User')).toBe('message-0-user');
			expect(InteractiveFormatter.generateNavigationAnchors(5, 'Assistant')).toBe('message-5-assistant');
		});

		test('lowercases message type', () => {
			expect(InteractiveFormatter.generateNavigationAnchors(0, 'ToolCall')).toBe('message-0-toolcall');
		});
	});

	// ============================================================
	// generateMessageCounters
	// ============================================================

	describe('generateMessageCounters', () => {
		test('counts User and Assistant types', () => {
			const messages: ClassifiedContent[] = [
				createMessage('User', 'UserMessage', 0),
				createMessage('Assistant', 'ToolCall', 1),
				createMessage('User', 'UserMessage', 2),
				createMessage('Assistant', 'Completion', 3)
			];

			const counters = InteractiveFormatter.generateMessageCounters(messages);
			expect(counters.User).toBe(2);
			expect(counters.Assistant).toBe(2);
			expect(counters.total).toBe(4);
		});

		test('counts sub-types correctly', () => {
			const messages: ClassifiedContent[] = [
				createMessage('User', 'UserMessage', 0),
				createMessage('Assistant', 'ToolCall', 1),
				createMessage('User', 'ToolResult', 2),
				createMessage('Assistant', 'Completion', 3),
				createMessage('Assistant', 'Thinking', 4)
			];

			const counters = InteractiveFormatter.generateMessageCounters(messages);
			expect(counters.UserMessage).toBe(1);
			expect(counters.ToolCall).toBe(1);
			expect(counters.ToolResult).toBe(1);
			expect(counters.Completion).toBe(1);
			expect(counters.Thinking).toBe(1);
		});

		test('returns zeros for empty array', () => {
			const counters = InteractiveFormatter.generateMessageCounters([]);
			expect(counters.User).toBe(0);
			expect(counters.Assistant).toBe(0);
			expect(counters.total).toBe(0);
		});
	});

	// ============================================================
	// generateTableOfContents
	// ============================================================

	describe('generateTableOfContents', () => {
		const messages: ClassifiedContent[] = [
			createMessage('User', 'UserMessage', 0),
			createMessage('Assistant', 'ToolCall', 1),
			createMessage('User', 'ToolResult', 2)
		];

		test('generates HTML with toc-container', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages);
			expect(toc).toContain('toc-container');
			expect(toc).toContain('Table des Matières');
		});

		test('includes stats grid', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages);
			expect(toc).toContain('toc-stats-grid');
			expect(toc).toContain('toc-stat-card');
		});

		test('includes navigation links', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages);
			expect(toc).toContain('message-0-user');
			expect(toc).toContain('message-1-assistant');
			expect(toc).toContain('message-2-user');
		});

		test('includes progress bars by default', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages);
			expect(toc).toContain('toc-progress-bar');
		});

		test('disables progress bars when option is false', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages, { showProgressBars: false });
			expect(toc).not.toContain('toc-progress-bar');
		});

		test('includes search filter when enabled', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages, { enableSearchFilter: true });
			expect(toc).toContain('toc-search-input');
		});

		test('excludes search filter by default', () => {
			const toc = InteractiveFormatter.generateTableOfContents(messages);
			expect(toc).not.toContain('toc-search-input');
		});
	});

	// ============================================================
	// generateInteractiveScript
	// ============================================================

	describe('generateInteractiveScript', () => {
		test('returns script tag', () => {
			const script = InteractiveFormatter.generateInteractiveScript();
			expect(script).toContain('<script>');
			expect(script).toContain('</script>');
		});

		test('includes smooth scroll function', () => {
			const script = InteractiveFormatter.generateInteractiveScript();
			expect(script).toContain('smoothScrollToSection');
		});

		test('includes toggle functions', () => {
			const script = InteractiveFormatter.generateInteractiveScript();
			expect(script).toContain('toggleTruncation');
			expect(script).toContain('toggleExpandable');
		});

		test('includes copy to clipboard', () => {
			const script = InteractiveFormatter.generateInteractiveScript();
			expect(script).toContain('copyToClipboard');
		});

		test('includes DOMContentLoaded listener', () => {
			const script = InteractiveFormatter.generateInteractiveScript();
			expect(script).toContain('DOMContentLoaded');
		});

		test('includes scroll listener for active navigation', () => {
			const script = InteractiveFormatter.generateInteractiveScript();
			expect(script).toContain('updateActiveNavigation');
		});
	});
});
