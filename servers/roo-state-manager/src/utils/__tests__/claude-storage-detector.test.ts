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

        it('DEVRAIT détecter les projets avec toute lettre de disque (pas juste c--)', async () => {
            await fs.mkdir(path.join(claudeProjectsDir, 'd--roo-extensions'), { recursive: true });
            await fs.mkdir(path.join(claudeProjectsDir, 'D--roo-extensions--worktree'), { recursive: true });
            await fs.mkdir(path.join(claudeProjectsDir, 'g--Mon-Drive-Project'), { recursive: true });

            const projects = await ClaudeStorageDetector.listProjects(claudeProjectsDir);

            expect(projects).toContain('d--roo-extensions');
            expect(projects).toContain('D--roo-extensions--worktree');
            expect(projects).toContain('g--Mon-Drive-Project');
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

    describe('maxContentLength option (#798)', () => {
        it('DEVRAIT tronquer le contenu avec maxContentLength par défaut (400)', async () => {
            const longContent = 'A'.repeat(800); // 800 chars, will be truncated at 400
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: longContent }, timestamp: '2024-01-01T10:00:00.000Z', uuid: '1' }),
            ].join('\n');

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);

            expect(skeleton).toBeDefined();
            const msg = skeleton!.sequence[0] as any;
            expect(msg.role).toBe('user');
            expect(msg.isTruncated).toBe(true);
            expect(msg.content.length).toBeLessThan(800);
            expect(msg.content).toContain('...');
        });

        it('DEVRAIT préserver le contenu complet avec maxContentLength élevé', async () => {
            const longContent = 'B'.repeat(800); // 800 chars, within 2000 limit
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: longContent }, timestamp: '2024-01-01T10:00:00.000Z', uuid: '1' }),
            ].join('\n');

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir, {
                maxContentLength: 2000,
            });

            expect(skeleton).toBeDefined();
            const msg = skeleton!.sequence[0] as any;
            expect(msg.role).toBe('user');
            expect(msg.isTruncated).toBe(false);
            expect(msg.content).toBe(longContent);
            expect(msg.content.length).toBe(800);
        });

        it('DEVRAIT tronquer à la limite choisie pour les très longs messages', async () => {
            const veryLongContent = 'C'.repeat(5000); // 5000 chars
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: veryLongContent }, timestamp: '2024-01-01T10:00:00.000Z', uuid: '1' }),
            ].join('\n');

            const testJsonlPath = path.join(testProjectDir, 'conversation.jsonl');
            await fs.writeFile(testJsonlPath, jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir, {
                maxContentLength: 2000,
            });

            expect(skeleton).toBeDefined();
            const msg = skeleton!.sequence[0] as any;
            expect(msg.isTruncated).toBe(true);
            // Content should be ~2003 chars (1000 front + '...' + 1000 back)
            expect(msg.content.length).toBeLessThanOrEqual(2010);
            expect(msg.content.length).toBeGreaterThan(1500);
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

    // ============================================================
    // NEW coverage (deep-queue COVERAGE Cluster D): branches & edge
    // cases genuinely non-covered. Anchored on real source contract
    // (claude-storage-detector.ts): parseJsonlLine L145-163,
    // buildSequenceFromEntries L303-383, detectWorkspace L475-522,
    // findConversationById L552-584, analyzeConversation L191-194.
    // ============================================================
    describe('NEW coverage — branches & edge cases', () => {
        // --- parseJsonlLine: empty / missing-field branches (L145-163) ---
        it('DEVRAIT retourner null pour une ligne vide ou whitespace', async () => {
            expect(await ClaudeStorageDetector.parseJsonlLine('')).toBeNull();
            expect(await ClaudeStorageDetector.parseJsonlLine('   ')).toBeNull();
            expect(await ClaudeStorageDetector.parseJsonlLine('\t\n')).toBeNull();
        });

        it('DEVRAIT retourner null pour un JSON valide sans champ type', async () => {
            const noType = JSON.stringify({ timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } });
            expect(await ClaudeStorageDetector.parseJsonlLine(noType)).toBeNull();
        });

        it('DEVRAIT retourner null pour un JSON valide sans champ timestamp', async () => {
            const noTimestamp = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } });
            expect(await ClaudeStorageDetector.parseJsonlLine(noTimestamp)).toBeNull();
        });

        // --- buildSequenceFromEntries branches (L303-383) ---
        it('DEVRAIT marquer status=failure pour command_result avec exitCode != 0', async () => {
            const jsonlContent = JSON.stringify({
                type: 'command_result',
                command: { command: 'failing-cmd', exitCode: 1, output: 'error output' },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'cmd-fail',
            });
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            const cmdAction = skeleton!.sequence.find((s: any) => s.type === 'command') as any;
            expect(cmdAction).toBeDefined();
            expect(cmdAction.status).toBe('failure');
            expect(cmdAction.name).toBe('failing-cmd');
        });

        it('DEVRAIT extraire une action tool depuis un tool_use assistant (#253, L326-338)', async () => {
            const jsonlContent = JSON.stringify({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        toolUse: { name: 'write_file', id: 'tu-1', input: { filePath: '/x/y.ts' } },
                    }],
                },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'tu-uuid',
            });
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            // sequence = [assistant message, tool action]
            const toolActions = skeleton!.sequence.filter((s: any) => s.type === 'tool') as any[];
            expect(toolActions).toHaveLength(1);
            expect(toolActions[0].name).toBe('write_file');
            expect(toolActions[0].status).toBe('success');
        });

        it('DEVRAIT ignorer les tool_result quand includeToolResults=false (L367)', async () => {
            const entry = {
                type: 'tool_result',
                toolResult: { name: 'bash', result: 'some result' },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'tr-1',
            };
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), JSON.stringify(entry));

            const excluded = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir, { includeToolResults: false });
            expect(excluded!.sequence).toHaveLength(0);

            const included = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir, { includeToolResults: true });
            expect(included!.sequence.filter((s: any) => s.type === 'tool')).toHaveLength(1);
        });

        it('DEVRAIT mapper read_result vers une action read_file (L354-365)', async () => {
            const jsonlContent = JSON.stringify({
                type: 'read_result',
                readResult: { filePath: '/abs/src/index.ts', content: 'line1\nline2', lineCount: 2 },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'rr-1',
            });
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            const readAction = skeleton!.sequence.find((s: any) => s.name === 'read_file') as any;
            expect(readAction).toBeDefined();
            expect(readAction.file_path).toBe('/abs/src/index.ts');
            expect(readAction.line_count).toBe(2);
        });

        it('DEVRAIT trier la séquence par timestamp (L380-382)', async () => {
            const jsonlContent = [
                JSON.stringify({ type: 'user', message: { role: 'user', content: 'late' }, timestamp: '2024-01-01T10:05:00.000Z', uuid: 'late' }),
                JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'early' }, timestamp: '2024-01-01T10:00:00.000Z', uuid: 'early' }),
            ].join('\n');
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            const msgs = skeleton!.sequence.filter((s: any) => s.role) as any[];
            expect(msgs[0].content).toBe('early');   // earlier timestamp first
            expect(msgs[1].content).toBe('late');
        });

        // --- detectWorkspace branches (L475-522) ---
        it('DEVRAIT détecter le workspace depuis le champ cwd (priorité 1) avec normalisation backslash', async () => {
            const jsonlContent = JSON.stringify({
                type: 'user',
                message: { role: 'user', content: 'hi' },
                cwd: 'C:\\Users\\dev\\my-project',
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'cwd-1',
            });
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            expect(skeleton?.metadata.workspace).toBe('C:/Users/dev/my-project'); // \ → /
        });

        it('DEVRAIT fallback sur le nom de projet c-- quand aucun cwd/fichier (L516-519)', async () => {
            // testProjectDir = 'c--test-project', plain user msg with no cwd/files
            const jsonlContent = JSON.stringify({
                type: 'user',
                message: { role: 'user', content: 'plain message' },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'fb-1',
            });
            await fs.writeFile(path.join(testProjectDir, 'conversation.jsonl'), jsonlContent);

            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            // c--test-project → strip 'c--' → 'test-project' → '-' → '/' → 'test/project'
            expect(skeleton?.metadata.workspace).toBe('test/project');
        });

        // --- findConversationById: non-claude guard (L557-559) ---
        it('DEVRAIT retourner null pour un taskId ne commençant pas par claude-', async () => {
            const skeleton = await ClaudeStorageDetector.findConversationById('roo-abc123');
            expect(skeleton).toBeNull();
        });

        // --- analyzeConversation: dir without .jsonl → minimal skeleton (L191-194) ---
        it('DEVRAIT créer un squelette minimal pour un répertoire sans fichier .jsonl', async () => {
            // testProjectDir exists but has no .jsonl file (only whatever beforeEach left)
            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-id', testProjectDir);
            expect(skeleton).toBeDefined();
            expect(skeleton?.metadata.messageCount).toBe(0);
            expect(skeleton?.sequence).toEqual([]);
        });
    });

    // ============================================================
    // #2734 — per-session metadata (no project-level aggregation).
    // Before the fix, analyzeConversation ALWAYS aggregated every .jsonl
    // in the project dir (totalSize = sum L204, messageCount across all
    // files L430). Callers build per-session taskIds `claude-{project}--{uuid}`
    // since #937 (background-services loadClaudeCodeSessions → `list` cache,
    // findConversationById → `view`) but pass the project dir → every session
    // inherited the identical project-level cumulative → byte-identical inflated
    // metadata across distinct task_ids. The fix scopes analysis to the session
    // file named by the taskId suffix after the last `--`.
    // ============================================================
    describe('#2734 — per-session metadata (no project-level aggregation)', () => {
        // Note: testProjectDir basename is 'c--test-project' — it already contains
        // '--', which proves the suffix is resolved via lastIndexOf('--') (robust to
        // project names with '--' like the real 'd--dev-roo-extensions'), not a split.
        const sessA = 'aaaaaaaa-1111-2222-3333-444444444444';
        const sessB = 'bbbbbbbb-5555-6666-7777-888888888888';

        async function writeSession(uuid: string, messageCount: number, pad: number): Promise<void> {
            const lines: string[] = [];
            for (let i = 0; i < messageCount; i++) {
                const role = i % 2 === 0 ? 'user' : 'assistant';
                lines.push(JSON.stringify({
                    type: role,
                    message: { role, content: `${uuid} msg ${i} ${'x'.repeat(pad)}` },
                    timestamp: `2024-01-0${(i % 9) + 1}T10:0${i % 10}:00.000Z`,
                    uuid: `${uuid}-${i}`,
                }));
            }
            await fs.writeFile(path.join(testProjectDir, `${uuid}.jsonl`), lines.join('\n'));
        }

        it('DEVRAIT produire des metadata par-session distinctes (task_ids distincts → PAS d\'agrégat byte-identique)', async () => {
            await writeSession(sessA, 2, 10);    // 2 messages, small file
            await writeSession(sessB, 6, 200);   // 6 messages, much larger file

            const projectBasename = path.basename(testProjectDir); // 'c--test-project'
            const skA = await ClaudeStorageDetector.analyzeConversation(`claude-${projectBasename}--${sessA}`, testProjectDir);
            const skB = await ClaudeStorageDetector.analyzeConversation(`claude-${projectBasename}--${sessB}`, testProjectDir);

            const sizeA = (await fs.stat(path.join(testProjectDir, `${sessA}.jsonl`))).size;
            const sizeB = (await fs.stat(path.join(testProjectDir, `${sessB}.jsonl`))).size;

            // messageCount is per-session, NOT the 8-message project total
            expect(skA?.metadata.messageCount).toBe(2);
            expect(skB?.metadata.messageCount).toBe(6);

            // totalSize is the individual file's real bytes, NOT the sum
            expect(skA?.metadata.totalSize).toBe(sizeA);
            expect(skB?.metadata.totalSize).toBe(sizeB);

            // The smoking gun this bug produced: distinct task_ids MUST NOT share
            // byte-identical metadata.
            expect(skA?.metadata.totalSize).not.toBe(skB?.metadata.totalSize);
            expect(skA?.metadata.messageCount).not.toBe(skB?.metadata.messageCount);

            // And neither equals the project aggregate (sizeA + sizeB) that the bug
            // previously mis-attributed to every session.
            expect(skA?.metadata.totalSize).not.toBe(sizeA + sizeB);
            expect(skB?.metadata.totalSize).not.toBe(sizeA + sizeB);
        });

        it('DEVRAIT conserver l\'agrégat projet pour un taskId per-project (rétro-compat)', async () => {
            await writeSession(sessA, 2, 10);
            await writeSession(sessB, 6, 200);

            const projectBasename = path.basename(testProjectDir);
            const sizeA = (await fs.stat(path.join(testProjectDir, `${sessA}.jsonl`))).size;
            const sizeB = (await fs.stat(path.join(testProjectDir, `${sessB}.jsonl`))).size;

            // per-project taskId: suffix after last '--' ('test-project') matches no
            // .jsonl → falls through to the existing project-aggregate behavior.
            const skProj = await ClaudeStorageDetector.analyzeConversation(`claude-${projectBasename}`, testProjectDir);
            expect(skProj?.metadata.messageCount).toBe(8);              // 2 + 6
            expect(skProj?.metadata.totalSize).toBe(sizeA + sizeB);     // sum of both files
        });

        it('DEVRAIT fallback sur l\'agrégat si le suffixe de session ne correspond à aucun fichier', async () => {
            await writeSession(sessA, 2, 10);
            await writeSession(sessB, 6, 200);

            const projectBasename = path.basename(testProjectDir);
            const skUnknown = await ClaudeStorageDetector.analyzeConversation(
                `claude-${projectBasename}--deadbeef-0000-0000-0000-000000000000`,
                testProjectDir,
            );
            // No matching file → safe fallback to aggregate (never throws / never null).
            expect(skUnknown?.metadata.messageCount).toBe(8);
        });
    });
});
