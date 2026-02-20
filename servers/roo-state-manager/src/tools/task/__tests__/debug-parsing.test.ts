/**
 * Tests unitaires pour debug-parsing.tool.ts
 *
 * Coverage cible: >80%
 * Tests pour:
 * - handleDebugTaskParsing: analyse détaillée du parsing d'une tâche
 * - Détection des balises <task> et <new_task>
 * - Diagnostic des problèmes hiérarchiques
 *
 * @module task/debug-parsing.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Helper to extract text content from result
function getTextContent(result: CallToolResult): string {
    if (result.content[0] && result.content[0].type === 'text') {
        return result.content[0].text;
    }
    return '';
}

// Define mock functions at top level so they persist across clearAllMocks
const mockDetectStorageLocations = vi.fn();
const mockAnalyzeConversation = vi.fn();

vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: mockDetectStorageLocations,
        analyzeConversation: mockAnalyzeConversation
    }
}));

// Mock fs module with promises namespace (for import { promises as fs } from 'fs')
const mockReadFile = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
    promises: {
        readFile: mockReadFile
    },
    existsSync: mockExistsSync
}));

describe('debug-parsing.tool', () => {
    let handleDebugTaskParsing: typeof import('../debug-parsing.tool.js').handleDebugTaskParsing;
    let debugTaskParsingTool: typeof import('../debug-parsing.tool.js').debugTaskParsingTool;

    beforeEach(async () => {
        vi.clearAllMocks();

        // Setup existsSync mock behavior - return true for valid-task directories
        mockExistsSync.mockImplementation((path: string) => {
            if (typeof path === 'string') {
                // Return true for valid-task directories
                if (path.includes('valid-task') && !path.includes('nonexistent')) {
                    return true;
                }
            }
            return false;
        });

        // Default mock setup
        mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);
        mockAnalyzeConversation.mockResolvedValue({
            taskId: 'valid-task-123',
            parentTaskId: 'parent-task-456',
            truncatedInstruction: 'This is a truncated instruction preview...',
            childTaskInstructionPrefixes: ['prefix1', 'prefix2', 'prefix3']
        });
        mockReadFile.mockResolvedValue(JSON.stringify([
            { role: 'user', content: 'Test message' }
        ]));

        // Dynamic import after mocks are set up
        const mod = await import('../debug-parsing.tool.js');
        handleDebugTaskParsing = mod.handleDebugTaskParsing;
        debugTaskParsingTool = mod.debugTaskParsingTool;
    });

    // ============================================================
    // Tests pour la définition de l'outil
    // ============================================================

    describe('Tool definition', () => {
        test('should have correct name', () => {
            expect(debugTaskParsingTool.name).toBe('debug_task_parsing');
        });

        test('should have description', () => {
            expect(debugTaskParsingTool.description).toBeTruthy();
        });

        test('should require task_id parameter', () => {
            expect(debugTaskParsingTool.inputSchema.required).toContain('task_id');
        });

        test('should have task_id as string type', () => {
            const taskIdProp = debugTaskParsingTool.inputSchema.properties.task_id as any;
            expect(taskIdProp.type).toBe('string');
        });
    });

    // ============================================================
    // Tests pour handleDebugTaskParsing
    // ============================================================

    describe('handleDebugTaskParsing', () => {
        describe('task not found scenarios', () => {
            test('should return error when no storage locations', async () => {
                mockDetectStorageLocations.mockResolvedValue([]);

                const args = { task_id: 'nonexistent-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('not found');
            });

            test('should return error when task not in any storage location', async () => {
                mockDetectStorageLocations.mockResolvedValue(['/mock/storage']);

                const args = { task_id: 'nonexistent-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('not found');
            });
        });

        describe('task found scenarios', () => {
            test('should return task path in debug info', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Task path');
            });

            test('should check for ui_messages.json existence', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('UI Messages');
            });

            test('should check for api_conversation_history.json existence', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('API History');
            });

            test('should report message count from ui_messages.json', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Hi there' },
                    { role: 'user', content: 'How are you?' }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('UI Messages count');
                expect(getTextContent(result)).toContain('3');
            });

            test('should detect <task> tags in messages', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    { role: 'user', content: 'Some text <task>do something</task> more text' }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('<task>');
                expect(getTextContent(result)).toContain('Found 1');
            });

            test('should detect multiple <task> tags', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    { role: 'user', content: '<task>task 1</task> and <task>task 2</task>' }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Total <task> tags found: 2');
            });

            test('should detect <new_task> tags', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    { role: 'assistant', content: 'Delegating: <new_task>subtask</new_task>' }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('<new_task>');
                expect(getTextContent(result)).toContain('Total <new_task> tags');
            });

            test('should extract task content preview', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    { role: 'user', content: '<task>This is the task content to extract</task>' }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Content preview');
                expect(getTextContent(result)).toContain('This is the task content');
            });

            test('should handle content as array', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: '<task>Array content task</task>' }
                        ]
                    }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Array content task');
            });

            test('should handle BOM in JSON file', async () => {
                const bomJson = '\uFEFF' + JSON.stringify([
                    { role: 'user', content: 'Test message' }
                ]);
                mockReadFile.mockResolvedValue(bomJson);

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                // Should parse successfully despite BOM
                expect(getTextContent(result)).toContain('UI Messages count');
            });

            test('should call RooStorageDetector.analyzeConversation', async () => {
                const args = { task_id: 'valid-task' };
                await handleDebugTaskParsing(args);

                expect(mockAnalyzeConversation).toHaveBeenCalled();
            });

            test('should include skeleton analysis results', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Analysis complete');
                expect(getTextContent(result)).toContain('TaskId');
                expect(getTextContent(result)).toContain('valid-task-123');
                expect(getTextContent(result)).toContain('ParentTaskId');
                expect(getTextContent(result)).toContain('parent-task-456');
            });

            test('should include truncated instruction preview', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('TruncatedInstruction');
                expect(getTextContent(result)).toContain('truncated instruction preview');
            });

            test('should include childTaskInstructionPrefixes count', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('ChildTaskInstructionPrefixes');
                expect(getTextContent(result)).toContain('3 prefixes');
            });

            test('should show prefixes preview when available', async () => {
                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Prefixes preview');
            });

            test('should handle null analysis result', async () => {
                mockAnalyzeConversation.mockResolvedValue(null);

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('Analysis returned null');
            });

            test('should handle analysis without parent task', async () => {
                mockAnalyzeConversation.mockResolvedValue({
                    taskId: 'orphan-task',
                    parentTaskId: undefined,
                    truncatedInstruction: undefined,
                    childTaskInstructionPrefixes: []
                });

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('ParentTaskId');
                expect(getTextContent(result)).toContain('NONE');
            });

            test('should handle analysis without child prefixes', async () => {
                mockAnalyzeConversation.mockResolvedValue({
                    taskId: 'no-children-task',
                    parentTaskId: 'parent',
                    truncatedInstruction: 'instruction',
                    childTaskInstructionPrefixes: undefined
                });

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('0 prefixes');
            });
        });

        describe('error handling', () => {
            test('should handle JSON parse error', async () => {
                mockReadFile.mockResolvedValue('invalid json {{{');

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                // Should not crash, error should be in output
                expect(result.content).toBeDefined();
            });

            test('should handle file read error', async () => {
                mockReadFile.mockRejectedValue(new Error('Permission denied'));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                // Should handle error gracefully
                expect(result.content).toBeDefined();
            });

            test('should handle analyzeConversation error', async () => {
                mockReadFile.mockResolvedValue('[]');
                mockAnalyzeConversation.mockRejectedValue(new Error('Analysis failed'));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('ERROR');
                expect(getTextContent(result)).toContain('Analysis failed');
            });
        });

        describe('edge cases', () => {
            test('should handle empty messages array', async () => {
                mockReadFile.mockResolvedValue('[]');

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('UI Messages count: 0');
            });

            test('should handle messages without content', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    { role: 'user' }, // no content
                    { role: 'assistant', content: '' } // empty content
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(getTextContent(result)).toContain('UI Messages count: 2');
            });

            test('should handle content array without text items', async () => {
                mockReadFile.mockResolvedValue(JSON.stringify([
                    {
                        role: 'user',
                        content: [
                            { type: 'image', data: 'base64...' } // no text item
                        ]
                    }
                ]));

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                // Should handle gracefully without finding tags
                expect(result.content).toBeDefined();
            });

            test('should search in multiple storage locations', async () => {
                mockDetectStorageLocations.mockResolvedValue([
                    '/storage1',
                    '/storage2'
                ]);

                const args = { task_id: 'valid-task' };
                const result = await handleDebugTaskParsing(args);

                expect(result.content).toBeDefined();
            });
        });
    });
});
