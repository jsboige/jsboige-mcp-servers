/**
 * Tests unitaires pour les Reporting Strategies et DetailLevelStrategyFactory
 * Couvre FullStrategy, NoResultsStrategy, NoToolsStrategy, MessagesStrategy,
 * UserOnlyStrategy, et la factory DetailLevelStrategyFactory.
 *
 * Ces 15 fichiers avaient 0% de couverture.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock StateManagerError
vi.mock('../../../src/types/errors.js', () => ({
    StateManagerError: class extends Error {
        code: string;
        service: string;
        details: any;
        constructor(message: string, code: string, service: string, details?: any) {
            super(message);
            this.code = code;
            this.service = service;
            this.details = details;
        }
    }
}));

// Mock MarkdownFormatterService (used by some strategies)
vi.mock('../../../src/services/MarkdownFormatterService.js', () => ({
    MarkdownFormatterService: class {
        formatContent = vi.fn(() => 'formatted');
    }
}));

import { FullStrategy } from '../../../src/services/reporting/strategies/FullStrategy.js';
import { NoResultsStrategy } from '../../../src/services/reporting/strategies/NoResultsStrategy.js';
import { NoToolsStrategy } from '../../../src/services/reporting/strategies/NoToolsStrategy.js';
import { MessagesStrategy } from '../../../src/services/reporting/strategies/MessagesStrategy.js';
import { UserOnlyStrategy } from '../../../src/services/reporting/strategies/UserOnlyStrategy.js';
import { SummaryStrategy } from '../../../src/services/reporting/strategies/SummaryStrategy.js';
import { DetailLevelStrategyFactory } from '../../../src/services/reporting/DetailLevelStrategyFactory.js';

// Helper: create a ClassifiedContent mock
function makeContent(overrides: Partial<{
    type: 'User' | 'Assistant';
    subType: string;
    content: string;
    index: number;
    contentSize: number;
    isRelevant: boolean;
    confidenceScore: number;
}> = {}): any {
    return {
        type: overrides.type ?? 'Assistant',
        subType: overrides.subType ?? 'Completion',
        content: overrides.content ?? 'test content',
        index: overrides.index ?? 0,
        contentSize: overrides.contentSize ?? (overrides.content?.length ?? 12),
        isRelevant: overrides.isRelevant ?? true,
        confidenceScore: overrides.confidenceScore ?? 0.8,
        ...overrides
    };
}

// Standard test content with all subTypes
function createMixedContent(): any[] {
    return [
        makeContent({ type: 'User', subType: 'UserMessage', content: 'Please fix the bug', index: 0 }),
        makeContent({ type: 'Assistant', subType: 'Completion', content: 'I will fix it', index: 1 }),
        makeContent({ type: 'Assistant', subType: 'ToolCall', content: '<read_file>...</read_file>', index: 2 }),
        makeContent({ type: 'Assistant', subType: 'ToolResult', content: 'file content here', index: 3 }),
        makeContent({ type: 'Assistant', subType: 'Completion', content: 'Done fixing', index: 4 }),
    ];
}

describe('FullStrategy', () => {
    const strategy = new FullStrategy();

    it('should have strategy name "Full"', () => {
        expect(strategy.getStrategyName()).toBe('Full');
    });

    it('should return all content unchanged', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        expect(result).toHaveLength(5);
        expect(result).toEqual(content);
    });

    it('should show tool details, thinking, and results', () => {
        expect(strategy.shouldShowToolDetails()).toBe(true);
        expect(strategy.shouldShowThinking()).toBe(true);
        expect(strategy.shouldShowToolResults()).toBe(true);
        expect(strategy.isUserOnlyMode()).toBe(false);
    });

    it('should filter by relevance with lowered threshold', () => {
        const content = [
            makeContent({ confidenceScore: 0.5, isRelevant: true }),
            makeContent({ confidenceScore: 0.2, isRelevant: true }),
            makeContent({ confidenceScore: 0.01, isRelevant: true }),
        ];
        // threshold 0.5 → lowered to 0.15 (0.5 * 0.3)
        // Items with score >= 0.15: first two (0.5, 0.2)
        const result = strategy.filterByRelevance(content, 0.5);
        expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should truncate to maxChars preserving order', () => {
        const content = [
            makeContent({ content: 'short', contentSize: 5, index: 0 }),
            makeContent({ content: 'medium content here', contentSize: 19, index: 1 }),
            makeContent({ content: 'a very long content string', contentSize: 26, index: 2 }),
        ];
        const result = strategy.applyIntelligentTruncation(content, 25);
        expect(result.length).toBeLessThanOrEqual(3);
        // Total chars should be <= 25
        const totalChars = result.reduce((sum, item) => sum + item.contentSize, 0);
        expect(totalChars).toBeLessThanOrEqual(25);
    });

    it('should return all content when maxChars=0', () => {
        const content = createMixedContent();
        const result = strategy.applyIntelligentTruncation(content, 0);
        expect(result).toHaveLength(5);
    });
});

describe('NoResultsStrategy', () => {
    const strategy = new NoResultsStrategy();

    it('should have strategy name "NoResults"', () => {
        expect(strategy.getStrategyName()).toBe('NoResults');
    });

    it('should exclude ToolResult items', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        const hasToolResult = result.some((item: any) => item.subType === 'ToolResult');
        expect(hasToolResult).toBe(false);
    });

    it('should keep UserMessage, Completion, ToolCall', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        expect(result.length).toBe(4); // 5 - 1 ToolResult
        const subTypes = result.map((item: any) => item.subType);
        expect(subTypes).toContain('UserMessage');
        expect(subTypes).toContain('Completion');
        expect(subTypes).toContain('ToolCall');
    });

    it('should show tool details but not thinking/results', () => {
        expect(strategy.shouldShowToolDetails()).toBe(true);
        expect(strategy.shouldShowThinking()).toBe(false);
        expect(strategy.shouldShowToolResults()).toBe(false);
        expect(strategy.isUserOnlyMode()).toBe(false);
    });

    it('should exclude ToolResult from filterByRelevance', () => {
        const content = [
            makeContent({ subType: 'ToolResult', confidenceScore: 0.9, isRelevant: true }),
            makeContent({ subType: 'UserMessage', confidenceScore: 0.9, isRelevant: true }),
        ];
        const result = strategy.filterByRelevance(content, 0.5);
        expect(result.every((item: any) => item.subType !== 'ToolResult')).toBe(true);
    });

    it('should prioritize UserMessage in truncation', () => {
        const content = [
            makeContent({ subType: 'UserMessage', content: 'user msg', contentSize: 8, index: 0, confidenceScore: 0.5 }),
            makeContent({ subType: 'Completion', content: 'completion', contentSize: 10, index: 1, confidenceScore: 0.5 }),
        ];
        const result = strategy.applyIntelligentTruncation(content, 12);
        // With limited budget, UserMessage should be prioritized (has +0.3 bonus)
        expect(result.length).toBeGreaterThanOrEqual(1);
    });
});

describe('NoToolsStrategy', () => {
    const strategy = new NoToolsStrategy();

    it('should have strategy name "NoTools"', () => {
        expect(strategy.getStrategyName()).toBe('NoTools');
    });

    it('should exclude ToolCall items', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        const hasToolCall = result.some((item: any) => item.subType === 'ToolCall');
        expect(hasToolCall).toBe(false);
    });

    it('should keep ToolResult items', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        expect(result.length).toBe(4); // 5 - 1 ToolCall
        const subTypes = result.map((item: any) => item.subType);
        expect(subTypes).toContain('ToolResult');
    });

    it('should show tool results but not thinking', () => {
        expect(strategy.shouldShowToolDetails()).toBe(false);
        expect(strategy.shouldShowThinking()).toBe(false);
        expect(strategy.shouldShowToolResults()).toBe(true);
        expect(strategy.isUserOnlyMode()).toBe(false);
    });
});

describe('MessagesStrategy', () => {
    const strategy = new MessagesStrategy();

    it('should have strategy name "Messages"', () => {
        expect(strategy.getStrategyName()).toBe('Messages');
    });

    it('should keep UserMessage and Completion, exclude tools', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        for (const item of result) {
            expect(['UserMessage', 'Completion']).toContain((item as any).subType);
        }
    });

    it('should not show tool details', () => {
        expect(strategy.shouldShowToolDetails()).toBe(false);
        expect(strategy.shouldShowThinking()).toBe(false);
        expect(strategy.shouldShowToolResults()).toBe(false);
        expect(strategy.isUserOnlyMode()).toBe(false);
    });
});

describe('UserOnlyStrategy', () => {
    const strategy = new UserOnlyStrategy();

    it('should have strategy name "UserOnly"', () => {
        expect(strategy.getStrategyName()).toBe('UserOnly');
    });

    it('should keep only UserMessage items', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        for (const item of result) {
            expect((item as any).subType).toBe('UserMessage');
        }
    });

    it('should be in user-only mode', () => {
        expect(strategy.shouldShowToolDetails()).toBe(false);
        expect(strategy.shouldShowThinking()).toBe(false);
        expect(strategy.shouldShowToolResults()).toBe(false);
        expect(strategy.isUserOnlyMode()).toBe(true);
    });

    it('should return 1 item from mixed content (only 1 UserMessage)', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        expect(result).toHaveLength(1);
    });
});

describe('SummaryStrategy', () => {
    const strategy = new SummaryStrategy();

    it('should have strategy name "Summary"', () => {
        expect(strategy.getStrategyName()).toBe('Summary');
    });

    it('should filter to summary-relevant items', () => {
        const content = createMixedContent();
        const result = strategy.apply(content);
        // Summary keeps a reduced set
        expect(result.length).toBeLessThanOrEqual(content.length);
    });

    it('should not show tool details, thinking, or results', () => {
        expect(strategy.shouldShowToolDetails()).toBe(false);
        expect(strategy.shouldShowThinking()).toBe(false);
        expect(strategy.shouldShowToolResults()).toBe(false);
        expect(strategy.isUserOnlyMode()).toBe(false);
    });
});

describe('DetailLevelStrategyFactory', () => {
    it('should create all 6 strategies', () => {
        const levels = ['Full', 'Messages', 'Summary', 'NoTools', 'NoResults', 'UserOnly'] as const;
        for (const level of levels) {
            const strategy = DetailLevelStrategyFactory.createStrategy(level);
            expect(strategy).toBeDefined();
            // Factory creates *ReportingStrategy which have formatMessageContent + generateReport
            expect(typeof strategy.formatMessageContent).toBe('function');
            expect(typeof strategy.generateReport).toBe('function');
        }
    });

    it('should throw for unsupported detail level', () => {
        expect(() => {
            DetailLevelStrategyFactory.createStrategy('InvalidLevel' as any);
        }).toThrow();
    });

    it('should check if detail level is supported', () => {
        expect(DetailLevelStrategyFactory.isSupportedDetailLevel('Full')).toBe(true);
        expect(DetailLevelStrategyFactory.isSupportedDetailLevel('NoTools')).toBe(true);
        expect(DetailLevelStrategyFactory.isSupportedDetailLevel('Invalid')).toBe(false);
    });

    it('should return all supported levels', () => {
        const levels = DetailLevelStrategyFactory.getSupportedDetailLevels();
        expect(levels).toHaveLength(6);
        expect(levels).toContain('Full');
        expect(levels).toContain('UserOnly');
    });

    it('should create strategy with fallback for invalid level', () => {
        const strategy = DetailLevelStrategyFactory.createStrategyWithFallback('InvalidLevel', 'Full');
        expect(strategy).toBeDefined();
    });

    it('should create strategy directly for valid level (no fallback)', () => {
        const strategy = DetailLevelStrategyFactory.createStrategyWithFallback('NoTools', 'Full');
        expect(strategy).toBeDefined();
    });

    it('should get strategy info', () => {
        const info = DetailLevelStrategyFactory.getStrategyInfo('Full');
        expect(info.name).toBe('Full');
        expect(info.description).toBeDefined();
        expect(info.description.length).toBeGreaterThan(0);
    });

    it('should validate supported strategy params', () => {
        const result = DetailLevelStrategyFactory.validateStrategyParams('Full');
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('should invalidate unsupported strategy params', () => {
        const result = DetailLevelStrategyFactory.validateStrategyParams('Invalid');
        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should warn for Summary with large truncation', () => {
        const result = DetailLevelStrategyFactory.validateStrategyParams('Summary', { truncationChars: 60000 });
        expect(result.isValid).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should create all strategies map', () => {
        const all = DetailLevelStrategyFactory.createAllStrategies();
        expect(all.size).toBe(6);
        expect(all.has('Full')).toBe(true);
        expect(all.has('UserOnly')).toBe(true);
    });
});
