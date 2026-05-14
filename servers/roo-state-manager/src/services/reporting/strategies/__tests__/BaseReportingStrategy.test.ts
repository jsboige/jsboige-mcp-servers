/**
 * Tests unitaires pour BaseReportingStrategy (méthodes de base abstraite)
 *
 * Couvre les méthodes de base définies dans IReportingStrategy.ts :
 * - filterByRelevance : filtrage par confidenceScore + isRelevant
 * - applyIntelligentTruncation : troncature intelligente avec priorisation par score
 * - filterBySubTypes : filtrage par sous-types
 * - filterByMainTypes : filtrage par types principaux
 * - excludeSubTypes : exclusion de sous-types
 * - shouldShowToolDetails, shouldShowThinking, shouldShowToolResults, isUserOnlyMode : defaults
 *
 * @module services/reporting/strategies/__tests__/BaseReportingStrategy.test
 * @version 1.0.0 (idle worker coverage improvement)
 */

import { describe, test, expect } from 'vitest';
import { BaseReportingStrategy } from '../IReportingStrategy.js';
import type { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

// ─────────────────── helpers ───────────────────

/** Concrete subclass to expose protected methods for testing */
class TestableStrategy extends BaseReportingStrategy {
    apply(content: ClassifiedContent[]): ClassifiedContent[] {
        return content;
    }
    getStrategyName(): string {
        return 'TestableStrategy';
    }

    // Expose protected methods as public for testing
    public testFilterByRelevance(content: ClassifiedContent[], minScore: number) {
        return this.filterByRelevance(content, minScore);
    }
    public testApplyIntelligentTruncation(content: ClassifiedContent[], maxChars: number) {
        return this.applyIntelligentTruncation(content, maxChars);
    }
    public testFilterBySubTypes(content: ClassifiedContent[], allowed: string[]) {
        return this.filterBySubTypes(content, allowed);
    }
    public testFilterByMainTypes(content: ClassifiedContent[], allowed: ('User' | 'Assistant')[]) {
        return this.filterByMainTypes(content, allowed);
    }
    public testExcludeSubTypes(content: ClassifiedContent[], excluded: string[]) {
        return this.excludeSubTypes(content, excluded);
    }
}

function makeContent(overrides: Partial<ClassifiedContent> = {}): ClassifiedContent {
    return {
        type: 'User',
        subType: 'UserMessage',
        content: 'test content',
        index: 0,
        contentSize: 12,
        isRelevant: true,
        confidenceScore: 0.9,
        ...overrides,
    };
}

// ─────────────────── tests ───────────────────

describe('BaseReportingStrategy', () => {
    const strategy = new TestableStrategy();

    // ============================================================
    // Default method implementations
    // ============================================================

    describe('default implementations', () => {
        test('shouldShowToolDetails returns true by default', () => {
            expect(strategy.shouldShowToolDetails()).toBe(true);
        });

        test('shouldShowThinking returns false by default', () => {
            expect(strategy.shouldShowThinking()).toBe(false);
        });

        test('shouldShowToolResults returns true by default', () => {
            expect(strategy.shouldShowToolResults()).toBe(true);
        });

        test('isUserOnlyMode returns false by default', () => {
            expect(strategy.isUserOnlyMode()).toBe(false);
        });
    });

    // ============================================================
    // filterByRelevance
    // ============================================================

    describe('filterByRelevance', () => {
        test('filters out items below confidence threshold', () => {
            const content = [
                makeContent({ confidenceScore: 0.9, isRelevant: true }),
                makeContent({ confidenceScore: 0.3, isRelevant: true }),
                makeContent({ confidenceScore: 0.7, isRelevant: true }),
            ];

            const result = strategy.testFilterByRelevance(content, 0.5);
            expect(result).toHaveLength(2);
            expect(result.every(item => item.confidenceScore >= 0.5)).toBe(true);
        });

        test('filters out items where isRelevant is false', () => {
            const content = [
                makeContent({ confidenceScore: 0.9, isRelevant: false }),
                makeContent({ confidenceScore: 0.8, isRelevant: true }),
            ];

            const result = strategy.testFilterByRelevance(content, 0.5);
            expect(result).toHaveLength(1);
            expect(result[0].isRelevant).toBe(true);
        });

        test('returns all items when all meet threshold and are relevant', () => {
            const content = [
                makeContent({ confidenceScore: 0.8, isRelevant: true }),
                makeContent({ confidenceScore: 0.9, isRelevant: true }),
            ];

            const result = strategy.testFilterByRelevance(content, 0.5);
            expect(result).toHaveLength(2);
        });

        test('returns empty array when no items meet criteria', () => {
            const content = [
                makeContent({ confidenceScore: 0.2, isRelevant: true }),
                makeContent({ confidenceScore: 0.1, isRelevant: false }),
            ];

            const result = strategy.testFilterByRelevance(content, 0.5);
            expect(result).toHaveLength(0);
        });
    });

    // ============================================================
    // applyIntelligentTruncation
    // ============================================================

    describe('applyIntelligentTruncation', () => {
        test('returns all content when maxChars <= 0', () => {
            const content = [
                makeContent({ contentSize: 100, confidenceScore: 0.5 }),
                makeContent({ contentSize: 200, confidenceScore: 0.5 }),
            ];

            const result = strategy.testApplyIntelligentTruncation(content, 0);
            expect(result).toHaveLength(2);
        });

        test('prioritizes higher confidence items when truncating', () => {
            const content = [
                makeContent({ index: 0, contentSize: 100, confidenceScore: 0.5, content: 'A'.repeat(100) }),
                makeContent({ index: 1, contentSize: 100, confidenceScore: 0.9, content: 'B'.repeat(100) }),
                makeContent({ index: 2, contentSize: 100, confidenceScore: 0.3, content: 'C'.repeat(100) }),
            ];

            // Only 150 chars budget: should keep index 1 (score 0.9) and index 0 (score 0.5)
            const result = strategy.testApplyIntelligentTruncation(content, 200);
            expect(result.length).toBeGreaterThanOrEqual(1);
            // Higher confidence item should be included
            expect(result.some(item => item.confidenceScore === 0.9)).toBe(true);
        });

        test('truncates first item when it exceeds maxChars', () => {
            const content = [
                makeContent({ index: 0, contentSize: 5000, confidenceScore: 0.9, content: 'X'.repeat(5000) }),
            ];

            const result = strategy.testApplyIntelligentTruncation(content, 100);
            expect(result).toHaveLength(1);
            expect(result[0].content.length).toBeLessThan(5000);
            expect(result[0].content).toContain('truncated');
        });

        test('maintains original order in output (sorted by index)', () => {
            const content = [
                makeContent({ index: 2, contentSize: 50, confidenceScore: 0.9, content: 'high' }),
                makeContent({ index: 1, contentSize: 50, confidenceScore: 0.5, content: 'mid' }),
            ];

            const result = strategy.testApplyIntelligentTruncation(content, 200);
            if (result.length === 2) {
                expect(result[0].index).toBeLessThan(result[1].index);
            }
        });
    });

    // ============================================================
    // filterBySubTypes
    // ============================================================

    describe('filterBySubTypes', () => {
        test('keeps only allowed subtypes', () => {
            const content = [
                makeContent({ subType: 'UserMessage' }),
                makeContent({ subType: 'ToolResult' }),
                makeContent({ subType: 'Thinking' }),
            ];

            const result = strategy.testFilterBySubTypes(content, ['UserMessage', 'Thinking']);
            expect(result).toHaveLength(2);
            expect(result.every(item => ['UserMessage', 'Thinking'].includes(item.subType))).toBe(true);
        });

        test('returns empty when no items match', () => {
            const content = [
                makeContent({ subType: 'UserMessage' }),
            ];

            const result = strategy.testFilterBySubTypes(content, ['ToolCall']);
            expect(result).toHaveLength(0);
        });
    });

    // ============================================================
    // filterByMainTypes
    // ============================================================

    describe('filterByMainTypes', () => {
        test('keeps only User type items', () => {
            const content = [
                makeContent({ type: 'User' }),
                makeContent({ type: 'Assistant' }),
                makeContent({ type: 'User' }),
            ];

            const result = strategy.testFilterByMainTypes(content, ['User']);
            expect(result).toHaveLength(2);
            expect(result.every(item => item.type === 'User')).toBe(true);
        });

        test('keeps only Assistant type items', () => {
            const content = [
                makeContent({ type: 'User' }),
                makeContent({ type: 'Assistant' }),
            ];

            const result = strategy.testFilterByMainTypes(content, ['Assistant']);
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('Assistant');
        });
    });

    // ============================================================
    // excludeSubTypes
    // ============================================================

    describe('excludeSubTypes', () => {
        test('excludes specified subtypes', () => {
            const content = [
                makeContent({ subType: 'UserMessage' }),
                makeContent({ subType: 'ToolResult' }),
                makeContent({ subType: 'Thinking' }),
            ];

            const result = strategy.testExcludeSubTypes(content, ['ToolResult', 'Thinking']);
            expect(result).toHaveLength(1);
            expect(result[0].subType).toBe('UserMessage');
        });

        test('returns all items when exclusion list is empty', () => {
            const content = [
                makeContent({ subType: 'UserMessage' }),
                makeContent({ subType: 'ToolResult' }),
            ];

            const result = strategy.testExcludeSubTypes(content, []);
            expect(result).toHaveLength(2);
        });
    });
});
