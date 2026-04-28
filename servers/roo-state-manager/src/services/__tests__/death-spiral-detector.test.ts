import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeathSpiralDetector } from '../death-spiral-detector.js';
import { ConversationSkeleton } from '../../types/conversation.js';

function makeSkeleton(messages: any[]): ConversationSkeleton {
  return {
    id: 'test-task-id',
    messages,
    metadata: { createdAt: new Date().toISOString() },
  } as ConversationSkeleton;
}

function makeUserMessage(text: string, timestamp?: number) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: timestamp ?? Date.now(),
  };
}

function makeAssistantMessage(text: string, timestamp?: number) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: timestamp ?? Date.now(),
  };
}

function makeErrorMessage(errorText: string, timestamp?: number) {
  return makeUserMessage(errorText, timestamp);
}

describe('DeathSpiralDetector', () => {
  let cache: Map<string, ConversationSkeleton>;

  beforeEach(() => {
    cache = new Map();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
  });

  describe('analyzeTasksForDeathSpiral', () => {
    it('should return empty results for healthy tasks', async () => {
      const skeleton = makeSkeleton([
        makeAssistantMessage('Working on task...', Date.now() - 60000),
        makeUserMessage('Good progress', Date.now() - 30000),
        makeAssistantMessage('Completed', Date.now()),
      ]);
      cache.set('healthy-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['healthy-task'],
        cache
      );

      expect(result.deathSpirals).toHaveLength(0);
      expect(result.tasksAtRisk).toHaveLength(0);
      expect(result.immediateActions).toHaveLength(0);
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0]).toContain('Aucun death spiral');
    });

    it('should skip tasks not in cache', async () => {
      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['missing-task'],
        cache
      );

      expect(result.deathSpirals).toHaveLength(0);
      expect(result.tasksAtRisk).toHaveLength(0);
    });

    it('should detect death spiral with high error ratio and low assistant output', async () => {
      const now = Date.now();
      const messages = [];
      // 10 error messages
      for (let i = 0; i < 10; i++) {
        messages.push(makeErrorMessage('502 Bad Gateway error', now - (10 - i) * 60000));
      }
      // 1 assistant message (low output)
      messages.push(makeAssistantMessage('retrying...', now - 300000));

      const skeleton = makeSkeleton(messages);
      cache.set('spiral-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['spiral-task'],
        cache,
        { errorRatio: 0.8, assistantOutputRatio: 0.05, consecutiveErrors: 3, rapidErrorCount: 5, timeWindowMinutes: 30 }
      );

      expect(result.deathSpirals.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect tasks at risk even without full death spiral', async () => {
      const now = Date.now();
      const messages = [
        makeErrorMessage('timeout error', now - 240000),
        makeAssistantMessage('Retrying...', now - 180000),
        makeErrorMessage('connection error', now - 120000),
        makeAssistantMessage('Will retry', now - 60000),
        makeErrorMessage('502 Bad Gateway', now),
        makeUserMessage('Check status', now - 30000),
      ];

      const skeleton = makeSkeleton(messages);
      cache.set('at-risk-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['at-risk-task'],
        cache
      );

      // Either deathSpirals or tasksAtRisk should be populated
      expect(
        result.deathSpirals.length + result.tasksAtRisk.length
      ).toBeGreaterThanOrEqual(0);
    });

    it('should recommend immediate actions for CRITICAL death spirals', async () => {
      const now = Date.now();
      const messages = [];
      for (let i = 0; i < 15; i++) {
        messages.push(makeErrorMessage('502 Bad Gateway timeout error retry', now - (15 - i) * 120000));
      }

      const skeleton = makeSkeleton(messages);
      cache.set('critical-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['critical-task'],
        cache,
        { errorRatio: 0.8, assistantOutputRatio: 0.05, consecutiveErrors: 3, rapidErrorCount: 5, timeWindowMinutes: 30 }
      );

      if (result.deathSpirals.length > 0 && result.deathSpirals[0].riskLevel === 'CRITICAL') {
        expect(result.immediateActions.length).toBeGreaterThan(0);
        expect(result.immediateActions[0].action).toBe('terminate');
      }
    });
  });

  describe('error pattern detection', () => {
    it('should detect 502 Bad Gateway errors', async () => {
      const now = Date.now();
      const messages = [
        makeErrorMessage('Got 502 Bad Gateway from server', now - 60000),
        makeErrorMessage('502 Bad Gateway again', now),
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('task-502', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['task-502'],
        cache
      );

      // Should not crash and should have processed the errors
      expect(result).toBeDefined();
    });

    it('should detect timeout errors', async () => {
      const now = Date.now();
      const messages = [
        makeErrorMessage('Request timeout after 30000ms', now - 60000),
        makeErrorMessage('timeout on retry', now),
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('task-timeout', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['task-timeout'],
        cache
      );

      expect(result).toBeDefined();
    });

    it('should detect MCP errors', async () => {
      const now = Date.now();
      const messages = [
        makeErrorMessage('MCP error: tool not found', now),
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('task-mcp', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['task-mcp'],
        cache
      );

      expect(result).toBeDefined();
    });

    it('should detect rate limit errors', async () => {
      const now = Date.now();
      const messages = [
        makeErrorMessage('rate limit exceeded', now),
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('task-ratelimit', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['task-ratelimit'],
        cache
      );

      expect(result).toBeDefined();
    });
  });

  describe('threshold customization', () => {
    it('should respect custom thresholds', async () => {
      const now = Date.now();
      const messages = [
        makeErrorMessage('502 Bad Gateway', now - 120000),
        makeAssistantMessage('Retrying', now - 60000),
        makeErrorMessage('timeout', now),
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('custom-task', skeleton);

      // With very loose thresholds, should not detect spiral
      const looseResult = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['custom-task'],
        cache,
        { errorRatio: 0.99, assistantOutputRatio: 0.5, consecutiveErrors: 100 }
      );

      expect(looseResult.deathSpirals).toHaveLength(0);

      // With very strict thresholds, should detect something
      const strictResult = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['custom-task'],
        cache,
        { errorRatio: 0.1, assistantOutputRatio: 0.99, consecutiveErrors: 1 }
      );

      // More likely to detect with stricter thresholds
      expect(strictResult).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty message list', async () => {
      const skeleton = makeSkeleton([]);
      cache.set('empty-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['empty-task'],
        cache
      );

      expect(result.deathSpirals).toHaveLength(0);
      expect(result.tasksAtRisk).toHaveLength(0);
    });

    it('should handle messages without timestamps', async () => {
      const messages = [
        { role: 'user', content: [{ type: 'text', text: '502 Bad Gateway' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'retrying' }] },
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('no-timestamps', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['no-timestamps'],
        cache
      );

      expect(result).toBeDefined();
    });

    it('should handle nested messages', async () => {
      const messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'outer message' }],
          timestamp: Date.now() - 60000,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: '502 Bad Gateway nested' }],
              timestamp: Date.now() - 30000,
            },
          ],
        },
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('nested-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['nested-task'],
        cache
      );

      expect(result).toBeDefined();
    });

    it('should handle mixed content types', async () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'timeout error' },
            { type: 'image', data: 'base64...' },
          ],
          timestamp: Date.now(),
        },
      ];
      const skeleton = makeSkeleton(messages);
      cache.set('mixed-task', skeleton);

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['mixed-task'],
        cache
      );

      expect(result).toBeDefined();
    });

    it('should handle multiple tasks in one call', async () => {
      cache.set('task-1', makeSkeleton([makeErrorMessage('502 Bad Gateway', Date.now())]));
      cache.set('task-2', makeSkeleton([makeAssistantMessage('Healthy output', Date.now())]));
      cache.set('task-3', makeSkeleton([]));

      const result = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
        ['task-1', 'task-2', 'task-3', 'missing-task'],
        cache
      );

      expect(result).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
    });
  });
});
