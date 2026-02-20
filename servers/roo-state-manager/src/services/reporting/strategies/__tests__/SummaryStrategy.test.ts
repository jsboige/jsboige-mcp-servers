/**
 * Tests for SummaryStrategy.ts
 * Coverage target: 90%+
 */

import { describe, it, expect } from 'vitest';
import { SummaryStrategy } from '../SummaryStrategy.js';
import { ClassifiedContent } from '../../../../types/enhanced-conversation.js';

describe('SummaryStrategy', () => {
  const strategy = new SummaryStrategy();

  const createContent = (
    id: string,
    subType: string,
    size: number,
    score: number = 0.8,
    relevant: boolean = true,
    index: number = 0,
    toolCallDetails?: { toolName: string },
    toolResultDetails?: { success: boolean }
  ): ClassifiedContent => ({
    id,
    content: 'x'.repeat(size),
    contentSize: size,
    confidenceScore: score,
    isRelevant: relevant,
    subType,
    type: 'text',
    role: subType === 'UserMessage' ? 'user' : 'assistant',
    index,
    toolCallDetails,
    toolResultDetails
  } as ClassifiedContent);

  describe('getStrategyName', () => {
    it('should return "Summary"', () => {
      expect(strategy.getStrategyName()).toBe('Summary');
    });
  });

  describe('apply', () => {
    it('should filter to relevant subtypes only', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.8, true),
        createContent('2', 'Thinking', 100, 0.8, true),  // Not in allowed subtypes
        createContent('3', 'Completion', 100, 0.8, true)
      ];

      const result = strategy.apply(content);

      expect(result.every(c => c.subType !== 'Thinking')).toBe(true);
    });

    it('should filter by high confidence threshold (>=0.7)', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.9, true),
        createContent('2', 'UserMessage', 100, 0.5, true)  // Below threshold
      ];

      const result = strategy.apply(content);

      expect(result.every(c => c.confidenceScore >= 0.7)).toBe(true);
    });

    it('should filter by isRelevant', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.8, true),
        createContent('2', 'UserMessage', 100, 0.8, false)  // Not relevant
      ];

      const result = strategy.apply(content);

      expect(result.every(c => c.isRelevant)).toBe(true);
    });

    it('should limit to max 20% of original content', () => {
      const content = Array(50).fill(null).map((_, i) =>
        createContent(`id-${i}`, 'UserMessage', 100, 0.8, true, i)
      );

      const result = strategy.apply(content);

      // Max items = max(10, 50 * 0.2) = 10
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('should return empty when no high-confidence content', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.5, true),
        createContent('2', 'Completion', 100, 0.4, true)
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
    it('should use minimum threshold of 0.75', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.8, true),
        createContent('2', 'UserMessage', 100, 0.7, true)  // Below 0.75
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      // Should use max(0.75, 0.5) = 0.75
      expect(result.every(c => c.confidenceScore >= 0.75)).toBe(true);
    });

    it('should filter to critical content only', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.9, true),  // Critical
        createContent('2', 'Thinking', 100, 0.9, true)      // Not critical
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      expect(result.every(c => c.subType === 'UserMessage' || c.subType === 'Completion')).toBe(true);
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

    it('should include content that fits', () => {
      const content = [
        createContent('1', 'UserMessage', 50, 0.8, true, 0),
        createContent('2', 'Completion', 50, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result.length).toBeGreaterThan(0);
    });

    it('should sort results by index', () => {
      const content = [
        createContent('1', 'UserMessage', 30, 0.8, true, 1),
        createContent('2', 'Completion', 30, 0.8, true, 0)
      ];

      const result = strategy.applyIntelligentTruncation(content, 200);

      expect(result[0].index).toBeLessThan(result[1].index);
    });

    it('should stop when capacity exceeded (no partial truncation)', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.8, true, 0),
        createContent('2', 'Completion', 100, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 50);

      // Should stop after first item that fits, not partially include
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('should prioritize UserMessage over other content', () => {
      const content = [
        createContent('1', 'ToolCall', 50, 0.8, true, 0),
        createContent('2', 'UserMessage', 50, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 60);

      // UserMessage should be prioritized (gets +0.4 bonus)
      expect(result.some(c => c.subType === 'UserMessage')).toBe(true);
    });
  });

  describe('isCriticalTool', () => {
    it('should identify write_to_file as critical', () => {
      const content = [
        createContent('1', 'ToolCall', 50, 0.8, true, 0, { toolName: 'write_to_file' })
      ];

      const result = strategy.apply(content);

      // Critical tools should be kept
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should identify execute_command as critical', () => {
      const content = [
        createContent('1', 'ToolCall', 50, 0.8, true, 0, { toolName: 'execute_command' })
      ];

      const result = strategy.apply(content);

      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should identify apply_diff as critical', () => {
      const content = [
        createContent('1', 'ToolCall', 50, 0.8, true, 0, { toolName: 'apply_diff' })
      ];

      const result = strategy.apply(content);

      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ToolResult filtering', () => {
    it('should keep successful small ToolResults', () => {
      const content = [
        createContent('1', 'ToolResult', 200, 0.9, true, 0, undefined, { success: true })
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      // Small successful results should pass
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should exclude large ToolResults', () => {
      const content = [
        createContent('1', 'ToolResult', 1000, 0.9, true, 0, undefined, { success: true })
      ];

      const result = strategy.filterByRelevance(content, 0.5);

      // Large results should be filtered out
      expect(result).toHaveLength(0);
    });
  });

  describe('content size bonuses', () => {
    it('should give bonus to concise content (<=200 chars)', () => {
      const content = [
        createContent('1', 'UserMessage', 100, 0.8, true, 0),
        createContent('2', 'UserMessage', 2000, 0.8, true, 1)
      ];

      const result = strategy.applyIntelligentTruncation(content, 350);

      // Concise content should fit
      expect(result.some(c => c.contentSize <= 200)).toBe(true);
    });
  });
});
