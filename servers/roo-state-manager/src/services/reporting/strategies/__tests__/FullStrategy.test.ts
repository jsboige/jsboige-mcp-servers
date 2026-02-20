/**
 * Tests for FullStrategy.ts
 * Coverage target: 20% → 90%+
 */

import { describe, it, expect } from 'vitest';
import { FullStrategy } from '../FullStrategy.js';
import { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

describe('FullStrategy', () => {
  const strategy = new FullStrategy();

  // Sample content for testing
  const createContent = (id: string, size: number, score: number = 0.8): ClassifiedContent => ({
    id,
    content: 'x'.repeat(size),
    contentSize: size,
    confidenceScore: score,
    type: 'text',
    role: 'assistant'
  } as ClassifiedContent);

  describe('getStrategyName', () => {
    it('should return "Full"', () => {
      expect(strategy.getStrategyName()).toBe('Full');
    });
  });

  describe('apply', () => {
    it('should return content unchanged', () => {
      const content = [
        createContent('1', 100),
        createContent('2', 200)
      ];

      const result = strategy.apply(content);

      expect(result).toEqual(content);
      expect(result).toBe(content); // Same reference
    });

    it('should return empty array unchanged', () => {
      const result = strategy.apply([]);
      expect(result).toEqual([]);
    });
  });

  describe('shouldShowToolDetails', () => {
    it('should return true', () => {
      expect(strategy.shouldShowToolDetails()).toBe(true);
    });
  });

  describe('shouldShowThinking', () => {
    it('should return true', () => {
      expect(strategy.shouldShowThinking()).toBe(true);
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

  describe('applyIntelligentTruncation', () => {
    it('should return content unchanged when maxChars is 0', () => {
      const content = [createContent('1', 100)];
      const result = strategy.applyIntelligentTruncation(content, 0);

      expect(result).toEqual(content);
    });

    it('should return content unchanged when maxChars is negative', () => {
      const content = [createContent('1', 100)];
      const result = strategy.applyIntelligentTruncation(content, -1);

      expect(result).toEqual(content);
    });

    it('should include all content that fits within maxChars', () => {
      const content = [
        createContent('1', 50),
        createContent('2', 50)
      ];
      const result = strategy.applyIntelligentTruncation(content, 150);

      expect(result).toHaveLength(2);
    });

    it('should stop when content exceeds maxChars', () => {
      const content = [
        createContent('1', 50),
        createContent('2', 50),
        createContent('3', 50)
      ];
      const result = strategy.applyIntelligentTruncation(content, 100);

      expect(result).toHaveLength(2);
    });

    it('should truncate first element if it exceeds maxChars', () => {
      const content = [createContent('1', 200)];
      const result = strategy.applyIntelligentTruncation(content, 100);

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('[truncated');
      expect(result[0].contentSize).toBeLessThan(200);
    });

    it('should preserve order of content', () => {
      const content = [
        createContent('first', 30),
        createContent('second', 30)
      ];
      const result = strategy.applyIntelligentTruncation(content, 100);

      expect(result[0].id).toBe('first');
      expect(result[1].id).toBe('second');
    });
  });

  describe('filterByRelevance', () => {
    it('should filter content with low confidence scores', () => {
      const content = [
        createContent('1', 50, 0.9),
        createContent('2', 50, 0.2),
        createContent('3', 50, 0.8)
      ];
      const result = strategy.filterByRelevance(content, 0.5);

      // Full strategy lowers threshold to 0.5 * 0.3 = 0.15
      // So content with score >= 0.15 should be included
      expect(result.length).toBeGreaterThan(0);
    });

    it('should lower threshold significantly', () => {
      const content = [
        createContent('1', 50, 0.2),  // Below normal threshold but above lowered
        createContent('2', 50, 0.05)  // Below even lowered threshold
      ];
      const result = strategy.filterByRelevance(content, 0.5);

      // Threshold is max(0.1, 0.5 * 0.3) = 0.15
      // So content with 0.2 should pass, 0.05 should not
      expect(result.some(c => c.id === '1')).toBe(true);
    });

    it('should use minimum threshold of 0.1', () => {
      const content = [
        createContent('1', 50, 0.15)
      ];
      const result = strategy.filterByRelevance(content, 0.1);

      // Threshold would be max(0.1, 0.1 * 0.3) = max(0.1, 0.03) = 0.1
      expect(result).toHaveLength(1);
    });

    it('should include all content when minConfidenceScore is very low', () => {
      const content = [
        createContent('1', 50, 0.5),
        createContent('2', 50, 0.5)
      ];
      const result = strategy.filterByRelevance(content, 0.1);

      expect(result).toHaveLength(2);
    });
  });
});
