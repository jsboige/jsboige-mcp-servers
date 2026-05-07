/**
 * Outil MCP : debug_task_parsing
 * Analyse en détail le parsing d'une tâche spécifique pour diagnostiquer les problèmes hiérarchiques
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';

export interface DebugTaskParsingArgs {
    task_id: string;
    /** Output format: "json" returns structured data, "markdown" returns formatted text (default) */
    format?: 'json' | 'markdown';
}

/**
 * Définition de l'outil debug_task_parsing
 */
export const debugTaskParsingTool = {
    name: 'debug_task_parsing',
    description: 'Analyse en détail le parsing d\'une tâche spécifique pour diagnostiquer les problèmes hiérarchiques.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'ID de la tâche à analyser en détail.'
            },
            format: {
                type: 'string',
                enum: ['json', 'markdown'],
                description: 'Format de sortie: "json" pour données structurées, "markdown" pour texte formaté (défaut)'
            }
        },
        required: ['task_id']
    }
};

/**
 * Handler pour debug_task_parsing
 * Analyse le parsing d'une tâche et retourne des informations de diagnostic
 */
export async function handleDebugTaskParsing(
    args: DebugTaskParsingArgs
): Promise<CallToolResult> {
    const { task_id, format } = args;

    // Security: Reject path traversal attempts (check before format to prevent bypass)
    if (task_id.includes('..') || task_id.includes('/') || task_id.includes('\\')) {
        throw new GenericError(
            `Invalid task_id: path separators and parent directory references are not allowed.`,
            GenericErrorCode.INVALID_ARGUMENT
        );
    }

    // Security: Validate task_id format — must be UUID
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(task_id)) {
        throw new GenericError(
            `Invalid task_id format: '${task_id.slice(0, 20)}...'. Expected UUID.`,
            GenericErrorCode.INVALID_ARGUMENT
        );
    }

    console.log(`DEBUG: Starting detailed analysis of task ${task_id}`);

    try {
        const locations = await RooStorageDetector.detectStorageLocations();
        let taskPath = null;

        for (const baseDir of locations) {
            const tasksDir = path.join(baseDir, 'tasks');
            const potentialPath = path.join(tasksDir, task_id);
            if (existsSync(potentialPath)) {
                taskPath = potentialPath;
                break;
            }
        }

        if (!taskPath) {
            const notFound = format === 'json'
                ? JSON.stringify({ error: 'not_found', task_id }, null, 2)
                : `Task ${task_id} not found in any storage location`;
            return { content: [{ type: 'text', text: notFound }] };
        }

        // Collect structured data
        const result: Record<string, any> = { task_id, task_path: taskPath };

        const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
        const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');

        result.ui_messages_exists = existsSync(uiMessagesPath);
        result.api_history_exists = existsSync(apiHistoryPath);

        if (existsSync(uiMessagesPath)) {
            let content = await fs.readFile(uiMessagesPath, 'utf-8');
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }

            const messages = JSON.parse(content);
            result.ui_messages_count = messages.length;

            let taskTagCount = 0;
            let newTaskTagCount = 0;
            const tagDetails: Record<number, { role: string; task_tags: number; new_task_tags: number; preview?: string }> = {};

            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                let contentText = '';

                if (typeof message.content === 'string') {
                    contentText = message.content;
                } else if (Array.isArray(message.content)) {
                    for (const item of message.content) {
                        if (item.type === 'text' && typeof item.text === 'string') {
                            contentText += item.text + '\n';
                        }
                    }
                }

                const taskMatches = contentText.match(/<task>/g);
                const newTaskMatches = contentText.match(/<new_task>/g);

                if (taskMatches) {
                    taskTagCount += taskMatches.length;
                    const detail: any = { role: message.role, task_tags: taskMatches.length };

                    const taskPattern = /<task>([\s\S]*?)<\/task>/gi;
                    const match = taskPattern.exec(contentText);
                    if (match) {
                        detail.preview = match[1].trim().substring(0, 100);
                    }
                    tagDetails[i] = detail;
                }

                if (newTaskMatches) {
                    newTaskTagCount += newTaskMatches.length;
                    if (!tagDetails[i]) {
                        tagDetails[i] = { role: message.role, task_tags: 0, new_task_tags: newTaskMatches.length };
                    } else {
                        tagDetails[i].new_task_tags = newTaskMatches.length;
                    }
                }
            }

            result.task_tag_count = taskTagCount;
            result.new_task_tag_count = newTaskTagCount;
            result.tag_details = tagDetails;
        }

        // Test parsing with RooStorageDetector
        const skeleton = await RooStorageDetector.analyzeConversation(task_id, taskPath);

        if (skeleton) {
            result.skeleton = {
                task_id: skeleton.taskId,
                parent_task_id: skeleton.parentTaskId || null,
                truncated_instruction: skeleton.truncatedInstruction
                    ? skeleton.truncatedInstruction.substring(0, 100)
                    : null,
                child_task_instruction_prefixes_count: skeleton.childTaskInstructionPrefixes?.length || 0,
                child_task_instruction_prefixes_preview: skeleton.childTaskInstructionPrefixes?.slice(0, 3).map(p => p.substring(0, 80)) || []
            };
        } else {
            result.skeleton = null;
        }

        if (format === 'json') {
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // Markdown format (default, backward-compatible)
        const lines: string[] = [];
        lines.push(`Task path: ${result.task_path}`);
        lines.push(`UI Messages: ${result.ui_messages_exists ? 'EXISTS' : 'MISSING'}`);
        lines.push(`API History: ${result.api_history_exists ? 'EXISTS' : 'MISSING'}`);

        if (result.ui_messages_count !== undefined) {
            lines.push(`UI Messages count: ${result.ui_messages_count}`);
            lines.push(`Total <task> tags: ${result.task_tag_count}`);
            lines.push(`Total <new_task> tags: ${result.new_task_tag_count}`);

            for (const [idx, detail] of Object.entries(result.tag_details || {})) {
                const d = detail as any;
                if (d.task_tags > 0) {
                    lines.push(`  Message ${idx} (${d.role}): ${d.task_tags} <task> tags`);
                    if (d.preview) lines.push(`    Preview: "${d.preview}..."`);
                }
                if (d.new_task_tags > 0) {
                    lines.push(`  Message ${idx} (${d.role}): ${d.new_task_tags} <new_task> tags`);
                }
            }
        }

        if (result.skeleton) {
            lines.push(`Skeleton analysis:`);
            lines.push(`  TaskId: ${result.skeleton.task_id}`);
            lines.push(`  ParentTaskId: ${result.skeleton.parent_task_id || 'NONE'}`);
            lines.push(`  Instruction: ${result.skeleton.truncated_instruction ? `"${result.skeleton.truncated_instruction}..."` : 'NONE'}`);
            lines.push(`  Child prefixes: ${result.skeleton.child_task_instruction_prefixes_count}`);
            for (const p of result.skeleton.child_task_instruction_prefixes_preview) {
                lines.push(`    "${p}..."`);
            }
        } else {
            lines.push(`Skeleton analysis: FAILED (null)`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };

    } catch (error: any) {
        if (format === 'json') {
            return { content: [{ type: 'text', text: JSON.stringify({ error: error?.message || 'Unknown error', task_id }, null, 2) }] };
        }
        return { content: [{ type: 'text', text: `ERROR: ${error?.message || 'Unknown error'}` }] };
    }
}
