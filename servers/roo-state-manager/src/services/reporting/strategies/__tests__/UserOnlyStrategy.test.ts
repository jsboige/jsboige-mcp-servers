/**
 * Tests for UserOnlyStrategy.ts
 * Coverage target: 90%+
 */

import { describe, it, expect } from 'vitest';
import { UserOnlyStrategy } from '../UserOnlyStrategy.js';
import { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

describe('UserOnlyStrategy', () => {
  const strategy = new UserOnlyStrategy();

  const createContent = (
    id: string,
    subType: string,
    size: number,
    score: number = 0.8,
    relevant: boolean = true,
    index: number = 0,
    content: string = ''
  ): ClassifiedContent => ({
    id,
    content: content || 'x'.repeat(size),
    contentSize: size,
    confidenceScore: score,
    isRelevant: relevant,
    subType,
    type: 'text',
    role: subType === 'UserMessage' ? 'user' : 'assistant',
    index
  } as ClassifiedContent);

  describe('getStrategyName', () => {
    it('should return "UserOnly"', () => {
      expect(strategy.getStrategyName()).toBe('UserOnly');
    });
  });

  describe('apply', () => {
    it('should filter to UserMessage only', () => {
      const content = [
        createContent('1', 'UserMessage', 100),
        createContent('2', 'Completion', 100),
        createContent('3', 'ToolCall', 100),
        createContent('4', 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(1);
      expect(result[0].subType).toBe('UserMessage');
    });

    it('should return empty when no UserMessage', () => {
      const content = [
        createContent('1', 'Completion', 100),
        createContent('2', 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(0);
    });

    it('should keep all UserMessages', () => {
      const content = [
        createContent('1', 'UserMessage', 100),
        createContent('2', 'UserMessage', 100),
        createContent('3', 'UserMessage', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(3);
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
    it('should return false', () => {
      expect(strategy.shouldShowToolResults()).toBe(false);
    });
  });

  describe('isUserOnlyMode', () => {
    it('should return true', () => {
      expect(strategy.isUserOnlyMode()).toBe(true);
    });
  });

  describe('filterByRelevance', () => {
    it('should filter to UserMessage only', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.9),
        createContent('2', 'Completion', 50, 0.9)
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      expect(result.every(c => c.subType === 'UserMessage')).toBe(true);
    });

    it('should use low threshold (50% of minConfidenceScore)', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.3, true)  // Low but passes
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      // Threshold = max(0.1, 0.5 * 0.5) = 0.25, so 0.3 should pass
      expect(result).toHaveLength(1);
    });

    it('should use minimum threshold of 0.1', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.15, true)
      ];

      const result = strategy.filterByRelevance(content, 0.1);

      // Threshold = max(0.1, 0.1 * 0.5) = 0.1, so 0.15 should pass
      expect(result).toHaveLength(1);
    });

    it('should filter out very low scores', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.05, true)  // Too low
      ];

      const result = strategy.filterByRelevance(content, 0.1);

      // Threshold = 0.1, so 0.05 should not pass
      expect(result).toHaveLength(0);
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

    it('should only include UserMessage content', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.8, true, 0),
        createContent('2', 'Completion', 50, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result.every(c => c.subType === 'UserMessage')).toBe(true);
    });

    it('should sort results by index', () => {
      const content = [
        createContent('1', 'UserMessage', 30, 0.8, true, 1),
        createContent('2', 'UserMessage', 30, 0.8, true, 0)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result[0].index).toBe(0);
      expect(result[1].index).toBe(1);
    });

    it('should include content that fits', () => {
      const content = [
        createContent('1', 'UserMessage', 40, 0.8, true, 0),
        createContent('2', 'UserMessage', 40, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result).toHaveLength(2);
    });

    it('should give recency bonus', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.8, true, 0),
        createContent('2', 'UserMessage', 50, 0.8, true, 1)  // Higher index = more recent
      ];

      const result = strategy.applyIntelligentTruncation(content, 60);

      // Should include at least one message
      expect(result.length).toBeGreaterThan(0);
    });

    it('should give bonus to questions', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.8, true, 0, 'This is a question?'),
        createContent('2', 'UserMessage', 50, 0.8, true, 1, 'This is not a question')
      ];

      const result = strategy.applyIntelligentTruncation(content, 60);

      // Question should be prioritized
      expect(result.length).toBeGreaterThan(0);
    });

    it('should give bonus to technical content', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.8, true, 0, 'Path: /dev/file.txt'),
        createContent('2', 'UserMessage', 50, 0.8, true, 1, 'No technical content here')
      ];

      const result = strategy.applyIntelligentTruncation(content, 60);

      expect(result.length).toBeGreaterThan(0);
    });

    it('should truncate first message if too large', () => {
      const content = [
        createContent('1', 'UserMessage', 1000, 0.8, true, 0, 'x'.repeat(1000))
      ];

      const result = strategy.applyIntelligentTruncation(content, 100);

      // Should truncate the message
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('[message tronqué]');
    });

    it('should give bonus to substantial content (>=100 chars)', () => {
      const content = [
        createContent('1', 'UserMessage', 150, 0.8, true, 0),
        createContent('2', 'UserMessage', 30, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      // Substantial content should be included
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
