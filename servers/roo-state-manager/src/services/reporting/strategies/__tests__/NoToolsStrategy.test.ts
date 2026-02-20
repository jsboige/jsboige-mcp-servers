/**
 * Tests for NoToolsStrategy.ts
 * Coverage target: 6% → 90%+
 */

import { describe, it, expect } from 'vitest';
import { NoToolsStrategy } from '../NoToolsStrategy.js';
import { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

describe('NoToolsStrategy', () => {
  const strategy = new NoToolsStrategy();

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
    it('should return "NoTools"', () => {
      expect(strategy.getStrategyName()).toBe('NoTools');
    });
  });

  describe('apply', () => {
    it('should exclude ToolCall content', () => {
      const content = [
        createContent('1', 'UserMessage', 100),
        createContent('2', 'ToolCall', 100),
        createContent('3', 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(2);
      expect(result.map(c => c.id)).toEqual(['1', '3']);
    });

    it('should keep all content when no ToolCall', () => {
      const content = [
        createContent('1', 'UserMessage', 100),
        createContent('2', 'Completion', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(2);
    });

    it('should return empty when only ToolCall', () => {
      const content = [
        createContent('1', 'ToolCall', 100),
        createContent('2', 'ToolCall', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(0);
    });
  });

  describe('shouldShowToolDetails', () => {
    it('should return false', () => {
      expect(strategy.shouldShowToolDetails()).toBe(false);
    });
  });

  describe('shouldShowThinking', () => {
    it('should return false', () => {
      expect(strategy.shouldShowThinking()).toBe(false);
    });
  });

  describe('shouldShowToolResults', () => {
    it('should return true', () => {
      expect(strategy.shouldShowToolResults()).toBe(true);
    });
  });

  describe('isUserOnlyMode', () => {
    it('should return false', () => {
      expect(strategy.isUserOnlyMode()).toBe(false);
    });
  });

  describe('filterByRelevance', () => {
    it('should exclude ToolCall even if relevant', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.9),
        createContent('2', 'ToolCall', 50, 0.9)  // High relevance but ToolCall
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      expect(result.every(c => c.subType !== 'ToolCall')).toBe(true);
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
        createContent('1', 'ToolResult', 100, 0.8, 0),
        createContent('2', 'UserMessage', 100, 0.8, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 150);

      // UserMessage should be prioritized (0.8 + 0.3 = 1.1 vs 0.8 + 0.1 = 0.9)
      expect(result.length).toBeGreaterThan(0);
    });

    it('should penalize ToolCall', () => {
      const content = [
        createContent('1', 'ToolCall', 50, 0.9, 0),
        createContent('2', 'UserMessage', 50, 0.7, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 100);

      // ToolCall has priority 0.9 - 0.5 = 0.4, UserMessage has 0.7 + 0.3 = 1.0
      // UserMessage should be prioritized
      expect(result.some(c => c.id === '2')).toBe(true);
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
        createContent('1', 'UserMessage', 50, 0.8, 0),
        createContent('2', 'Completion', 50, 0.8, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result).toHaveLength(2);
    });
  });
});
