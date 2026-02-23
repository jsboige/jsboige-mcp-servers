/**
 * Tests pour message-types.ts
 * Issue #507 - Proficiency test myia-po-2025
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  clineAskSchema,
  clineSaySchema,
  uiMessageSchema,
  type ToolCallInfo,
  type NewTaskInfo,
  type ApiReqInfo,
  type ToolMessage,
  type FollowupMessage,
} from '../message-types';

describe('clineAskSchema', () => {
  it('doit accepter toutes les variantes ask', () => {
    const askTypes = [
      'followup',
      'command',
      'command_output',
      'completion_result',
      'tool',
      'api_req_failed',
      'resume_task',
      'resume_completed_task',
      'mistake_limit_reached',
      'browser_action_launch',
      'use_mcp_server',
      'auto_approval_max_req_reached',
    ];

    for (const askType of askTypes) {
      const result = clineAskSchema.parse(askType);
      expect(result).toBe(askType);
    }
  });

  it('doit rejeter les valeurs non valides', () => {
    expect(() => clineAskSchema.parse('invalid_type')).toThrow();
    expect(() => clineAskSchema.parse('')).toThrow();
    expect(() => clineAskSchema.parse(123)).toThrow();
  });
});

describe('clineSaySchema', () => {
  it('doit accepter toutes les variantes say', () => {
    const sayTypes = [
      'error',
      'api_req_started',
      'api_req_finished',
      'api_req_retried',
      'api_req_retry_delayed',
      'api_req_deleted',
      'text',
      'reasoning',
      'completion_result',
      'user_feedback',
      'user_feedback_diff',
      'command_output',
      'shell_integration_warning',
      'browser_action',
      'browser_action_result',
      'mcp_server_request_started',
      'mcp_server_response',
      'subtask_result',
      'checkpoint_saved',
      'rooignore_error',
      'diff_error',
      'condense_context',
      'condense_context_error',
      'codebase_search_result',
      'user_edit_todos',
    ];

    for (const sayType of sayTypes) {
      const result = clineSaySchema.parse(sayType);
      expect(result).toBe(sayType);
    }
  });

  it('doit rejeter les valeurs non valides', () => {
    expect(() => clineSaySchema.parse('invalid_type')).toThrow();
    expect(() => clineSaySchema.parse('')).toThrow();
    expect(() => clineSaySchema.parse(null)).toThrow();
  });
});

describe('uiMessageSchema', () => {
  it('doit créer un message ask valide', () => {
    const message = {
      ts: 1234567890,
      type: 'ask',
      ask: 'tool',
      text: 'Use the tool',
    };

    const result = uiMessageSchema.parse(message);
    expect(result).toEqual({
      ts: 1234567890,
      type: 'ask',
      ask: 'tool',
      text: 'Use the tool',
    });
  });

  it('doit créer un message say valide', () => {
    const message = {
      ts: 1234567890,
      type: 'say',
      say: 'api_req_started',
      text: 'API request started',
    };

    const result = uiMessageSchema.parse(message);
    expect(result).toEqual({
      ts: 1234567890,
      type: 'say',
      say: 'api_req_started',
      text: 'API request started',
    });
  });

  it('doit accepter un message avec toutes les options', () => {
    const message = {
      ts: 1234567890,
      type: 'say',
      say: 'text',
      text: 'Hello world',
      images: ['data:image/png;base64,...'],
      partial: false,
      reasoning: 'I am thinking',
      conversationHistoryIndex: 5,
    };

    const result = uiMessageSchema.parse(message);
    expect(result).toEqual({
      ts: 1234567890,
      type: 'say',
      say: 'text',
      text: 'Hello world',
      images: ['data:image/png;base64,...'],
      partial: false,
      reasoning: 'I am thinking',
      conversationHistoryIndex: 5,
    });
  });

  it('doit rejeter un message sans type', () => {
    const message = {
      ts: 1234567890,
    };

    expect(() => uiMessageSchema.parse(message)).toThrow();
  });

  it('doit rejeter un type invalide', () => {
    const message = {
      ts: 1234567890,
      type: 'invalid_type',
    };

    expect(() => uiMessageSchema.parse(message)).toThrow();
  });
});

describe('Types inférés', () => {
  it('ToolCallInfo doit avoir la bonne structure', () => {
    const toolCall: ToolCallInfo = {
      tool: 'newTask',
      mode: 'code',
      message: 'Create a new task',
      content: 'Create a new task',
      timestamp: 1234567890,
    };

    expect(toolCall.tool).toBe('newTask');
    expect(toolCall.mode).toBe('code');
    expect(toolCall.message).toBe('Create a new task');
    expect(toolCall.timestamp).toBe(1234567890);
  });

  it('NewTaskInfo doit avoir la bonne structure', () => {
    const newTask: NewTaskInfo = {
      mode: 'architect',
      message: 'Design the architecture',
      timestamp: 1234567890,
    };

    expect(newTask.mode).toBe('architect');
    expect(newTask.message).toBe('Design the architecture');
    expect(newTask.timestamp).toBe(1234567890);
  });

  it('ApiReqInfo doit avoir la bonne structure', () => {
    const apiReq: ApiReqInfo = {
      request: 'GET /api/data',
      cost: 0.001,
      cancelReason: 'user_cancelled',
      streamingFailedMessage: 'Stream failed',
    };

    expect(apiReq.request).toBe('GET /api/data');
    expect(apiReq.cost).toBe(0.001);
    expect(apiReq.cancelReason).toBe('user_cancelled');
    expect(apiReq.streamingFailedMessage).toBe('Stream failed');
  });

  it('ToolMessage doit avoir la bonne structure', () => {
    const toolMsg: ToolMessage = {
      tool: 'search',
      mode: 'code',
      message: 'Search the codebase',
      content: 'Search the codebase',
    };

    expect(toolMsg.tool).toBe('search');
    expect(toolMsg.mode).toBe('code');
    expect(toolMsg.message).toBe('Search the codebase');
    expect(toolMsg.content).toBe('Search the codebase');
  });

  it('FollowupMessage doit avoir la bonne structure', () => {
    const followup: FollowupMessage = {
      question: 'Do you want to continue?',
      follow_up: ['Yes', 'No'],
    };

    expect(followup.question).toBe('Do you want to continue?');
    expect(followup.follow_up).toEqual(['Yes', 'No']);
  });
});
