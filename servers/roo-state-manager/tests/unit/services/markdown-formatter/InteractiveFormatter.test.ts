import { describe, it, expect } from 'vitest';
import { InteractiveFormatter } from '../../../../src/services/markdown-formatter/InteractiveFormatter.js';
import { ClassifiedContent } from '../../../../src/types/enhanced-conversation.js';

describe('InteractiveFormatter', () => {
    const mockMessages: ClassifiedContent[] = [
        { type: 'User', subType: 'UserMessage', content: 'Hello', index: 0, contentSize: 5, isRelevant: true, confidenceScore: 1 },
        { type: 'Assistant', subType: 'Completion', content: 'Hi', index: 1, contentSize: 2, isRelevant: true, confidenceScore: 1 },
        { type: 'Assistant', subType: 'ToolCall', content: 'call', index: 2, contentSize: 4, isRelevant: true, confidenceScore: 1 }
    ];

    describe('generateTableOfContents', () => {
        it('should generate TOC with stats and links', () => {
            const toc = InteractiveFormatter.generateTableOfContents(mockMessages);
            
            expect(toc).toContain('Table des Matières');
            expect(toc).toContain('toc-stats-grid');
            expect(toc).toContain('toc-links');
            expect(toc).toContain('#message-0-user');
            expect(toc).toContain('#message-1-assistant');
        });

        it('should include search input if enabled', () => {
            const toc = InteractiveFormatter.generateTableOfContents(mockMessages, { enableSearchFilter: true } as any);
            expect(toc).toContain('toc-search-input');
        });

        it('should hide progress bars if disabled', () => {
            const toc = InteractiveFormatter.generateTableOfContents(mockMessages, { showProgressBars: false } as any);
            expect(toc).not.toContain('toc-progress-bar');
        });
    });

    describe('generateNavigationAnchors', () => {
        it('should generate correct anchor ID', () => {
            const anchor = InteractiveFormatter.generateNavigationAnchors(0, 'User');
            expect(anchor).toBe('message-0-user');
        });
    });

    describe('generateMessageCounters', () => {
        it('should count message types correctly', () => {
            const counters = InteractiveFormatter.generateMessageCounters(mockMessages);
            
            expect(counters.User).toBe(1);
            expect(counters.Assistant).toBe(2); // Completion + ToolCall
            expect(counters.UserMessage).toBe(1);
            expect(counters.Completion).toBe(1);
            expect(counters.ToolCall).toBe(1);
            expect(counters.total).toBe(3);
        });
    });

    describe('generateInteractiveScript', () => {
        it('should return script tag with JS content', () => {
            const script = InteractiveFormatter.generateInteractiveScript();
            
            expect(script).toContain('<script>');
            expect(script).toContain('smoothScrollToSection');
            expect(script).toContain('toggleTruncation');
            expect(script).toContain('filterTableOfContents');
            expect(script).toContain('</script>');
        });
    });
});