import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import mock from 'mock-fs';
import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';
import path from 'path';

describe('Timestamp Parsing in RooStorageDetector', () => {
    const MOCK_TASKS_PATH = '/mock/tasks';

    afterEach(() => {
        mock.restore();
    });

    it('should parse lastActivity from a single-line JSON file', async () => {
        const taskPath = path.join(MOCK_TASKS_PATH, 'task-single-json');
        const history = [
            { role: 'user', content: 'Hello', timestamp: '2025-01-01T10:00:00Z' },
            { role: 'assistant', content: 'Hi', timestamp: '2025-01-01T10:01:00Z' },
        ];
        mock({
            [path.join(taskPath, 'api_conversation_history.json')]: JSON.stringify(history),
            [path.join(taskPath, 'task_metadata.json')]: JSON.stringify({ taskId: 'task-single-json' }),
        });

        const skeleton = await RooStorageDetector.analyzeConversation('task-single-json', taskPath);
        expect(skeleton?.metadata.lastActivity).toBe('2025-01-01T10:01:00Z');
    });

    it('should parse lastActivity from a JSONL file', async () => {
        const taskPath = path.join(MOCK_TASKS_PATH, 'task-jsonl');
        const history = [
            JSON.stringify({ role: 'user', content: 'Hello', timestamp: '2025-02-01T11:00:00Z' }),
            JSON.stringify({ role: 'assistant', content: 'Hi', timestamp: '2025-02-01T11:05:00Z' }),
        ].join('\n');
        mock({
            [path.join(taskPath, 'api_conversation_history.json')]: history,
            [path.join(taskPath, 'task_metadata.json')]: JSON.stringify({ taskId: 'task-jsonl' }),
        });

        const skeleton = await RooStorageDetector.analyzeConversation('task-jsonl', taskPath);
        expect(skeleton?.metadata.lastActivity).toBe('2025-02-01T11:05:00Z');
    });

    it('should handle files with mixed valid and invalid JSON objects', async () => {
        const taskPath = path.join(MOCK_TASKS_PATH, 'task-mixed');
        const history = [
            JSON.stringify({ role: 'user', content: 'First', timestamp: '2025-03-01T12:00:00Z' }),
            'this is not a json line',
            JSON.stringify({ role: 'assistant', content: 'Last', timestamp: '2025-03-01T12:10:00Z' }),
        ].join('\n');
        mock({
            [path.join(taskPath, 'api_conversation_history.json')]: history,
            [path.join(taskPath, 'task_metadata.json')]: JSON.stringify({ taskId: 'task-mixed' }),
        });

        const skeleton = await RooStorageDetector.analyzeConversation('task-mixed', taskPath);
        expect(skeleton?.metadata.lastActivity).toBe('2025-03-01T12:10:00Z');
    });

    it('should return metadata createdAt if no timestamp is found in history', async () => {
        const taskPath = path.join(MOCK_TASKS_PATH, 'task-no-timestamp');
        mock({
            [path.join(taskPath, 'api_conversation_history.json')]: JSON.stringify([{ role: 'user', content: 'No timestamp' }]),
            [path.join(taskPath, 'task_metadata.json')]: JSON.stringify({ taskId: 'task-no-timestamp', createdAt: '2025-04-01T13:00:00Z' }),
        });

        const skeleton = await RooStorageDetector.analyzeConversation('task-no-timestamp', taskPath);
        expect(skeleton?.metadata.lastActivity).toBe('2025-04-01T13:00:00Z');
    });
});