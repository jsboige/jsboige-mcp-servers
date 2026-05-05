/**
 * Dashboard Zod schemas — single source of truth for JSON Schema derivation.
 *
 * NO handler imports — safe for tool-definitions.ts to import (#1145 perf fix).
 * Eliminates dual-definition bugs (#1470): the same Zod schema feeds both
 * runtime validation (dashboard.ts handler) and MCP tool advertisement
 * (tool-definitions.ts via zodToJsonSchema).
 *
 * @module tools/roosync/dashboard-schemas
 * @issue #1470
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// === Author Schema ===

export const AuthorSchema = z.object({
  machineId: z.string().describe('Machine ID'),
  workspace: z.string().describe('Workspace ID'),
  worktree: z.string().optional().describe('Worktree path')
});

export type Author = z.infer<typeof AuthorSchema>;

// === Team Pipeline Stages (#1853) ===
// Structured stages for complex task execution (inspired by oh-my-claudecode Team mode)
// MUST be declared before IntercomMessageSchema which references it

export const TeamStageSchema = z.enum([
  'team-plan',    // Break down task into subtasks
  'team-prd',     // Clarify requirements and constraints
  'team-exec',    // Execute the implementation
  'team-verify',  // Verify the solution (build + tests)
  'team-fix',     // Fix any issues found in verification (loops until verify passes)
  'none'          // No team stage (simple tasks)
]).describe('Team pipeline stage');

export type TeamStage = z.infer<typeof TeamStageSchema>;

// Verification result for team-verify stage
export const VerificationResultSchema = z.object({
  buildPassed: z.boolean().optional().describe('Build succeeded'),
  testsPassed: z.boolean().optional().describe('Tests passed'),
  issuesFound: z.array(z.string()).optional().describe('Issues found during verification')
}).describe('Verification result for team-verify stage');

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// Stage transition metadata
export const TeamStageDataSchema = z.object({
  previousStage: TeamStageSchema.optional().describe('Previous team stage'),
  nextStage: TeamStageSchema.optional().describe('Next team stage'),
  verificationResult: VerificationResultSchema.optional().describe('Verification result (team-verify)')
}).describe('Team stage transition data');

export type TeamStageData = z.infer<typeof TeamStageDataSchema>;

// === Intercom Message Schema ===

export const IntercomMessageSchema = z.object({
  id: z.string().describe('Unique message ID'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  author: AuthorSchema,
  content: z.string().describe('Markdown message content'),
  teamStage: TeamStageSchema.optional().describe('Team pipeline stage'),
  teamStageData: TeamStageDataSchema.optional().describe('Team stage transition data'),
  reply_to: z.string().optional().describe('Message ID being replied to (#1956)'),
  acknowledged_at: z.record(z.string(), z.string()).optional()
    .describe('Machine ID → ISO timestamp of acknowledgment (#1956)')
});

export type IntercomMessage = z.infer<typeof IntercomMessageSchema>;

// === Mentions v3 (#1363) ===
// userId = { machineId, workspace } tuple. Exactly one of userId/messageId (XOR).

export const UserIdSchema = z.object({
  machineId: z.string().describe('Machine ID'),
  workspace: z.string().describe('Workspace ID')
});

export type UserId = z.infer<typeof UserIdSchema>;

export const MentionSchema = z.object({
  userId: UserIdSchema.optional()
    .describe('User to mention (exclusive with messageId)'),
  messageId: z.string().optional()
    .describe('Message ID to reference (resolves to author)'),
  note: z.string().optional()
    .describe('Optional note')
}).refine(
  (m) => (m.userId !== undefined) !== (m.messageId !== undefined),
  { message: 'mention: exactement un de userId ou messageId doit être fourni' }
);

export type Mention = z.infer<typeof MentionSchema>;

export const CrossPostSchema = z.object({
  type: z.enum(['global', 'machine', 'workspace'])
    .describe('Target dashboard type'),
  machineId: z.string().optional()
    .describe('Target machineId'),
  workspace: z.string().optional()
    .describe('Target workspace')
});

export type CrossPost = z.infer<typeof CrossPostSchema>;

// === Dashboard data model ===

export interface Dashboard {
  type: 'global' | 'machine' | 'workspace';
  key: string;
  lastModified: string;
  lastModifiedBy: Author;
  status: {
    markdown: string;
    lastDiffCommit?: string;
  };
  intercom: {
    messages: IntercomMessage[];
    totalMessages: number;
    lastCondensedAt?: string;
  };
}

export interface DashboardFrontmatter {
  type: Dashboard['type'];
  lastModified: string;
  lastModifiedBy: Author;
  totalMessages?: number;
  lastCondensedAt?: string;
}

// === Dashboard Args Schema (unified for all actions) ===

export const DashboardArgsSchema = z.object({
  action: z.enum(['read', 'write', 'append', 'condense', 'list', 'delete', 'read_archive', 'read_overview', 'refresh', 'update'])
    .describe('Action to perform'),

  type: z.enum(['global', 'machine', 'workspace']).optional()
    .describe('Dashboard type (required except list/read_overview/refresh/update)'),

  machineId: z.string().optional()
    .describe('Machine ID (default: local)'),

  workspace: z.string().optional()
    .describe('Workspace (default: current)'),

  // Pour read/update — section semantics depend on action
  section: z.enum(['status', 'intercom', 'all', 'machine', 'global', 'decisions', 'metrics']).optional()
    .describe('Section to read (status/intercom/all) or update (machine/global/intercom/decisions/metrics)'),
  intercomLimit: z.number().optional()
    .describe('Max messages to return (default: all)'),
  mentionsOnly: z.boolean().optional()
    .describe('(read) Only messages mentioning local machine/agent'),
  format: z.enum(['markdown', 'json']).optional()
    .describe('(read/read_overview) Output format: markdown (default) or json'),

  // Pour write/append
  content: z.string().optional()
    .describe('Markdown for write (replaces status), append (new message), or update (section content)'),
  author: AuthorSchema.optional()
    .describe('Author (write/append)'),
  createIfNotExists: z.boolean().optional()
    .describe('Create if missing (default: true)'),
  messageId: z.string().optional()
    .describe('(append) Custom message ID'),

  // Pour append — tags
  tags: z.array(z.string()).optional()
    .describe('(append) Message tags'),

  // Pour append — Team pipeline stage (#1853)
  teamStage: TeamStageSchema.optional()
    .describe('(append) Team pipeline stage'),
  teamStageData: TeamStageDataSchema.optional()
    .describe('(append) Team stage transition data'),

  // Mentions v3 (#1363)
  mentions: z.array(MentionSchema).optional()
    .describe('(append) Mentions (userId XOR messageId)'),

  // Cross-post v3 (#1363)
  crossPost: z.array(CrossPostSchema).optional()
    .describe('(append) Cross-post to other dashboards'),

  // Pour condense
  keepMessages: z.number().optional()
    .describe('Messages to keep (default: 10)'),

  // Pour read_archive
  archiveFile: z.string().optional()
    .describe('(read_archive) Archive filename (omit to list)'),

  // Pour refresh (#1935 Cluster B)
  baseline: z.string().optional()
    .describe('(refresh) Baseline machine (default: myia-ai-01)'),
  outputDir: z.string().optional()
    .describe('(refresh) Output directory (default: $ROOSYNC_SHARED_PATH/dashboards)'),

  // Pour update (#1935 Cluster B)
  mode: z.enum(['replace', 'append', 'prepend']).optional()
    .describe('(update) Update mode: replace, append, prepend (default: replace)')
}).passthrough();

export type DashboardArgs = z.infer<typeof DashboardArgsSchema> & Record<string, any>;

// === Derived JSON Schema for MCP tool advertisement ===
// Used by tool-definitions.ts to advertise the tool via ListTools.
// Eliminates hand-written JSON Schema that silently diverged from the Zod source.

export const dashboardToolMetadata = {
  name: 'roosync_dashboard',
  description: 'Shared dashboards (global/machine/workspace). Actions: read, write, append, condense, list, delete, read_archive, read_overview, refresh, update. Team stages supported.',
  inputSchema: zodToJsonSchema(DashboardArgsSchema as any, { target: 'openApi3' })
};
