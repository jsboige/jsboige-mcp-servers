/**
 * Tests unitaires pour message-types (Zod schemas)
 *
 * Couvre :
 * - clineAskSchema : 12 variantes
 * - clineSaySchema : 25 variantes
 * - uiMessageSchema : structure complète + validation
 */
import { describe, it, expect } from 'vitest';
import { clineAskSchema, clineSaySchema, uiMessageSchema, type UIMessage } from '../message-types.js';

describe('message-types', () => {
  // === clineAskSchema ===

  describe('clineAskSchema', () => {
    const validAskTypes = [
      'followup', 'command', 'command_output', 'completion_result',
      'tool', 'api_req_failed', 'resume_task', 'resume_completed_task',
      'mistake_limit_reached', 'browser_action_launch', 'use_mcp_server',
      'auto_approval_max_req_reached',
    ];

    it('should accept all valid ask types', () => {
      for (const askType of validAskTypes) {
        const result = clineAskSchema.safeParse(askType);
        expect(result.success, `Expected "${askType}" to be valid`).toBe(true);
      }
    });

    it('should reject invalid ask types', () => {
      const result = clineAskSchema.safeParse('invalid_type');
      expect(result.success).toBe(false);
    });

    it('should reject empty string', () => {
      expect(clineAskSchema.safeParse('').success).toBe(false);
    });

    it('should have 12 valid values', () => {
      expect(validAskTypes.length).toBe(12);
    });
  });

  // === clineSaySchema ===

  describe('clineSaySchema', () => {
    const validSayTypes = [
      'error', 'api_req_started', 'api_req_finished', 'api_req_retried',
      'api_req_retry_delayed', 'api_req_deleted', 'text', 'reasoning',
      'completion_result', 'user_feedback', 'user_feedback_diff',
      'command_output', 'shell_integration_warning', 'browser_action',
      'browser_action_result', 'mcp_server_request_started', 'mcp_server_response',
      'subtask_result', 'checkpoint_saved', 'rooignore_error',
      'diff_error', 'condense_context', 'condense_context_error',
      'codebase_search_result', 'user_edit_todos',
    ];

    it('should accept all valid say types', () => {
      for (const sayType of validSayTypes) {
        const result = clineSaySchema.safeParse(sayType);
        expect(result.success, `Expected "${sayType}" to be valid`).toBe(true);
      }
    });

    it('should reject invalid say types', () => {
      expect(clineSaySchema.safeParse('not_a_say_type').success).toBe(false);
    });

    it('should have 25 valid values', () => {
      expect(validSayTypes.length).toBe(25);
    });
  });

  // === uiMessageSchema ===

  describe('uiMessageSchema', () => {
    it('should accept minimal ask message', () => {
      const msg = { ts: 1000, type: 'ask' as const, ask: 'tool' as const };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it('should accept minimal say message', () => {
      const msg = { ts: 2000, type: 'say' as const, say: 'text' as const };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it('should accept full message with all fields', () => {
      const msg = {
        ts: 3000,
        type: 'say' as const,
        say: 'api_req_started' as const,
        text: '{"request":"test"}',
        images: ['base64encoded'],
        partial: true,
        reasoning: 'thinking step',
        conversationHistoryIndex: 5,
      };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it('should reject message without ts', () => {
      const msg = { type: 'ask', ask: 'tool' };
      expect(uiMessageSchema.safeParse(msg).success).toBe(false);
    });

    it('should reject message without type', () => {
      const msg = { ts: 1000, ask: 'tool' };
      expect(uiMessageSchema.safeParse(msg).success).toBe(false);
    });

    it('should reject message with invalid type', () => {
      const msg = { ts: 1000, type: 'invalid' };
      expect(uiMessageSchema.safeParse(msg).success).toBe(false);
    });

    it('should accept message with text field', () => {
      const msg = { ts: 1000, type: 'say' as const, say: 'text' as const, text: 'Hello world' };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.text).toBe('Hello world');
      }
    });

    it('should accept message with images array', () => {
      const msg = { ts: 1000, type: 'say' as const, images: ['img1', 'img2'] };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it('should accept ask message with tool type', () => {
      const msg: UIMessage = { ts: 1000, type: 'ask', ask: 'tool', text: '{"tool":"read_file"}' };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it('should accept say message with api_req_started', () => {
      const msg: UIMessage = { ts: 1000, type: 'say', say: 'api_req_started', text: '{"request":"test"}' };
      const result = uiMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });
  });
});
