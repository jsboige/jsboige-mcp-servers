/**
 * Coverage complement for task-tree-builder.ts.
 *
 * Baseline (post existing task-tree-builder.test.ts): 100% stmts / 100% lines /
 * 100% funcs but 92.76% branches — 5 cold branches remain. All are defensive
 * `||` guards (load-bearing: pin against `??` modernization). This suite covers
 * them via direct private-method calls on a builder instance (`(builder as any)`).
 *
 * Anchored on source lines:
 *   - belongsToWorkspace L477 `workspace.path || ''` (path falsy → '') + L478 `|| false`
 *   - belongsToProject L483 `project.path || ''` (path falsy → '') + L484 `|| false`
 *   - detectProjects L495 `workspace.path || ''` (workspace path falsy)
 *   - generateConversationName L611 `files[0].path.split('/').pop() || 'unknown'`
 *   - convertFileReferences L644 `file.lineCount || 0` + L645 `file.content || ''`
 *
 * Discipline: 0 source touched (#1936). No overlap with existing suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Mock the two analyzer dependencies (same as existing task-tree-builder.test.ts).
vi.mock('../workspace-analyzer.js', () => ({
    WorkspaceAnalyzer: {
        analyzeWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    },
}));
vi.mock('../relationship-analyzer.js', () => ({
    RelationshipAnalyzer: {
        analyzeRelationships: vi.fn().mockResolvedValue([]),
    },
}));

import { TaskTreeBuilder } from '../task-tree-builder.js';
import type { ConversationSummary } from '../../types/conversation.js';

// ─────────────────── Helpers ───────────────────

function makeConv(overrides: Partial<ConversationSummary> & { taskId: string }): ConversationSummary {
    return {
        prompt: '',
        lastActivity: '2026-07-03T10:00:00Z',
        messageCount: 5,
        size: 1024,
        hasApiHistory: true,
        hasUiMessages: true,
        path: '/tasks/test',
        metadata: {} as any,
        ...overrides,
    } as ConversationSummary;
}

describe('TaskTreeBuilder — coverage complement (cold `||` branches)', () => {
    let builder: TaskTreeBuilder;
    let anyBuilder: any;

    beforeEach(() => {
        builder = new TaskTreeBuilder();
        anyBuilder = builder as any;
    });

    // ─── belongsToWorkspace L477-478 ───

    it('belongsToWorkspace: workspace.path falsy → coerces to "" (|| "" pin)', () => {
        const conv = makeConv({
            taskId: 't1',
            metadata: {
                files_in_context: [{ path: '/any/file.ts' }],
            } as any,
        });
        const workspace = { path: '', name: 'ws' } as any;
        // path '' → startsWith('') is always true → matches; || false NOT hit (some=true)
        expect(anyBuilder.belongsToWorkspace(conv, workspace)).toBe(true);
    });

    it('belongsToWorkspace: no files → some() undefined → || false returns false', () => {
        const conv = makeConv({ taskId: 't2', metadata: {} as any });
        const workspace = { path: '/proj', name: 'ws' } as any;
        // metadata.files_in_context undefined → ?. short-circuits → some() not called
        // → expression undefined → || false
        expect(anyBuilder.belongsToWorkspace(conv, workspace)).toBe(false);
    });

    // ─── belongsToProject L483-484 ───

    it('belongsToProject: project.path falsy → coerces to "" (|| "" pin)', () => {
        const conv = makeConv({
            taskId: 't3',
            metadata: {
                files_in_context: [{ path: '/x/y.ts' }],
            } as any,
        });
        const project = { path: '', name: 'p' } as any;
        expect(anyBuilder.belongsToProject(conv, project)).toBe(true);
    });

    it('belongsToProject: no files → || false returns false', () => {
        const conv = makeConv({ taskId: 't4', metadata: { files_in_context: [] } as any });
        const project = { path: '/proj', name: 'p' } as any;
        // empty array → some()=false → || false
        expect(anyBuilder.belongsToProject(conv, project)).toBe(false);
    });

    // ─── detectProjects L495 ───

    it('detectProjects: workspace.path falsy → path coerces to "" (|| "" pin)', () => {
        const conv = makeConv({ taskId: 't5' });
        const workspace = {
            path: '',
            name: 'Empty Workspace',
            metadata: { technologies: ['ts'] },
        } as any;
        const projects = anyBuilder.detectProjects([conv], workspace);
        expect(projects).toHaveLength(1);
        expect(projects[0].path).toBe('');
        expect(projects[0].name).toBe('Empty Workspace Project');
    });

    // ─── generateConversationName L611 ───

    it('generateConversationName: file path whose last segment is empty → || "unknown"', () => {
        // 'a/b/'.split('/').pop() === '' (empty string, falsy) → || 'unknown'
        const conv = makeConv({
            taskId: 't6',
            metadata: {
                files_in_context: [{ path: 'a/b/' }],
            } as any,
        });
        const name = anyBuilder.generateConversationName(conv);
        expect(name).toBe('Travail sur unknown');
    });

    it('generateConversationName: normal file → basename used (no fallback)', () => {
        const conv = makeConv({
            taskId: 't7',
            metadata: {
                files_in_context: [{ path: 'src/index.ts' }],
            } as any,
        });
        expect(anyBuilder.generateConversationName(conv)).toBe('Travail sur index.ts');
    });

    // ─── convertFileReferences L644-645 ───

    it('convertFileReferences: lineCount + content falsy → || 0 / || "" (pin)', () => {
        const conv = makeConv({
            taskId: 't8',
            metadata: {
                files_in_context: [
                    { path: 'a.ts', lineCount: 0, content: '' },
                    { path: 'b.ts' /* undefined lineCount + content */ },
                ],
            } as any,
        });
        const refs = anyBuilder.convertFileReferences(conv);
        expect(refs).toHaveLength(2);
        // explicit 0 stays 0 (not the || 0 arm — 0 is the literal); undefined → 0 via ||
        expect(refs[0].lineCount).toBe(0);
        expect(refs[1].lineCount).toBe(0); // undefined → || 0
        // empty string stays '' (substring(0,200) of ''); undefined → '' via ||
        expect(refs[0].content).toBe('');
        expect(refs[1].content).toBe('');
    });

    it('convertFileReferences: no files_in_context → []', () => {
        const conv = makeConv({ taskId: 't9', metadata: {} as any });
        expect(anyBuilder.convertFileReferences(conv)).toEqual([]);
    });

    // ─── activity helpers L448/455/462/469: empty array → || new Date().toISOString() ───

    it('getLatestActivity: empty conversations → falls back to now (|| arm L448)', () => {
        const result = anyBuilder.getLatestActivity([]);
        // ISO string, parses cleanly, recent (within last minute)
        const parsed = Date.parse(result);
        expect(Number.isNaN(parsed)).toBe(false);
        expect(Math.abs(Date.now() - parsed)).toBeLessThan(60_000);
    });

    it('getEarliestActivity: empty conversations → falls back to now (|| arm L455)', () => {
        const result = anyBuilder.getEarliestActivity([]);
        expect(Date.parse(result)).not.toBeNaN();
    });

    it('getLatestActivityFromNodes: empty nodes → falls back to now (|| arm L462)', () => {
        const result = anyBuilder.getLatestActivityFromNodes([]);
        expect(Date.parse(result)).not.toBeNaN();
    });

    it('getEarliestActivityFromNodes: empty nodes → falls back to now (|| arm L469)', () => {
        const result = anyBuilder.getEarliestActivityFromNodes([]);
        expect(Date.parse(result)).not.toBeNaN();
    });
});
