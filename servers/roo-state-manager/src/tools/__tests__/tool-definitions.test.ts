/**
 * Tests for tool-definitions.ts — static schema validation for all 24 tool definitions.
 * Ensures structural integrity, naming conventions, and schema correctness.
 * #1863: 3 deprecated definitions (decision_info, machines, cleanup_messages) removed from tools/list.
 * #1922: 3 more deprecated removed (same as #1863 Pass 4).
 * #1841: 6 more definitions removed from allToolDefinitions (best practices, export_config, view_task_details,
 *        get_raw_conversation, refresh_dashboard, update_dashboard). Handlers preserved via registry.ts redirects.
 */

import { describe, it, expect } from 'vitest';
import {
    allToolDefinitions,
    conversationBrowserDefinition,
    taskExportDefinition,
    roosyncSearchDefinition,
    roosyncIndexingDefinition,
    codebaseSearchDefinition,
    readVscodeLogsDefinition,
    getMcpBestPracticesDefinition,
    exportDataDefinition,
    exportConfigDefinition,
    viewTaskDetailsDefinition,
    getRawConversationDefinition,
    analyzeRooSyncProblemsDefinition,
    roosyncInitDefinition,
    roosyncGetStatusDefinition,
    roosyncCompareConfigDefinition,
    roosyncListDiffsDefinition,
    roosyncDecisionDefinition,
    roosyncBaselineDefinition,
    roosyncConfigDefinition,
    roosyncInventoryDefinition,
    // #1609: roosyncHeartbeatDefinition removed — auto-heartbeat on any tool call
    // #1863: roosyncDecisionInfoDefinition, roosyncMachinesDefinition, roosyncCleanupMessagesDefinition removed
    roosyncMcpManagementDefinition,
    roosyncStorageManagementDefinition,
    roosyncDiagnoseDefinition,
    roosyncRefreshDashboardDefinition,
    roosyncUpdateDashboardDefinition,
    roosyncSendDefinition,
    roosyncReadDefinition,
    roosyncManageDefinition,
    roosyncAttachmentsDefinition,
    roosyncDashboardDefinition
} from '../tool-definitions.js';

const EXPECTED_TOOL_COUNT = 24;

// Order MUST mirror allToolDefinitions in tool-definitions.ts.
const allDefinitions = [
    conversationBrowserDefinition,
    taskExportDefinition,
    roosyncSearchDefinition,
    roosyncIndexingDefinition,
    codebaseSearchDefinition,
    readVscodeLogsDefinition,
    // [REMOVED #291] getMcpBestPracticesDefinition — removed from allToolDefinitions
    exportDataDefinition,
    // [REMOVED #291] exportConfigDefinition — removed from allToolDefinitions
    // [REMOVED #291] viewTaskDetailsDefinition — removed from allToolDefinitions
    // [REMOVED #291] getRawConversationDefinition — removed from allToolDefinitions
    analyzeRooSyncProblemsDefinition,
    roosyncInitDefinition,
    roosyncGetStatusDefinition,
    roosyncCompareConfigDefinition,
    roosyncListDiffsDefinition,
    roosyncDecisionDefinition,
    roosyncBaselineDefinition,
    roosyncConfigDefinition,
    roosyncInventoryDefinition,
    // #1609: roosyncHeartbeatDefinition removed — auto-heartbeat on any tool call
    roosyncMcpManagementDefinition,
    roosyncStorageManagementDefinition,
    roosyncDiagnoseDefinition,
    // [REMOVED #291] roosyncRefreshDashboardDefinition — removed from allToolDefinitions
    // [REMOVED #291] roosyncUpdateDashboardDefinition — removed from allToolDefinitions
    roosyncSendDefinition,
    roosyncReadDefinition,
    roosyncManageDefinition,
    roosyncAttachmentsDefinition,
    roosyncDashboardDefinition
];

describe('tool-definitions.ts — Schema Validation', () => {

    describe('allToolDefinitions array', () => {
        it('should have exactly 24 tool definitions', () => {
            expect(allToolDefinitions).toHaveLength(EXPECTED_TOOL_COUNT);
        });

        it('should contain all individual definitions in order', () => {
            for (let i = 0; i < allDefinitions.length; i++) {
                expect(allToolDefinitions[i]).toBe(allDefinitions[i]);
            }
        });

        it('should have unique tool names', () => {
            const names = allToolDefinitions.map(d => d.name);
            const uniqueNames = new Set(names);
            expect(uniqueNames.size).toBe(names.length);
        });
    });

    describe('Each definition — structural requirements', () => {
        it.each(allDefinitions.map(d => [d.name, d]))(
            '%s should have required top-level fields',
            (_name, def) => {
                expect(def).toHaveProperty('name');
                expect(def).toHaveProperty('description');
                expect(def).toHaveProperty('inputSchema');
                expect(typeof def.name).toBe('string');
                expect(typeof def.description).toBe('string');
                expect(typeof def.inputSchema).toBe('object');
            }
        );

        it.each(allDefinitions.map(d => [d.name, d]))(
            '%s should have valid inputSchema structure',
            (_name, def) => {
                const schema = def.inputSchema;
                expect(schema.type).toBe('object');
                expect(schema).toHaveProperty('properties');
                expect(typeof schema.properties).toBe('object');
            }
        );

        it.each(allDefinitions.map(d => [d.name, d]))(
            '%s should have non-empty description',
            (_name, def) => {
                expect(def.description.length).toBeGreaterThan(10);
            }
        );

        it.each(allDefinitions.map(d => [d.name, d]))(
            '%s should have valid property types',
            (_name, def) => {
                for (const [propName, propSchema] of Object.entries(def.inputSchema.properties)) {
                    const p = propSchema as Record<string, unknown>;
                    expect(p).toHaveProperty('type');
                    expect(typeof p.type).toBe('string');
                    expect(['string', 'number', 'boolean', 'integer', 'object', 'array']).toContain(p.type);
                    if (p.type === 'string' && 'enum' in p) {
                        expect(Array.isArray(p.enum)).toBe(true);
                        expect(p.enum.length).toBeGreaterThan(0);
                    }
                    if ('description' in p) {
                        expect(typeof p.description).toBe('string');
                    }
                }
            }
        );
    });

    describe('Tool name conventions', () => {
        it('should use snake_case for all tool names', () => {
            for (const def of allToolDefinitions) {
                expect(def.name).toMatch(/^[a-z][a-z0-9_]*$/);
            }
        });

        it('should not have duplicate names', () => {
            const names = allToolDefinitions.map(d => d.name);
            expect(new Set(names).size).toBe(names.length);
        });
    });

    describe('Tools with action parameter', () => {
        const actionTools = allDefinitions.filter(
            d => d.inputSchema.properties && 'action' in d.inputSchema.properties
        );

        it('should have action as required field (when required exists)', () => {
            for (const def of actionTools) {
                if (def.inputSchema.required) {
                    expect(def.inputSchema.required).toContain('action');
                }
            }
        });

        it('should have enum for action type', () => {
            for (const def of actionTools) {
                const actionProp = def.inputSchema.properties.action as Record<string, unknown>;
                expect(actionProp.enum).toBeDefined();
                expect(Array.isArray(actionProp.enum)).toBe(true);
            }
        });
    });

    describe('Specific tool schemas', () => {
        it('conversation_browser should have all documented actions', () => {
            const actions = (conversationBrowserDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('list');
            expect(actions).toContain('tree');
            expect(actions).toContain('current');
            expect(actions).toContain('view');
            expect(actions).toContain('summarize');
            expect(actions).toContain('rebuild');
        });

        it('roosync_search should support semantic, text, and diagnose', () => {
            const actions = (roosyncSearchDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('semantic');
            expect(actions).toContain('text');
            expect(actions).toContain('diagnose');
        });

        it('roosync_indexing should have status action', () => {
            const actions = (roosyncIndexingDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('status');
        });

        it('export_data should require target and format', () => {
            expect(exportDataDefinition.inputSchema.required).toContain('target');
            expect(exportDataDefinition.inputSchema.required).toContain('format');
        });

        it('codebase_search should require query', () => {
            expect(codebaseSearchDefinition.inputSchema.required).toContain('query');
        });

        it('view_task_details should require task_id', () => {
            expect(viewTaskDetailsDefinition.inputSchema.required).toContain('task_id');
        });

        it('get_raw_conversation should require taskId', () => {
            expect(getRawConversationDefinition.inputSchema.required).toContain('taskId');
        });

        it('roosync_send should have action send/reply/amend', () => {
            const actions = (roosyncSendDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('send');
            expect(actions).toContain('reply');
            expect(actions).toContain('amend');
        });

        it('roosync_read should require mode', () => {
            expect(roosyncReadDefinition.inputSchema.required).toContain('mode');
            const modes = (roosyncReadDefinition.inputSchema.properties.mode as Record<string, unknown>).enum as string[];
            expect(modes).toContain('inbox');
            expect(modes).toContain('message');
            expect(modes).toContain('attachments');
        });

        // #1609: roosync_heartbeat test removed — auto-heartbeat on any tool call

        it('roosync_diagnose should have env/debug/reset/test actions', () => {
            const actions = (roosyncDiagnoseDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('env');
            expect(actions).toContain('debug');
            expect(actions).toContain('reset');
            expect(actions).toContain('test');
        });

        it('roosync_config should support collect/publish/apply/apply_profile', () => {
            const actions = (roosyncConfigDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('collect');
            expect(actions).toContain('publish');
            expect(actions).toContain('apply');
            expect(actions).toContain('apply_profile');
        });

        it('roosync_dashboard should be derived from dashboard-schemas', () => {
            expect(roosyncDashboardDefinition.name).toBe('roosync_dashboard');
        });

        it('roosync_manage should support mark_read and archive', () => {
            const actions = (roosyncManageDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('mark_read');
            expect(actions).toContain('archive');
            expect(actions).toContain('bulk_mark_read');
            expect(actions).toContain('bulk_archive');
            expect(actions).toContain('cleanup');
            expect(actions).toContain('stats');
        });

        it('roosync_mcp_management should have manage/rebuild/touch actions', () => {
            const actions = (roosyncMcpManagementDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('manage');
            expect(actions).toContain('rebuild');
            expect(actions).toContain('touch');
        });

        it('roosync_storage_management should have storage and maintenance actions', () => {
            const actions = (roosyncStorageManagementDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('storage');
            expect(actions).toContain('maintenance');
        });

        it('roosync_compare_config should support full granularity', () => {
            const granularity = (roosyncCompareConfigDefinition.inputSchema.properties.granularity as Record<string, unknown>).enum as string[];
            expect(granularity).toContain('full');
            expect(granularity).toContain('mcp');
            expect(granularity).toContain('mode');
        });

        it('roosync_baseline should have all actions', () => {
            const actions = (roosyncBaselineDefinition.inputSchema.properties.action as Record<string, unknown>).enum as string[];
            expect(actions).toContain('update');
            expect(actions).toContain('version');
            expect(actions).toContain('restore');
            expect(actions).toContain('export');
        });

        it('roosync_decision should require action and decisionId', () => {
            expect(roosyncDecisionDefinition.inputSchema.required).toContain('action');
            expect(roosyncDecisionDefinition.inputSchema.required).toContain('decisionId');
        });

        it('roosync_attachments should require action', () => {
            expect(roosyncAttachmentsDefinition.inputSchema.required).toContain('action');
        });

        it('roosync_inventory should require type', () => {
            expect(roosyncInventoryDefinition.inputSchema.required).toContain('type');
        });

        it('export_config should require action', () => {
            expect(exportConfigDefinition.inputSchema.required).toContain('action');
        });

        it('task_export should require action', () => {
            expect(taskExportDefinition.inputSchema.required).toContain('action');
        });

        it('roosync_list_diffs should have filterType enum', () => {
            const filterTypes = (roosyncListDiffsDefinition.inputSchema.properties.filterType as Record<string, unknown>).enum as string[];
            expect(filterTypes).toContain('all');
            expect(filterTypes).toContain('config');
            expect(filterTypes).toContain('files');
            expect(filterTypes).toContain('settings');
        });

        it('roosync_update_dashboard should require section and content', () => {
            expect(roosyncUpdateDashboardDefinition.inputSchema.required).toContain('section');
            expect(roosyncUpdateDashboardDefinition.inputSchema.required).toContain('content');
        });
    });

    describe('No handler imports (perf contract)', () => {
        it('should import only dashboard-schemas (no handler modules)', async () => {
            const source = await import('fs').then(fs =>
                fs.readFileSync(
                    new URL('../tool-definitions.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
                    'utf-8'
                )
            );
            const importLines = source.split('\n').filter(l => l.trim().startsWith('import'));
            expect(importLines).toHaveLength(1);
            expect(importLines[0]).toContain('dashboard-schemas');
        });
    });

    describe('additionalProperties: false where declared', () => {
        const strictTools = [
            roosyncInitDefinition, roosyncGetStatusDefinition, roosyncCompareConfigDefinition,
            roosyncListDiffsDefinition, roosyncBaselineDefinition, roosyncConfigDefinition,
            roosyncInventoryDefinition,
            // #1609: roosyncHeartbeatDefinition removed
            // #1863: roosyncMachinesDefinition removed
            roosyncMcpManagementDefinition, roosyncStorageManagementDefinition,
            roosyncDiagnoseDefinition
            // [REMOVED #291] roosyncRefreshDashboardDefinition, roosyncUpdateDashboardDefinition
        ];

        it.each(strictTools.map(d => [d.name, d]))(
            '%s should have additionalProperties: false',
            (_name, def) => {
                expect(def.inputSchema.additionalProperties).toBe(false);
            }
        );
    });
});
