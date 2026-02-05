/**
 * Tests TDD pour ClaudeStorageDetector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ClaudeStorageDetector } from '../claude-storage-detector.js';
import { ClaudeJsonlEntry } from '../../types/claude-storage.js';

describe('ClaudeStorageDetector - TDD Suite', () => {
    let testTempDir: string;
    let claudeProjectsDir: string;
    let testProjectDir: string;

    beforeEach(async () => {
        testTempDir = path.join(os.tmpdir(), `claude-storage-test-${Date.now()}`);
        claudeProjectsDir = path.join(testTempDir, '.claude', 'projects');
        testProjectDir = path.join(claudeProjectsDir, 'c--test-project');
        await fs.mkdir(testProjectDir, { recursive: true });
    });

    afterEach(async () => {
        try {
            await fs.rm(testTempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('Détection des emplacements', () => {
        it('DEVRAIT lister les projets Claude disponibles', async () => {
            await fs.mkdir(path.join(claudeProjectsDir, 'c--project-1'), { recursive: true });
            await fs.mkdir(path.join(claudeProjectsDir, 'c--project-2'), { recursive: true });

            const projects = await ClaudeStorageDetector.listProjects(claudeProjectsDir);

            expect(projects).toBeDefined();
            expect(projects.length).toBeGreaterThanOrEqual(3);
            expect(projects).toContain('c--test-project');
            expect(projects).toContain('c--project-1');
            expect(projects).toContain('c--project-2');
        });

        it('DEVRAIT valider un chemin de stockage Claude existant', async () => {
            const isValid = await ClaudeStorageDetector.validateCustomPath(claudeProjectsDir);
            expect(isValid).toBe(true);
        });

        it('DEVRAIT rejeter un chemin de stockage invalide', async () => {
            const invalidPath = path.join(testTempDir, 'nonexistent', 'projects');
            const isValid = await ClaudeStorageDetector.validateCustomPath(invalidPath);
            expect(isValid).toBe(false);
        });
    });

    describe('Parsing JSONL', () => {
        it('DEVRAIT parser une ligne JSONL user valide', async () => {
            const entry: ClaudeJsonlEntry = {
                type: 'user',
                message: { role: 'user', content: 'Test message' },
                timestamp: new Date().toISOString(),
                uuid: 'test-uuid-1'
            };

            const parsed = await ClaudeStorageDetector.parseJsonlLine(JSON.stringify(entry));

            expect(parsed).toBeDefined();
            expect(parsed).not.toBeNull();
            expect(parsed?.type).toBe('user');
            expect(parsed?.message?.role).toBe('user');
        });

        it('DEVRAIT parser une ligne JSONL assistant valide', async () => {
            const entry: ClaudeJsonlEntry = {
                type: 'assistant',
                message: { role: 'assistant', content: 'Response message' },
                timestamp: new Date().toISOString(),
                uuid: 'test-uuid-2'
            };

            const parsed = await ClaudeStorageDetector.parseJsonlLine(JSON.stringify(entry));

            expect(parsed).toBeDefined();
            expect(parsed).not.toBeNull();
            expect(parsed?.type).toBe('assistant');
        });

        it('DEVRAIT parser une ligne JSONL avec tool_use', async () => {
            const entry: ClaudeJsonlEntry = {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        toolUse: {
                            name: 'read_file',
                            id: 'tool-1',
                            input: { filePath: '/test/path' }
                        }
                    }]
                },
                timestamp: new Date().toISOString(),
                uuid: 'test-uuid-3'
            };

            const parsed = await ClaudeStorageDetector.parseJsonlLine(JSON.stringify(entry));

            expect(parsed).toBeDefined();
            expect(parsed).not.toBeNull();
            expect(parsed?.message?.content).toBeDefined();
            expect(Array.isArray(parsed?.message?.content)).toBe(true);
        });

        it('DEVRAIT gérer les lignes JSONL invalides', async () => {
            const parsed = await ClaudeStorageDetector.parseJsonlLine('{invalid json');
            expect(parsed).toBeNull();
        });
    });

    describe('Transformation vers ConversationSkeleton', () => {
        it('DEVRAIT transformer un fichier JSONL en ConversationSkeleton', async () => {
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: 'Initial request' }, timestamp: '2024-01-01T10:00:00.000Z', uuid: 'uuid-1' }),
                JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Response' }, timestamp: '2024-01-01T10:01:00.000Z', uuid: 'uuid-2' }),
            ].join('\n');

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-task-id', testProjectDir);

            expect(skeleton).toBeDefined();
            expect(skeleton?.taskId).toBe('test-task-id');
            expect(skeleton?.metadata.messageCount).toBe(2);
        });

        it('DEVRAIT calculer les statistiques correctement', async () => {
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: 'Msg 1' }, timestamp: new Date().toISOString(), uuid: '1' }),
                JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Resp 1' }, timestamp: new Date().toISOString(), uuid: '2' }),
                JSON.stringify({ type: 'command_result', command: { command: 'ls', exitCode: 0, output: '' }, timestamp: new Date().toISOString(), uuid: '3' }),
            ].join('\n');

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-task-id', testProjectDir);

            expect(skeleton?.metadata.messageCount).toBe(2);
            expect(skeleton?.metadata.actionCount).toBe(1);
        });

        it('DEVRAIT extraire le workspace depuis les métadonnées', async () => {
            const jsonlContent = JSON.stringify({
                type: 'read_result',
                readResult: {
                    filePath: 'c:\\dev\\my-project\\src\\index.ts',
                    content: 'test content',
                    lineCount: 10
                },
                timestamp: new Date().toISOString(),
                uuid: '1',
                metadata: {
                    files: ['c:\\dev\\my-project\\src\\index.ts']
                }
            });

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);

            expect(skeleton?.metadata.workspace).toBeDefined();
            expect(skeleton?.metadata.workspace).toContain('my-project');
        });
    });

    describe('Gestion des erreurs', () => {
        it('DEVRAIT retourner null pour un répertoire inexistant', async () => {
            const skeleton = await ClaudeStorageDetector.analyzeConversation(
                'test-id',
                path.join(testTempDir, 'nonexistent')
            );
            expect(skeleton).toBeNull();
        });

        it('DEVRAIT gérer les fichiers JSONL vides', async () => {
            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, '');

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            expect(skeleton).toBeDefined();
            expect(skeleton?.metadata.messageCount).toBe(0);
        });

        it('DEVRAIT gérer les fichiers JSONL corrompus', async () => {
            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, '{invalid json\nmore invalid');

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            expect(skeleton).toBeDefined();
        });
    });

    describe('Intégration', () => {
        it('DEVRAIT être compatible avec linterface ConversationSkeleton', async () => {
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: 'Test' }, timestamp: new Date().toISOString(), uuid: '1' }),
                JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Response' }, timestamp: new Date().toISOString(), uuid: '2' }),
            ].join('\n');

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);

            expect(skeleton).toMatchObject({
                taskId: expect.any(String),
                metadata: expect.objectContaining({
                    messageCount: expect.any(Number),
                    actionCount: expect.any(Number),
                    totalSize: expect.any(Number),
                    createdAt: expect.any(String),
                    lastActivity: expect.any(String)
                }),
                sequence: expect.any(Array)
            });
        });
    });
});
