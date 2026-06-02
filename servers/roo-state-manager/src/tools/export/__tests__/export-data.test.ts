/**
 * Tests unitaires pour export_data
 *
 * CONS-10: Outil consolidé qui remplace 5 outils d'export:
 *   - export_tasks_xml
 *   - export_conversation_xml
 *   - export_project_xml
 *   - export_conversation_json
 *   - export_conversation_csv
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module export/export-data.test
 * @version 1.0.0 (CONS-10)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleExportData, exportDataTool, ExportDataArgs } from '../export-data.js';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Helper to extract text from CallToolResult content */
function getTextContent(result: CallToolResult, index: number = 0): string {
    const content = result.content[index];
    if (content && content.type === 'text') {
        return content.text;
    }
    return '';
}

// Mock XmlExporterService
const mockXmlExporterService = {
    generateTaskXml: vi.fn(() => '<task>mock xml</task>'),
    generateConversationXml: vi.fn(() => '<conversation>mock xml</conversation>'),
    generateProjectXml: vi.fn(() => '<project>mock xml</project>'),
    saveXmlToFile: vi.fn()
};

// Mock TraceSummaryService avec vi.hoisted (pattern ESM fiable)
const { mockGenerateSummary } = vi.hoisted(() => ({
    mockGenerateSummary: vi.fn()
}));

vi.mock('../../../services/TraceSummaryService.js', () => ({
    TraceSummaryService: class {
        generateSummary = mockGenerateSummary;
    }
}));

// Mock ExportConfigManager
vi.mock('../../../services/ExportConfigManager.js', () => ({
    ExportConfigManager: vi.fn().mockImplementation(() => ({
        getConfig: vi.fn().mockResolvedValue({ setting: 'value' }),
        updateConfig: vi.fn(),
        resetConfig: vi.fn()
    }))
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
    default: {
        mkdir: vi.fn(),
        writeFile: vi.fn()
    }
}));

describe('export_data - CONS-10', () => {
    let mockCache: Map<string, ConversationSkeleton>;
    let mockEnsureCache: (options?: { workspace?: string }) => Promise<void>;
    let mockGetSkeleton: (taskId: string) => Promise<ConversationSkeleton | null>;

    const createMockSkeleton = (taskId: string, parentId?: string): ConversationSkeleton => ({
        taskId,
        parentTaskId: parentId,
        metadata: {
            title: 'Test Task',
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 10,
            actionCount: 5,
            totalSize: 1024,
            workspace: '/test/workspace'
        },
        sequence: []
    });

    beforeEach(() => {
        mockCache = new Map();
        mockCache.set('task-123', createMockSkeleton('task-123'));
        mockCache.set('conv-456', createMockSkeleton('conv-456'));
        mockCache.set('child-789', createMockSkeleton('child-789', 'conv-456'));

        mockEnsureCache = vi.fn(async () => {});
        mockGetSkeleton = vi.fn(async (taskId: string) => mockCache.get(taskId) || null);

        vi.clearAllMocks();

        // Re-setup TraceSummaryService mock after clearAllMocks
        mockGenerateSummary.mockResolvedValue({
            success: true,
            content: '{"mock": "json"}',
            statistics: {
                totalSections: 10,
                userMessages: 5,
                assistantMessages: 4,
                toolResults: 1,
                totalContentSize: 1024
            }
        });
    });

    // ============================================================
    // Tests de validation des arguments
    // ============================================================

    describe('argument validation', () => {
        test('should return error when target is missing', async () => {
            const args = { format: 'xml' } as ExportDataArgs;

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('target');
        });

        test('should return error when format is missing', async () => {
            const args = { target: 'task' } as ExportDataArgs;

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('format');
        });

        test('should return error for invalid target/format combination', async () => {
            const args: ExportDataArgs = {
                target: 'task',
                format: 'json', // task only supports xml
                taskId: 'task-123'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('non supportée');
        });

        test('should return error when taskId is missing for target=task', async () => {
            const args: ExportDataArgs = {
                target: 'task',
                format: 'xml'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('taskId');
        });

        test('should return error when conversationId is missing for target=conversation format=xml', async () => {
            const args: ExportDataArgs = {
                target: 'conversation',
                format: 'xml'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('conversationId');
        });

        test('should return error when projectPath is missing for target=project', async () => {
            const args: ExportDataArgs = {
                target: 'project',
                format: 'xml'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('projectPath');
        });
    });

    // ============================================================
    // Tests pour target=task format=xml
    // ============================================================

    describe('target: task, format: xml', () => {
        test('should export task as XML', async () => {
            const args: ExportDataArgs = {
                target: 'task',
                format: 'xml',
                taskId: 'task-123'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
            expect(mockEnsureCache).toHaveBeenCalled();
        });

        test('should return error when task not found', async () => {
            const args: ExportDataArgs = {
                target: 'task',
                format: 'xml',
                taskId: 'non-existent'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('non trouvée');
        });
    });

    // ============================================================
    // Tests pour target=conversation format=xml
    // ============================================================

    describe('target: conversation, format: xml', () => {
        test('should export conversation as XML', async () => {
            const args: ExportDataArgs = {
                target: 'conversation',
                format: 'xml',
                conversationId: 'conv-456'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
            expect(mockEnsureCache).toHaveBeenCalled();
        });
    });

    // ============================================================
    // Tests pour target=conversation format=json
    // ============================================================

    describe('target: conversation, format: json', () => {
        test('should export conversation as JSON', async () => {
            const args: ExportDataArgs = {
                target: 'conversation',
                format: 'json',
                taskId: 'task-123',
                jsonVariant: 'full'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
        });

        test('should require taskId for json format', async () => {
            const args: ExportDataArgs = {
                target: 'conversation',
                format: 'json'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('taskId');
        });
    });

    // ============================================================
    // Tests pour target=conversation format=csv
    // ============================================================

    describe('target: conversation, format: csv', () => {
        test('should export conversation as CSV', async () => {
            const args: ExportDataArgs = {
                target: 'conversation',
                format: 'csv',
                taskId: 'task-123',
                csvVariant: 'messages'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
        });

        test('should require taskId for csv format', async () => {
            const args: ExportDataArgs = {
                target: 'conversation',
                format: 'csv'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('taskId');
        });
    });

    // ============================================================
    // Tests pour target=project format=xml
    // ============================================================

    describe('target: project, format: xml', () => {
        test('should export project as XML', async () => {
            const args: ExportDataArgs = {
                target: 'project',
                format: 'xml',
                projectPath: '/test/workspace'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
            expect(mockEnsureCache).toHaveBeenCalledWith({ workspace: '/test/workspace' });
        });

        // #2307 Phase 1 item #2 — memory guards (count cap, byte cap, boundary)

        test('should reject when conversation count exceeds cap', async () => {
            // Lower the cap to 5 to trigger guard without populating 50001 entries
            vi.stubEnv('EXPORT_MAX_PROJECT_CONVERSATIONS', '5');
            vi.stubEnv('EXPORT_MAX_PROJECT_BYTES', String(100 * 1024 * 1024));

            // mockCache already has 3 entries from beforeEach; add 3 more to push count to 6
            for (let i = 0; i < 3; i++) {
                mockCache.set(
                    `extra-task-${i}`,
                    createMockSkeleton(`extra-task-${i}`)
                );
            }

            const args: ExportDataArgs = {
                target: 'project',
                format: 'xml',
                projectPath: '/test/workspace'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            // handleExportData wraps StateManagerError as { isError: true, text: "Erreur: ... (code)" }
            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toContain('EXPORT_TOO_LARGE');
            expect(text).toContain('6 conversations > 5 max');
            // generateProjectXml must NOT be called when guard fires
            expect(mockXmlExporterService.generateProjectXml).not.toHaveBeenCalled();
        });

        test('should reject when XML byte size exceeds cap', async () => {
            // 1KB cap; mock XML is '<project>mock xml</project>' (~22 bytes) — bump mock to exceed
            vi.stubEnv('EXPORT_MAX_PROJECT_CONVERSATIONS', '50000');
            vi.stubEnv('EXPORT_MAX_PROJECT_BYTES', String(1024));

            // 2KB string > 1KB cap
            const oversizedXml = '<project>' + 'x'.repeat(2048) + '</project>';
            mockXmlExporterService.generateProjectXml.mockReturnValue(oversizedXml);

            const args: ExportDataArgs = {
                target: 'project',
                format: 'xml',
                projectPath: '/test/workspace'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBe(true);
            const text = getTextContent(result);
            expect(text).toContain('EXPORT_TOO_LARGE');
            expect(text).toContain('size cap exceeded');
            // saveXmlToFile must NOT be called when guard fires
            expect(mockXmlExporterService.saveXmlToFile).not.toHaveBeenCalled();
        });

        test('should accept export at exactly the cap (boundary > not >=)', async () => {
            // Cap = cache size — must NOT throw (boundary is > not >=)
            vi.stubEnv('EXPORT_MAX_PROJECT_CONVERSATIONS', '3');
            vi.stubEnv('EXPORT_MAX_PROJECT_BYTES', String(100 * 1024 * 1024));

            // mockCache has exactly 3 entries from beforeEach (all /test/workspace)
            const args: ExportDataArgs = {
                target: 'project',
                format: 'xml',
                projectPath: '/test/workspace'
            };

            const result = await handleExportData(
                args,
                mockCache,
                mockXmlExporterService as any,
                mockEnsureCache,
                mockGetSkeleton
            );

            expect(result.isError).toBeFalsy();
            expect(mockXmlExporterService.generateProjectXml).toHaveBeenCalledTimes(1);
        });

        afterEach(() => {
            vi.unstubAllEnvs();
        });
    });

    // ============================================================
    // Tests de la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        test('should have correct name', () => {
            expect(exportDataTool.name).toBe('export_data');
        });

        test('should have target and format as required parameters', () => {
            expect(exportDataTool.inputSchema.required).toContain('target');
            expect(exportDataTool.inputSchema.required).toContain('format');
        });

        test('should have correct target enum values', () => {
            const props = exportDataTool.inputSchema.properties as any;
            expect(props.target.enum).toEqual(['task', 'conversation', 'project']);
        });

        test('should have correct format enum values', () => {
            const props = exportDataTool.inputSchema.properties as any;
            expect(props.format.enum).toEqual(['xml', 'json', 'csv', 'markdown', 'debug']);
        });

        test('should include all expected parameters', () => {
            const props = exportDataTool.inputSchema.properties as any;
            expect(props.taskId).toBeDefined();
            expect(props.conversationId).toBeDefined();
            expect(props.projectPath).toBeDefined();
            expect(props.filePath).toBeDefined();
            expect(props.jsonVariant).toBeDefined();
            expect(props.csvVariant).toBeDefined();
            // CONS-14 Cluster H: new params for markdown/debug formats
            expect(props.outputFormat).toBeDefined();
            expect(props.includeSiblings).toBeDefined();
            expect(props.currentTaskId).toBeDefined();
            expect(props.truncateInstruction).toBeDefined();
            expect(props.showMetadata).toBeDefined();
        });
    });
});
