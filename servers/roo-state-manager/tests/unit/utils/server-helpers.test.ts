import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.unmock('../../../src/utils/server-helpers.js');
import {
  getSharedStatePath,
  formatDurationMs,
  truncateResult,
  injectDuration
} from '../../../src/utils/server-helpers';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('server-helpers', () => {

  // --- formatDurationMs ---

  describe('formatDurationMs', () => {
    it('should format milliseconds < 1000 as "Nms"', () => {
      expect(formatDurationMs(0)).toBe('0ms');
      expect(formatDurationMs(142)).toBe('142ms');
      expect(formatDurationMs(999)).toBe('999ms');
    });

    it('should format seconds < 60 as "N.Ns"', () => {
      expect(formatDurationMs(1000)).toBe('1.0s');
      expect(formatDurationMs(2400)).toBe('2.4s');
      expect(formatDurationMs(59999)).toBe('60.0s');
    });

    it('should format minutes < 60 as "NmNNs"', () => {
      expect(formatDurationMs(60_000)).toBe('1m00s');
      expect(formatDurationMs(83_000)).toBe('1m23s');
      expect(formatDurationMs(59 * 60_000 + 59_000)).toBe('59m59s');
    });

    it('should format hours as "NhNNm"', () => {
      expect(formatDurationMs(3_600_000)).toBe('1h00m');
      expect(formatDurationMs(3_780_000)).toBe('1h03m');
      expect(formatDurationMs(36_000_000)).toBe('10h00m');
    });
  });

  // --- getSharedStatePath ---

  describe('getSharedStatePath', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should return ROOSYNC_SHARED_PATH when set', () => {
      vi.stubEnv('ROOSYNC_SHARED_PATH', '/some/shared/path');
      expect(getSharedStatePath()).toBe('/some/shared/path');
    });

    it('should throw when ROOSYNC_SHARED_PATH is not set', () => {
      vi.stubEnv('ROOSYNC_SHARED_PATH', '');
      expect(() => getSharedStatePath()).toThrow('ROOSYNC_SHARED_PATH environment variable is not set');
    });
  });

  // --- truncateResult ---

  describe('truncateResult', () => {
    it('should not truncate short text', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'short text' }]
      };

      const truncated = truncateResult(result);
      expect(truncated.content[0].type === 'text' && truncated.content[0].text).toBe('short text');
    });

    it('should truncate text exceeding MAX_OUTPUT_LENGTH', () => {
      const longText = 'x'.repeat(400000);
      const result: CallToolResult = {
        content: [{ type: 'text', text: longText }]
      };

      const truncated = truncateResult(result);
      if (truncated.content[0].type === 'text') {
        expect(truncated.content[0].text.length).toBeLessThan(400000);
        expect(truncated.content[0].text).toContain('OUTPUT TRUNCATED');
      }
    });

    it('should return same result reference', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'ok' }]
      };

      expect(truncateResult(result)).toBe(result);
    });
  });

  // --- injectDuration ---

  describe('injectDuration', () => {
    it('should append duration footer to text content', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'original' }]
      };

      const injected = injectDuration(result, 142, 'testTool');
      if (injected.content[0].type === 'text') {
        expect(injected.content[0].text).toContain('testTool');
        expect(injected.content[0].text).toContain('142ms');
        expect(injected.content[0].text).toContain('[⏱');
      }
    });

    it('should set _meta.durationMs', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'ok' }]
      };

      injectDuration(result, 500, 'tool');
      expect((result as any)._meta.durationMs).toBe(500);
      expect((result as any)._meta.toolName).toBe('tool');
    });

    it('should work without toolName', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'ok' }]
      };

      const injected = injectDuration(result, 1000);
      if (injected.content[0].type === 'text') {
        expect(injected.content[0].text).toContain('1.0s');
      }
    });

    it('should not crash on result without text content', () => {
      const result: CallToolResult = {
        content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
      };

      expect(() => injectDuration(result, 100, 'test')).not.toThrow();
      expect((result as any)._meta.durationMs).toBe(100);
    });

    it('should return same result reference', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'ok' }]
      };

      expect(injectDuration(result, 100)).toBe(result);
    });
  });
});
