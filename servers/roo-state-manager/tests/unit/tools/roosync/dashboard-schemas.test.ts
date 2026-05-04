/**
 * Tests for dashboard-schemas Zod schemas
 *
 * Covers: AuthorSchema, TeamStageSchema, VerificationResultSchema,
 * MentionSchema (XOR validation), CrossPostSchema, DashboardArgsSchema,
 * dashboardToolMetadata
 */

import { describe, it, expect } from 'vitest';
import {
    AuthorSchema,
    TeamStageSchema,
    VerificationResultSchema,
    TeamStageDataSchema,
    IntercomMessageSchema,
    MentionSchema,
    CrossPostSchema,
    DashboardArgsSchema,
    dashboardToolMetadata,
} from '../../../../src/tools/roosync/dashboard-schemas.js';

describe('dashboard-schemas', () => {
    describe('AuthorSchema', () => {
        it('validates valid author', () => {
            const result = AuthorSchema.safeParse({
                machineId: 'myia-po-2025',
                workspace: 'roo-extensions',
            });
            expect(result.success).toBe(true);
        });

        it('includes optional worktree', () => {
            const result = AuthorSchema.safeParse({
                machineId: 'myia-po-2025',
                workspace: 'roo-extensions',
                worktree: '/tmp/wt-test',
            });
            expect(result.success).toBe(true);
        });

        it('rejects missing machineId', () => {
            const result = AuthorSchema.safeParse({
                workspace: 'roo-extensions',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('TeamStageSchema', () => {
        it('accepts valid stages', () => {
            for (const stage of ['team-plan', 'team-prd', 'team-exec', 'team-verify', 'team-fix', 'none']) {
                expect(TeamStageSchema.safeParse(stage).success).toBe(true);
            }
        });

        it('rejects invalid stage', () => {
            expect(TeamStageSchema.safeParse('invalid').success).toBe(false);
        });
    });

    describe('VerificationResultSchema', () => {
        it('validates partial result', () => {
            const result = VerificationResultSchema.safeParse({
                buildPassed: true,
            });
            expect(result.success).toBe(true);
        });

        it('validates full result', () => {
            const result = VerificationResultSchema.safeParse({
                buildPassed: true,
                testsPassed: false,
                issuesFound: ['Test A failed', 'Test B failed'],
            });
            expect(result.success).toBe(true);
        });
    });

    describe('TeamStageDataSchema', () => {
        it('validates stage transition', () => {
            const result = TeamStageDataSchema.safeParse({
                previousStage: 'team-plan',
                nextStage: 'team-exec',
            });
            expect(result.success).toBe(true);
        });

        it('includes optional verificationResult', () => {
            const result = TeamStageDataSchema.safeParse({
                previousStage: 'team-exec',
                nextStage: 'team-verify',
                verificationResult: { buildPassed: true, testsPassed: true },
            });
            expect(result.success).toBe(true);
        });
    });

    describe('MentionSchema', () => {
        it('accepts userId mention', () => {
            const result = MentionSchema.safeParse({
                userId: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
            });
            expect(result.success).toBe(true);
        });

        it('accepts messageId mention', () => {
            const result = MentionSchema.safeParse({
                messageId: 'msg-123',
            });
            expect(result.success).toBe(true);
        });

        it('rejects when both userId and messageId provided', () => {
            const result = MentionSchema.safeParse({
                userId: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
                messageId: 'msg-123',
            });
            expect(result.success).toBe(false);
        });

        it('rejects when neither provided', () => {
            const result = MentionSchema.safeParse({
                note: 'A note',
            });
            expect(result.success).toBe(false);
        });

        it('accepts mention with note', () => {
            const result = MentionSchema.safeParse({
                userId: { machineId: 'myia-ai-01', workspace: 'roo-extensions' },
                note: 'FYI',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('CrossPostSchema', () => {
        it('validates global cross-post', () => {
            const result = CrossPostSchema.safeParse({ type: 'global' });
            expect(result.success).toBe(true);
        });

        it('validates machine cross-post with machineId', () => {
            const result = CrossPostSchema.safeParse({
                type: 'machine',
                machineId: 'myia-ai-01',
            });
            expect(result.success).toBe(true);
        });

        it('rejects invalid type', () => {
            const result = CrossPostSchema.safeParse({ type: 'invalid' });
            expect(result.success).toBe(false);
        });
    });

    describe('DashboardArgsSchema', () => {
        it('validates minimal read action', () => {
            const result = DashboardArgsSchema.safeParse({
                action: 'read',
                type: 'workspace',
            });
            expect(result.success).toBe(true);
        });

        it('validates append with tags and teamStage', () => {
            const result = DashboardArgsSchema.safeParse({
                action: 'append',
                type: 'workspace',
                content: 'Test message',
                tags: ['INFO'],
                teamStage: 'team-exec',
            });
            expect(result.success).toBe(true);
        });

        it('validates condense action', () => {
            const result = DashboardArgsSchema.safeParse({
                action: 'condense',
                type: 'workspace',
                keepMessages: 20,
            });
            expect(result.success).toBe(true);
        });

        it('rejects invalid action', () => {
            const result = DashboardArgsSchema.safeParse({
                action: 'invalid',
            });
            expect(result.success).toBe(false);
        });

        it('allows extra properties via passthrough', () => {
            const result = DashboardArgsSchema.safeParse({
                action: 'read',
                type: 'workspace',
                extraField: 'allowed',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('dashboardToolMetadata', () => {
        it('has correct name', () => {
            expect(dashboardToolMetadata.name).toBe('roosync_dashboard');
        });

        it('has valid JSON schema', () => {
            expect(dashboardToolMetadata.inputSchema).toBeDefined();
            expect(dashboardToolMetadata.inputSchema.properties.action).toBeDefined();
        });
    });
});
