/**
 * summary-generator.coverage.test.ts - Coverage complement for summary-generator.ts
 *
 * Source-grounded targets (pre-PR baseline file-scoped: L=79.69% / B=67.95% / F=81.61%):
 *
 * REACHABLE cold branches covered below:
 *
 * analyzeActivityPattern
 * - L242: `currentBurst.conversations.length >= 3` else-arm → burst period of <3 convs
 *          (need a sorted burst of 2 within 24h so the `else` fires the close-burst path
 *          with `length < 3`, which falls through to `currentBurst = new`)
 *
 * inferTechnologyFromFile
 * - L313: `extension ? ...` falsy arm OR `techMap[extension] || null` falsy arm
 *          → file with no extension (e.g. "Makefile") OR unknown extension
 *
 * analyzeTechnologiesOld (L319) and analyzeTechnologiesFixed (L347) — both private
 * - L323/L351: `conv.metadata?.files_in_context` truthy arm (need conv with files_in_context)
 * - L326/L354: `if (tech)` truthy arm (need files with KNOWN extensions in techMap)
 * - L327/L355: `|| = 0` binary-expr alt-arm (first occurrence of a tech → no existing count)
 *
 * analyzeFileTypes
 * - L381: `|| 'unknown'` alt-arm → file path with NO extension (e.g. "Makefile")
 *          Note: paths like "/etc/hosts" with no '.' produce "hosts" as the popped
 *          element; need a path where `.split('.').pop()` is undefined → use "noext" (no dot)
 *          which actually returns "noext" as the last element. To hit the alt-arm, we
 *          need a file path that when split by '.', the last element is empty string.
 *          The source uses `?.toLowerCase() || 'unknown'` — to hit `|| 'unknown'`:
 *          - extension undefined (`?.toLowerCase()` returns undefined) → 'unknown' fires
 *          Achievable with empty string `''` or just calling `''.split('.').pop()` → ''
 *          Actually `''.split('.').pop()` returns `''`, and `'' || 'unknown'` → 'unknown' ✓
 *
 * inferConversationOutcome
 * - L427: `hasApiHistory && hasUiMessages` truthy arm → test "completed" outcome explicitly
 *
 * extractWorkspaceKeyPoints
 * - L441: `totalConversations > 50` truthy arm → workspace with >50 convs (key point "très actif")
 * - L449: `burstPeriods.length > 0` truthy arm → workspace with at least one burst period
 *
 * generateWorkspaceTags
 * - L473: `totalConversations > 100` truthy arm → workspace with >100 convs (tag "high-activity")
 * - L475: `timeSpan.durationDays > 365` truthy arm → workspace spanning >365 days
 *
 * generateInsights
 * - L545: `mostActiveWorkspace[0]?.name || 'N/A'` binary-expr alt-arm → empty
 *          workspaceSummaries → sort returns empty → [0]?.name is undefined → 'N/A'
 * - L549: `ws.children || []` binary-expr alt-arm → workspace summary with no
 *          children array (e.g. node where ws.children is undefined)
 *
 * extractWorkspaces
 * - L590: `root.type === TaskType.WORKSPACE` else-arm → non-WORKSPACE root type
 * - L594: `root.children` truthy arm → root with children but root.type !== WORKSPACE
 *
 * Discipline:
 * - 0 source touched (add-only)
 * - Each test names its source line anchor (anti-churn #1936)
 * - Private static methods invoked through public entry points or via `as any` cast
 * - Reuses `createConversation` / `createWorkspaceNode` factory pattern from canonical test
 */

import { describe, test, expect } from 'vitest';
import { SummaryGenerator, type SummaryMetrics } from '../summary-generator.js';
import { TaskType } from '../../types/task-tree.js';
import type { ConversationSummary } from '../../types/conversation.js';
import type { TaskTree, WorkspaceNode, ProjectNode, TaskClusterNode, ConversationNode, TreeNode } from '../../types/task-tree.js';

// === Factories (mirror existing summary-generator.test.ts) ===

function createConversation(overrides: Partial<ConversationSummary> & { taskId: string }): ConversationSummary {
    return {
        prompt: '',
        lastActivity: '2026-02-10T10:00:00Z',
        messageCount: 10,
        size: 1024,
        hasApiHistory: true,
        hasUiMessages: true,
        path: '/tasks/test',
        metadata: {} as any,
        ...overrides,
    };
}

function createClusterNode(id: string, children: ConversationNode[] = []): TaskClusterNode {
    return {
        id,
        name: `Cluster ${id}`,
        type: TaskType.TASK_CLUSTER,
        children,
        metadata: {
            description: '',
            tags: [],
            lastActivity: '2026-02-10T10:00:00Z',
            size: 0,
            theme: 'test',
            timespan: { start: '2026-02-01', end: '2026-02-10' },
            relatedFiles: [],
            conversationCount: children.length,
            averageSize: 0,
        },
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-10T00:00:00Z',
    } as any;
}

function createProjectNode(id: string, clusters: TaskClusterNode[] = []): ProjectNode {
    return {
        id,
        name: `Project ${id}`,
        type: TaskType.PROJECT,
        children: clusters,
        metadata: {
            description: '',
            tags: [],
            lastActivity: '2026-02-10T10:00:00Z',
            size: 0,
            conversationCount: 0,
            filePatterns: [],
            technologies: [],
            complexity: 'medium',
            status: 'active',
            clusterCount: clusters.length,
            averageClusterSize: 0,
        },
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-10T00:00:00Z',
    } as any;
}

function createWorkspaceNode(id: string, projects: ProjectNode[] = [], opts: { commonPaths?: string[] } = {}): WorkspaceNode {
    return {
        id,
        name: `Workspace ${id}`,
        type: TaskType.WORKSPACE,
        path: `/workspace/${id}`,
        children: projects,
        metadata: {
            description: '',
            tags: [],
            lastActivity: '2026-02-10T10:00:00Z',
            size: 0,
            totalConversations: 0,
            totalSize: 0,
            detectedFrom: [],
            technologies: [],
            projectCount: projects.length,
            clusterCount: 0,
            commonPaths: opts.commonPaths ?? [`/workspace/${id}`],
        },
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-10T00:00:00Z',
    } as any;
}

function createMinimalTree(root: TreeNode): TaskTree {
    return {
        root: root as any,
        metadata: {
            version: '1.0.0',
            builtAt: '2026-02-10T00:00:00Z',
            buildTime: 100,
            totalNodes: 1,
            maxDepth: 0,
            qualityScore: 0.5,
        },
        relationships: [],
        index: { byId: new Map(), byType: new Map(), byPath: new Map(), byTechnology: new Map(), byTimeRange: new Map() },
    };
}

describe('summary-generator — coverage complement', () => {
    // ============================================================
    // analyzeActivityPattern — L242 burst-else arm (<3 convs)
    // ============================================================
    describe('analyzeActivityPattern — burst with <3 convs (L242)', () => {
        test('L242: should NOT push a burst period when only 2 convs are within 24h (else-arm < 3)', () => {
            const ws = createWorkspaceNode('ws-burst-small');
            const tree = createMinimalTree(ws);
            // 2 conversations within 24h → burst length 2 < 3 → L242 else fires
            const conversations = [
                createConversation({ taskId: 't-b1', lastActivity: '2026-02-10T08:00:00Z' }),
                createConversation({ taskId: 't-b2', lastActivity: '2026-02-10T10:00:00Z' }),
                // 3rd conv 48h later breaks the burst (L238 else)
                createConversation({ taskId: 't-b3', lastActivity: '2026-02-12T10:00:00Z' }),
            ];

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);

            // 2-conv burst → not pushed → 0 burst periods
            expect(summary.overview.globalMetrics.activityPattern.burstPeriods).toHaveLength(0);
        });
    });

    // ============================================================
    // inferTechnologyFromFile — L313 alt-arm (no extension OR unknown)
    // ============================================================
    describe('inferTechnologyFromFile — no extension / unknown (L313)', () => {
        test('L313 falsy: should return null for path with no extension (e.g. "Makefile")', () => {
            const ws = createWorkspaceNode('ws-noext');
            const tree = createMinimalTree(ws);
            const conversations = [
                createConversation({
                    taskId: 't-noext',
                    metadata: {
                        files_in_context: [
                            { path: 'Makefile', lineCount: 50 },
                            { path: 'LICENSE', lineCount: 100 },
                        ],
                    } as any,
                }),
            ];

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);

            // No extension → inferTechnologyFromFile returns null → no tech counted
            expect(summary.overview.globalMetrics.technologies).toHaveLength(0);
        });

        test('L313 alt-arm: should return null for unknown extension (e.g. ".xyz")', () => {
            const ws = createWorkspaceNode('ws-unknown');
            const tree = createMinimalTree(ws);
            const conversations = [
                createConversation({
                    taskId: 't-unknown',
                    metadata: {
                        files_in_context: [
                            { path: 'data.xyz', lineCount: 10 },
                            { path: 'config.zzz', lineCount: 20 },
                        ],
                    } as any,
                }),
            ];

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);

            // Unknown extensions → techMap[ext] || null → null → no tech counted
            expect(summary.overview.globalMetrics.technologies).toHaveLength(0);
        });
    });

    // ============================================================
    // analyzeTechnologiesOld / analyzeTechnologiesFixed — private paths
    // ============================================================
    describe('analyzeTechnologiesOld / analyzeTechnologiesFixed — private methods (L323-327, L351-355)', () => {
        test('L323/L326/L327: analyzeTechnologiesOld covers files_in_context + new tech', () => {
            // Access private static method via cast; bind `this` to SummaryGenerator so the
            // internal `this.inferTechnologyFromFile(...)` resolves.
            const OldAnalyzer = (SummaryGenerator as any).analyzeTechnologiesOld.bind(SummaryGenerator);
            expect(typeof OldAnalyzer).toBe('function');

            const conversations = [
                createConversation({
                    taskId: 't-old-1',
                    metadata: {
                        files_in_context: [
                            { path: 'service.ts', lineCount: 100 }, // known → adds 'TypeScript'
                        ],
                    } as any,
                }),
            ];

            const result = OldAnalyzer(conversations);
            expect(result).toBeInstanceOf(Array);
            // First occurrence of TypeScript → L327 `|| 0` binary-expr alt-arm fires
            const ts = result.find((t: any) => t.name === 'TypeScript');
            expect(ts).toBeDefined();
            expect(ts.count).toBe(1);
        });

        test('L323 falsy: analyzeTechnologiesOld skips conv with no files_in_context', () => {
            const OldAnalyzer = (SummaryGenerator as any).analyzeTechnologiesOld.bind(SummaryGenerator);
            const conversations = [
                createConversation({ taskId: 't-empty', metadata: {} as any }),
            ];
            const result = OldAnalyzer(conversations);
            // No files_in_context → 0 tech
            expect(result).toEqual([]);
        });

        test('L351/L354/L355: analyzeTechnologiesFixed covers files_in_context + new tech', () => {
            const FixedAnalyzer = (SummaryGenerator as any).analyzeTechnologiesFixed.bind(SummaryGenerator);
            expect(typeof FixedAnalyzer).toBe('function');

            const conversations = [
                createConversation({
                    taskId: 't-fix-1',
                    metadata: {
                        files_in_context: [
                            { path: 'app.py', lineCount: 200 }, // known → adds 'Python'
                        ],
                    } as any,
                }),
            ];

            const result = FixedAnalyzer(conversations);
            expect(result).toBeInstanceOf(Array);
            const py = result.find((t: any) => t.name === 'Python');
            expect(py).toBeDefined();
            expect(py.count).toBe(1);
        });
    });

    // ============================================================
    // analyzeFileTypes — L381 alt-arm (no extension → "unknown")
    // ============================================================
    describe('analyzeFileTypes — path with no extension (L381)', () => {
        test('L381: should bucket files with no extension as "unknown"', () => {
            const ws = createWorkspaceNode('ws-noext-ft');
            const tree = createMinimalTree(ws);
            const conversations = [
                createConversation({
                    taskId: 't-noext-ft',
                    metadata: {
                        files_in_context: [
                            { path: 'Makefile', lineCount: 50 },      // no '.'
                            { path: 'a.ts', lineCount: 100 },         // known
                        ],
                    } as any,
                }),
            ];

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);

            // "Makefile".split('.').pop() === 'Makefile' (no dot, last element = whole string),
            // not undefined. So this does NOT hit the `|| 'unknown'` arm via Makefile.
            // We need a path that produces empty/undefined when split by '.'.
            // Empty string ''.split('.').pop() === '' → '' || 'unknown' → 'unknown'
            // But we cannot easily pass an empty path through files_in_context semantics.
            // Alternative: a path that ends with '.': 'foo.'.split('.').pop() === '' → unknown
            const conversations2 = [
                createConversation({
                    taskId: 't-trailing-dot',
                    metadata: {
                        files_in_context: [
                            { path: 'foo.', lineCount: 10 }, // trailing dot → pop() = '' → 'unknown'
                        ],
                    } as any,
                }),
            ];
            const summary2 = SummaryGenerator.generateTaskTreeSummary(tree, conversations2);
            const unknown = summary2.overview.globalMetrics.fileTypes.find(f => f.extension === 'unknown');
            expect(unknown).toBeDefined();
            expect(unknown!.count).toBe(1);
        });
    });

    // ============================================================
    // inferConversationOutcome — L427 (completed) truthy arm
    // ============================================================
    describe('inferConversationOutcome — "completed" arm (L427)', () => {
        test('L427 truthy: should classify conv with apiHistory+uiMessages AND 4..20 messages as completed', () => {
            // Note: the source checks messageCount > 20 BEFORE the apiHistory/ui check.
            // We need messageCount in [3, 20] AND hasApiHistory AND hasUiMessages → "completed".
            const ws = createWorkspaceNode('ws-completed');
            const tree = createMinimalTree(ws);
            const conversations = [
                createConversation({
                    taskId: 't-complete',
                    messageCount: 10,
                    hasApiHistory: true,
                    hasUiMessages: true,
                }),
            ];

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);
            const completed = summary.overview.globalMetrics.outcomes.find(o => o.type === 'completed');
            expect(completed).toBeDefined();
            expect(completed!.count).toBe(1);
        });

        test('L427 falsy: should classify conv with apiHistory+uiMessages but messageCount > 20 as complex (L426 takes precedence)', () => {
            const ws = createWorkspaceNode('ws-complex-precedence');
            const tree = createMinimalTree(ws);
            const conversations = [
                createConversation({
                    taskId: 't-complex-precedence',
                    messageCount: 25, // > 20 → "complex" via L426
                    hasApiHistory: true,
                    hasUiMessages: true,
                }),
            ];

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, conversations);
            // L426 fires first → "complex", not "completed"
            const complex = summary.overview.globalMetrics.outcomes.find(o => o.type === 'complex');
            const completed = summary.overview.globalMetrics.outcomes.find(o => o.type === 'completed');
            expect(complex).toBeDefined();
            expect(completed).toBeUndefined();
        });
    });

    // ============================================================
    // extractWorkspaceKeyPoints — L441 + L449 (high conv count + bursts)
    // ============================================================
    describe('extractWorkspaceKeyPoints — high count + bursts (L441, L449)', () => {
        test('L441 truthy: should include "très actif" keypoint when totalConversations > 50', () => {
            // Need workspace with >50 conversations to trigger the L441 branch.
            // Path-filter requires workspace path prefix; use 51 convs all matching the
            // workspace's commonPath.
            const ws = createWorkspaceNode('ws-active', [], { commonPaths: ['/workspace/ws-active'] });
            const conversations: ConversationSummary[] = [];
            for (let i = 0; i < 55; i++) {
                conversations.push(createConversation({
                    taskId: `t-active-${i}`,
                    path: `/workspace/ws-active/task-${i}`,
                }));
            }

            const summary = SummaryGenerator.generateWorkspaceSummary(ws, conversations);
            const hasActivePoint = summary.keyPoints.some(p => p.includes('très actif'));
            expect(hasActivePoint).toBe(true);
        });

        test('L449 truthy: should include "burst" keypoint when burstPeriods.length > 0', () => {
            const ws = createWorkspaceNode('ws-burst', [], { commonPaths: ['/workspace/ws-burst'] });
            // The source (L242) only PUSHES a burst when the `else` branch (timeDiff > 24h)
            // fires AFTER a burst period reached length >= 3. So we need:
            // - 3 convs within 24h (= the burst we're targeting)
            // - A 4th conv 25h+ AFTER the 3rd (= triggers else → pushes the 3-conv burst)
            const conversations = [
                createConversation({ taskId: 't-b1', lastActivity: '2026-02-10T08:00:00Z', path: '/workspace/ws-burst/t-b1' }),
                createConversation({ taskId: 't-b2', lastActivity: '2026-02-10T10:00:00Z', path: '/workspace/ws-burst/t-b2' }),
                createConversation({ taskId: 't-b3', lastActivity: '2026-02-10T12:00:00Z', path: '/workspace/ws-burst/t-b3' }),
                // 30 hours after t-b3 → triggers else → L242 truthy → burst pushed
                createConversation({ taskId: 't-b4', lastActivity: '2026-02-11T18:00:00Z', path: '/workspace/ws-burst/t-b4' }),
            ];

            const summary = SummaryGenerator.generateWorkspaceSummary(ws, conversations);
            const hasBurstPoint = summary.keyPoints.some(p => p.includes('périodes d\'activité intense'));
            expect(hasBurstPoint).toBe(true);
        });
    });

    // ============================================================
    // generateWorkspaceTags — L473 + L475 (high count + long duration)
    // ============================================================
    describe('generateWorkspaceTags — high-activity + long-term (L473, L475)', () => {
        test('L473 truthy: should add "high-activity" tag when totalConversations > 100', () => {
            const ws = createWorkspaceNode('ws-high', [], { commonPaths: ['/workspace/ws-high'] });
            const conversations: ConversationSummary[] = [];
            for (let i = 0; i < 105; i++) {
                conversations.push(createConversation({
                    taskId: `t-high-${i}`,
                    path: `/workspace/ws-high/task-${i}`,
                }));
            }

            const summary = SummaryGenerator.generateWorkspaceSummary(ws, conversations);
            expect(summary.tags).toContain('high-activity');
        });

        test('L475 truthy: should add "long-term" tag when timeSpan.durationDays > 365', () => {
            const ws = createWorkspaceNode('ws-long', [], { commonPaths: ['/workspace/ws-long'] });
            // 400+ day span
            const conversations = [
                createConversation({ taskId: 't-early', lastActivity: '2024-01-01T10:00:00Z', path: '/workspace/ws-long/t-early' }),
                createConversation({ taskId: 't-late', lastActivity: '2025-02-15T10:00:00Z', path: '/workspace/ws-long/t-late' }),
            ];

            const summary = SummaryGenerator.generateWorkspaceSummary(ws, conversations);
            expect(summary.tags).toContain('long-term');
        });
    });

    // ============================================================
    // generateInsights — L545 (no workspace) + L549 (ws without children)
    // ============================================================
    describe('generateInsights — empty + no-children arms (L545, L549)', () => {
        test('L545 alt-arm: should return "N/A" for mostActiveWorkspace when no workspaces', () => {
            // We need to call generateTaskTreeSummary with a tree whose root is not a
            // WORKSPACE AND has no workspace children → extractWorkspaces returns []
            // → workspaceSummaries is [] → L545 binary-expr alt-arm fires → 'N/A'
            const root: TreeNode = {
                id: 'root-non-ws',
                name: 'Non-workspace root',
                type: TaskType.PROJECT, // not WORKSPACE
                children: [], // no children either
                metadata: {} as any,
            } as any;
            const tree = createMinimalTree(root);

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, []);
            // No workspaces → mostActiveWorkspace defaults to 'N/A'
            expect(summary.insights.mostActiveWorkspace).toBe('N/A');
        });

        test('L549 alt-arm: should handle workspace summary without children array', () => {
            // Bind `this` to SummaryGenerator so internal `this.analyzeTechnologyTrends(...)` resolves.
            const generateInsights = (SummaryGenerator as any).generateInsights.bind(SummaryGenerator);
            expect(typeof generateInsights).toBe('function');

            // Build a workspaceSummary WITHOUT a children property
            const wsSummary: any = {
                id: 'ws-no-kids',
                name: 'ws-no-kids',
                type: TaskType.WORKSPACE,
                description: '',
                keyPoints: [],
                metrics: {
                    totalConversations: 0,
                    totalMessages: 0,
                    totalSize: 0,
                    averageMessageCount: 0,
                    timeSpan: { start: new Date(), end: new Date(), durationDays: 0 },
                    activityPattern: { peakHours: [], peakDays: [], burstPeriods: [] },
                    technologies: [],
                    fileTypes: [],
                    outcomes: [],
                },
                // NO `children` key → L549 `ws.children || []` alt-arm fires
            };

            const result = generateInsights({} as TaskTree, [], [wsSummary]);
            // The flatMap over ws.children returns []. After sort, [0] is undefined → 'N/A'
            expect(result.mostComplexProject).toBe('N/A');
        });
    });

    // ============================================================
    // extractWorkspaces — L590 + L594 (non-WORKSPACE root arms)
    // ============================================================
    describe('extractWorkspaces — non-WORKSPACE root (L590 else, L594 truthy)', () => {
        test('L590 else: should return [] when root has no children and is not WORKSPACE', () => {
            const root: TreeNode = {
                id: 'r-project',
                name: 'Project-root',
                type: TaskType.PROJECT, // not WORKSPACE
                children: undefined, // L594 else → L598 return []
                metadata: {} as any,
            } as any;
            const tree = createMinimalTree(root);

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, []);
            // No workspaces extracted
            expect(summary.overview.totalWorkspaces).toBe(0);
        });

        test('L594 truthy: should filter children of type WORKSPACE from non-WORKSPACE root', () => {
            // Build a non-WORKSPACE root with 2 WORKSPACE children + 1 PROJECT child.
            // extractWorkspaces filters for type === WORKSPACE.
            const wsA = createWorkspaceNode('ws-A');
            const wsB = createWorkspaceNode('ws-B');
            const projectChild = createProjectNode('p-mixed');

            const root: TreeNode = {
                id: 'r-mixed',
                name: 'Mixed-root',
                type: TaskType.PROJECT, // L590 false → go to L594
                children: [wsA, projectChild, wsB], // L594 truthy → filter for WORKSPACE
                metadata: {} as any,
            } as any;
            const tree = createMinimalTree(root);

            const summary = SummaryGenerator.generateTaskTreeSummary(tree, []);
            // 2 of 3 children are WORKSPACE
            expect(summary.overview.totalWorkspaces).toBe(2);
        });
    });
});
