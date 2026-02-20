/**
 * Tests for NoResultsStrategy.ts
 * Coverage target: 90%+
 */

import { describe, it, expect } from 'vitest';
import { NoResultsStrategy } from '../NoResultsStrategy.js';
import { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

describe('NoResultsStrategy', () => {
  const strategy = new NoResultsStrategy();

  const createContent = (
    id: string,
    subType: string,
    size: number,
    score: number = 0.8,
    index: number = 0
  ): ClassifiedContent => ({
    id,
    content: 'x'.repeat(size),
    contentSize: size,
    confidenceScore: score,
    isRelevant: true,
    subType,
    type: 'text',
    role: 'assistant',
    index
  } as ClassifiedContent);

  describe('getStrategyName', () => {
    it('should return "NoResults"', () => {
      expect(strategy.getStrategyName()).toBe('NoResults');
    });
  });

  describe('apply', () => {
    it('should exclude ToolResult content', () => {
      const content = [
        createContent('1', 'UserMessage', 100),
        createContent('2', 'ToolCall', 100),
        createContent('3', 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(2);
      expect(result.map(c => c.id)).toEqual(['1', '2']);
    });

    it('should keep ToolCall content', () => {
      const content = [
        createContent('1', 'ToolCall', 100),
        createContent('2', 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(1);
      expect(result[0].subType).toBe('ToolCall');
    });

    it('should keep all content when no ToolResult', () => {
      const content = [
        createContent('1', 'UserMessage', 100),
        createContent('2', 'Completion', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(2);
    });

    it('should return empty when only ToolResult', () => {
      const content = [
        createContent('1', 'ToolResult', 100),
        createContent('2', 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(0);
    });
  });

  describe('shouldShowToolDetails', () => {
    it('should return true', () => {
      expect(strategy.shouldShowToolDetails()).toBe(true);
    });
  });

  describe('shouldShowThinking', () => {
    it('should return false', () => {
      expect(strategy.shouldShowThinking()).toBe(false);
    });
  });

  describe('shouldShowToolResults', () => {
    it('should return false', () => {
      expect(strategy.shouldShowToolResults()).toBe(false);
    });
  });

  describe('isUserOnlyMode', () => {
    it('should return false', () => {
      expect(strategy.isUserOnlyMode()).toBe(false);
    });
  });

  describe('filterByRelevance', () => {
    it('should exclude ToolResult even if relevant', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.9),
        createContent('2', 'ToolResult', 50, 0.9)  // High relevance but ToolResult
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      expect(result.every(c => c.subType !== 'ToolResult')).toBe(true);
    });

    it('should keep ToolCall content', () => {
      const content = [
        createContent('1', 'ToolCall', 50, 0.9),
        createContent('2', 'ToolResult', 50, 0.9)
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      expect(result.some(c => c.subType === 'ToolCall')).toBe(true);
    });
  });

  describe('applyIntelligentTruncation', () => {
    it('should return content unchanged when maxChars is 0', () => {
      const content = [createContent('1', 'UserMessage', 100)];
      const result = strategy.applyIntelligentTruncation(content, 0);

      expect(result).toEqual(content);
    });

    it('should return content unchanged when maxChars is negative', () => {
      const content = [createContent('1', 'UserMessage', 100)];
      const result = strategy.applyIntelligentTruncation(content, -1);

      expect(result).toEqual(content);
    });

    it('should prioritize UserMessage over ToolResult', () => {
      const content = [
        createContent('1', 'ToolResult', 50, 0.8, 0),
        createContent('2', 'UserMessage', 50, 0.8, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 80);

      // UserMessage should be prioritized (0.8 + 0.3 = 1.1 vs 0.8 - 0.8 = 0.0)
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(c => c.subType === 'UserMessage')).toBe(true);
    });

    it('should prioritize ToolCall over ToolResult', () => {
      const content = [
        createContent('1', 'ToolCall', 30, 0.8, 0),
        createContent('2', 'ToolResult', 30, 0.8, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 60);

      // ToolCall should be prioritized (0.8 + 0.2 = 1.0 vs 0.8 - 0.8 = 0.0)
      expect(result.some(c => c.subType === 'ToolCall')).toBe(true);
    });

    it('should sort results by index', () => {
      const content = [
        createContent('1', 'Completion', 30, 0.8, 1),
        createContent('2', 'UserMessage', 30, 0.8, 0)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      // Should be sorted by index
      expect(result.length).toBe(2);
      expect(result[0].index).toBe(0);
      expect(result[1].index).toBe(1);
    });

    it('should include all content that fits', () => {
      const content = [
        createContent('1', 'UserMessage', 40, 0.8, 0),
        createContent('2', 'Completion', 40, 0.8, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result).toHaveLength(2);
    });

    it('should penalize ToolResult heavily', () => {
      const content = [
        createContent('1', 'ToolResult', 50, 0.9, 0),  // High score but penalized
        createContent('2', 'UserMessage', 50, 0.5, 1)  // Low score but boosted
      ];

      const result = strategy.applyIntelligentTruncation(content, 60);

      // UserMessage (0.5 + 0.3 = 0.8) should beat ToolResult (0.9 - 0.8 = 0.1)
      expect(result.some(c => c.subType === 'UserMessage')).toBe(true);
    });
  });
});
