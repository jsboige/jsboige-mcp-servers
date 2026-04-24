/**
 * Tests for dashboard Zod schemas (#1470)
 * Validates schema constraints, XOR refinements, and tool metadata derivation.
 */

import { describe, it, expect } from 'vitest';
import {
  AuthorSchema,
  IntercomMessageSchema,
  UserIdSchema,
  MentionSchema,
  CrossPostSchema,
  DashboardArgsSchema,
  dashboardToolMetadata,
} from '../dashboard-schemas.js';

// === AuthorSchema ===

describe('AuthorSchema', () => {
  it('accepts valid author with required fields', () => {
    const result = AuthorSchema.safeParse({
      machineId: 'myia-po-2026',
      workspace: 'roo-extensions',
    });
    expect(result.success).toBe(true);
  });

  it('accepts author with optional worktree', () => {
    const result = AuthorSchema.safeParse({
      machineId: 'myia-ai-01',
      workspace: 'roo-extensions',
      worktree: '.claude/worktrees/wt-fix-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects author missing machineId', () => {
    const result = AuthorSchema.safeParse({ workspace: 'roo-extensions' });
    expect(result.success).toBe(false);
  });

  it('rejects author missing workspace', () => {
    const result = AuthorSchema.safeParse({ machineId: 'myia-po-2026' });
    expect(result.success).toBe(false);
  });

  it('strips unknown fields', () => {
    const result = AuthorSchema.safeParse({
      machineId: 'myia-po-2026',
      workspace: 'roo-extensions',
      extra: 'should be removed',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).extra).toBeUndefined();
    }
  });
});

// === IntercomMessageSchema ===

describe('IntercomMessageSchema', () => {
  const validMessage = {
    id: 'ic-2026-04-24T1200-abcd',
    timestamp: '2026-04-24T12:00:00.000Z',
    author: { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
    content: 'Hello world',
  };

  it('accepts valid intercom message', () => {
    const result = IntercomMessageSchema.safeParse(validMessage);
    expect(result.success).toBe(true);
  });

  it('rejects message missing id', () => {
    const { id, ...noId } = validMessage;
    const result = IntercomMessageSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it('rejects message missing timestamp', () => {
    const { timestamp, ...noTs } = validMessage;
    const result = IntercomMessageSchema.safeParse(noTs);
    expect(result.success).toBe(false);
  });

  it('rejects message with invalid author', () => {
    const result = IntercomMessageSchema.safeParse({
      ...validMessage,
      author: { machineId: 'myia-po-2026' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects message missing content', () => {
    const { content, ...noContent } = validMessage;
    const result = IntercomMessageSchema.safeParse(noContent);
    expect(result.success).toBe(false);
  });
});

// === UserIdSchema ===

describe('UserIdSchema', () => {
  it('accepts valid userId', () => {
    const result = UserIdSchema.safeParse({
      machineId: 'myia-po-2026',
      workspace: 'roo-extensions',
    });
    expect(result.success).toBe(true);
  });

  it('rejects userId missing workspace', () => {
    const result = UserIdSchema.safeParse({ machineId: 'myia-po-2026' });
    expect(result.success).toBe(false);
  });
});

// === MentionSchema (XOR constraint) ===

describe('MentionSchema', () => {
  it('accepts mention with userId only', () => {
    const result = MentionSchema.safeParse({
      userId: { machineId: 'myia-po-2025', workspace: 'roo-extensions' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts mention with messageId only', () => {
    const result = MentionSchema.safeParse({
      messageId: 'myia-ai-01:roo-extensions:ic-2026-04-24T1200-abcd',
    });
    expect(result.success).toBe(true);
  });

  it('accepts mention with userId and optional note', () => {
    const result = MentionSchema.safeParse({
      userId: { machineId: 'myia-po-2025', workspace: 'roo-extensions' },
      note: 'please review',
    });
    expect(result.success).toBe(true);
  });

  it('rejects mention with both userId and messageId (XOR violation)', () => {
    const result = MentionSchema.safeParse({
      userId: { machineId: 'myia-po-2025', workspace: 'roo-extensions' },
      messageId: 'myia-ai-01:roo-extensions:ic-2026-04-24T1200-abcd',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('userId');
    }
  });

  it('rejects mention with neither userId nor messageId', () => {
    const result = MentionSchema.safeParse({ note: 'just a note' });
    expect(result.success).toBe(false);
  });
});

// === CrossPostSchema ===

describe('CrossPostSchema', () => {
  it('accepts global cross-post', () => {
    const result = CrossPostSchema.safeParse({ type: 'global' });
    expect(result.success).toBe(true);
  });

  it('accepts machine cross-post with machineId', () => {
    const result = CrossPostSchema.safeParse({
      type: 'machine',
      machineId: 'myia-po-2025',
    });
    expect(result.success).toBe(true);
  });

  it('accepts workspace cross-post with workspace', () => {
    const result = CrossPostSchema.safeParse({
      type: 'workspace',
      workspace: 'roo-extensions',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = CrossPostSchema.safeParse({ type: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('accepts cross-post with all optional fields', () => {
    const result = CrossPostSchema.safeParse({
      type: 'workspace',
      machineId: 'myia-po-2025',
      workspace: 'roo-extensions',
    });
    expect(result.success).toBe(true);
  });
});

// === DashboardArgsSchema ===

describe('DashboardArgsSchema', () => {
  it('accepts valid read action', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'read',
      type: 'workspace',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid write action with author', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'write',
      type: 'workspace',
      content: '## Status\nAll good',
      author: { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid append action with mentions and crossPost', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'append',
      type: 'workspace',
      content: 'Hello',
      tags: ['INFO', 'DONE'],
      author: { machineId: 'myia-po-2026', workspace: 'roo-extensions' },
      mentions: [
        { userId: { machineId: 'myia-po-2025', workspace: 'roo-extensions' } },
      ],
      crossPost: [{ type: 'global' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts list action without type', () => {
    const result = DashboardArgsSchema.safeParse({ action: 'list' });
    expect(result.success).toBe(true);
  });

  it('accepts condense action with keepMessages', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'condense',
      type: 'workspace',
      keepMessages: 20,
    });
    expect(result.success).toBe(true);
  });

  it('accepts read_overview action', () => {
    const result = DashboardArgsSchema.safeParse({ action: 'read_overview' });
    expect(result.success).toBe(true);
  });

  it('accepts delete action', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'delete',
      type: 'workspace',
    });
    expect(result.success).toBe(true);
  });

  it('accepts read_archive with archiveFile', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'read_archive',
      type: 'workspace',
      archiveFile: 'archive-2026-04.md',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid action', () => {
    const result = DashboardArgsSchema.safeParse({ action: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('allows extra passthrough fields', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'read',
      type: 'workspace',
      customField: 'allowed',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).customField).toBe('allowed');
    }
  });

  it('accepts read with intercomLimit and mentionsOnly', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'read',
      type: 'workspace',
      section: 'intercom',
      intercomLimit: 10,
      mentionsOnly: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts append with messageId', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'append',
      type: 'workspace',
      content: 'Test message',
      messageId: 'myia-po-2026:roo-extensions:ic-2026-04-24T1200-abcd',
    });
    expect(result.success).toBe(true);
  });

  it('validates section enum values', () => {
    const result = DashboardArgsSchema.safeParse({
      action: 'read',
      type: 'workspace',
      section: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

// === dashboardToolMetadata ===

describe('dashboardToolMetadata', () => {
  it('has correct tool name', () => {
    expect(dashboardToolMetadata.name).toBe('roosync_dashboard');
  });

  it('has non-empty description', () => {
    expect(dashboardToolMetadata.description.length).toBeGreaterThan(50);
  });

  it('has valid JSON Schema inputSchema', () => {
    const schema = dashboardToolMetadata.inputSchema as any;
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.action).toBeDefined();
    expect(schema.properties.type).toBeDefined();
  });

  it('inputSchema action enum includes all 8 actions', () => {
    const schema = dashboardToolMetadata.inputSchema as any;
    const actionEnum = schema.properties.action.enum;
    expect(actionEnum).toContain('read');
    expect(actionEnum).toContain('write');
    expect(actionEnum).toContain('append');
    expect(actionEnum).toContain('condense');
    expect(actionEnum).toContain('list');
    expect(actionEnum).toContain('delete');
    expect(actionEnum).toContain('read_archive');
    expect(actionEnum).toContain('read_overview');
  });

  it('inputSchema type enum includes 3 dashboard types', () => {
    const schema = dashboardToolMetadata.inputSchema as any;
    const typeEnum = schema.properties.type.enum;
    expect(typeEnum).toEqual(['global', 'machine', 'workspace']);
  });
});
