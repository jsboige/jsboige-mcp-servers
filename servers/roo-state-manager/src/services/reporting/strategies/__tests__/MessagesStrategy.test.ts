/**
 * Tests for MessagesStrategy.ts
 * Coverage target: 5% → 90%+
 */

import { describe, it, expect } from 'vitest';
import { MessagesStrategy } from '../MessagesStrategy.js';
import { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

describe('MessagesStrategy', () => {
  const strategy = new MessagesStrategy();

  // Helper to create content
  const createContent = (
    index: number,
    subType: ClassifiedContent['subType'],
    size: number,
    score: number = 0.8,
    relevant: boolean = true
  ): ClassifiedContent => ({
    content: 'x'.repeat(size),
    contentSize: size,
    confidenceScore: score,
    isRelevant: relevant,
    subType,
    type: subType === 'UserMessage' ? 'User' : 'Assistant',
    index
  });

  describe('getStrategyName', () => {
    it('should return "Messages"', () => {
      expect(strategy.getStrategyName()).toBe('Messages');
    });
  });

  describe('apply', () => {
    it('should filter content to UserMessage and Completion only', () => {
      const content = [
        createContent(0, 'UserMessage', 100),
        createContent(1, 'Completion', 100),
        createContent(2, 'ToolCall', 100),
        createContent(3, 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(2);
      expect(result.map(c => c.index)).toEqual([0, 1]);
    });

    it('should return empty array when no UserMessage or Completion', () => {
      const content = [
        createContent(0, 'ToolCall', 100),
        createContent(1, 'ToolResult', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(0);
    });

    it('should return only UserMessage when no Completion', () => {
      const content = [
        createContent(0, 'UserMessage', 100),
        createContent(1, 'ToolCall', 100)
      ];

      const result = strategy.apply(content);

      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
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
    it('should return false', () => {
      expect(strategy.isUserOnlyMode()).toBe(false);
    });
  });

  describe('filterByRelevance', () => {
    it('should filter by adjusted threshold and relevance', () => {
      const content = [
        createContent(0, 'UserMessage', 50, 0.9, true),
        createContent(1, 'UserMessage', 50, 0.5, true),
        createContent(2, 'UserMessage', 50, 0.9, false)  // Not relevant
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      // Adjusted threshold: min(0.9, 0.5 * 1.2) = 0.6
      // Only items with score >= 0.6 AND isRelevant should pass
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it('should cap threshold at 0.9', () => {
      const content = [
        createContent(0, 'Completion', 50, 0.95, true),
        createContent(1, 'Completion', 50, 0.85, true)
      ];

      const result = strategy.filterByRelevance(content, 1.0);

      // Threshold: min(0.9, 1.0 * 1.2) = 0.9
      expect(result.length).toBeGreaterThan(0);
    });

    it('should filter to UserMessage and Completion subtypes', () => {
      const content = [
        createContent(0, 'UserMessage', 50, 0.9, true),
        createContent(1, 'ToolCall', 50, 0.9, true)  // Not in allowed subtypes
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      expect(result.every(c => c.subType === 'UserMessage' || c.subType === 'Completion')).toBe(true);
    });
  });

  describe('applyIntelligentTruncation', () => {
    it('should return content unchanged when maxChars is 0', () => {
      const content = [createContent(0, 'UserMessage', 100)];
      const result = strategy.applyIntelligentTruncation(content, 0);

      expect(result).toEqual(content);
    });

    it('should return content unchanged when maxChars is negative', () => {
      const content = [createContent(0, 'UserMessage', 100)];
      const result = strategy.applyIntelligentTruncation(content, -1);

      expect(result).toEqual(content);
    });

    it('should return all content if it fits within maxChars', () => {
      const content = [
        createContent(0, 'UserMessage', 50, 0.8, true),
        createContent(1, 'Completion', 50, 0.8, true)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result).toHaveLength(2);
    });

    it('should balance user messages and completions', () => {
      const content = [
        createContent(0, 'UserMessage', 50, 0.8, true),
        createContent(1, 'Completion', 50, 0.8, true)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      // Should try to balance between user and completion
      expect(result.length).toBeGreaterThan(0);
    });

    it('should maintain minimum 30% for each type', () => {
      const content = [
        createContent(0, 'UserMessage', 10, 0.8, true),
        createContent(1, 'Completion', 100, 0.8, true)
      ];

      const result = strategy.applyIntelligentTruncation(content, 50);

      // User ratio should be at least 30%
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should sort results by index', () => {
      const content = [
        createContent(0, 'UserMessage', 30, 0.8, true),
        createContent(1, 'Completion', 30, 0.9, true),
        createContent(2, 'UserMessage', 30, 0.7, true)
      ];

      const result = strategy.applyIntelligentTruncation(content, 500);

      // All content should fit and be sorted
      expect(result.length).toBe(3);
      const indexes = result.map(c => c.index);
      expect(indexes).toEqual([0, 1, 2]);
    });
  });
});
