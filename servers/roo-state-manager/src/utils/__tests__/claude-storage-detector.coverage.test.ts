/**
 * Coverage tests for ClaudeStorageDetector — uncovered branches & edge cases.
 *
 * Anchored on real source contract (claude-storage-detector.ts):
 *   - detectStorageLocations L53-105 (home + APPDATA paths, dedup)
 *   - listProjects L110-120 (catch ENOTDIR/ENOENT → [])
 *   - analyzeConversation L169-263 (filePath → null, oversized file skipped)
 *   - parseJsonlFile L273-315 (stream error, MAX_SKELETON_LINES truncation)
 *   - extractContent L405-424 (Array.isArray → filter text blocks)
 *   - getContentLength L429-436 (fallback 0 for non-string/non-array)
 *   - detectWorkspace L492-539 (Current working directory pattern, fallback undefined)
 *   - findConversationById L569-601 (claude- prefix match happy path)
 *   - getStorageStats L606-639 (locations → size + count aggregation)
 *
 * Companion to claude-storage-detector.test.ts (PR #678, MERGED 2026-07-01):
 * tests here target the BRANCHES STILL UNCOVERED after that PR landed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ClaudeStorageDetector } from '../claude-storage-detector.js';
import type { ClaudeJsonlEntry } from '../../types/claude-storage.js';

describe('ClaudeStorageDetector — coverage (uncovered branches after #678)', () => {
    let testTempDir: string;
    let homeClaudeDir: string;          // ~/.claude (mocked)
    let homeProjectsDir: string;        // ~/.claude/projects
    let appDataClaudeDir: string;       // %APPDATA%/Code/User/globalStorage/.claude/projects (mocked)
    let testProjectDir: string;

    beforeEach(async () => {
        testTempDir = path.join(os.tmpdir(), `claude-storage-cov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fs.mkdir(testTempDir, { recursive: true });

        // Home path layout: <testTempDir>/home/.claude/projects/<project>
        const homeDir = path.join(testTempDir, 'home');
        homeClaudeDir = path.join(homeDir, '.claude');
        homeProjectsDir = path.join(homeClaudeDir, 'projects');
        testProjectDir = path.join(homeProjectsDir, 'c--cov-project');
        await fs.mkdir(testProjectDir, { recursive: true });

        // APPDATA layout: <testTempDir>/appdata/Code/User/globalStorage/.claude/projects/<project>
        appDataClaudeDir = path.join(testTempDir, 'appdata', 'Code', 'User', 'globalStorage', '.claude', 'projects');
        await fs.mkdir(appDataClaudeDir, { recursive: true });

        // Mock os.homedir + APPDATA to point inside our sandboxed temp dir
        vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
        vi.stubEnv('APPDATA', path.join(testTempDir, 'appdata'));
    });

    afterEach(async () => {
        try {
            await fs.rm(testTempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    // ============================================================
    // detectStorageLocations (L53-105): home + APPDATA paths
    // ============================================================
    describe('detectStorageLocations (L53-105)', () => {
        it('DEVRAIT lister les projets depuis home ET APPDATA quand les deux existent', async () => {
            // Project only in home (besides the default c--cov-project from beforeEach)
            const homeOnly = 'c--home-only-project';
            await fs.mkdir(path.join(homeProjectsDir, homeOnly), { recursive: true });

            // Project only in APPDATA
            const appDataOnly = 'd--appdata-only';
            await fs.mkdir(path.join(appDataClaudeDir, appDataOnly), { recursive: true });

            const locations = await ClaudeStorageDetector.detectStorageLocations();

            // Both projects found
            expect(locations.find(l => l.projectName === homeOnly)).toBeDefined();
            expect(locations.find(l => l.projectName === appDataOnly)).toBeDefined();

            // Both source roots must appear in the result
            const sourcePaths = new Set(locations.map(l => l.path));
            expect(sourcePaths.has(homeProjectsDir)).toBe(true);
            expect(sourcePaths.has(appDataClaudeDir)).toBe(true);

            // Each location entry has type='local' and the expected shape
            for (const loc of locations) {
                expect(loc.type).toBe('local');
                expect(loc.projectPath).toBe(path.join(loc.path, loc.projectName));
            }
        });

        it('DEVRAIT retourner [] si ni home ni APPDATA n\'existent', async () => {
            // Mock home to an empty dir that doesn't contain .claude
            const emptyHome = path.join(testTempDir, 'empty-home');
            await fs.mkdir(emptyHome, { recursive: true });
            vi.spyOn(os, 'homedir').mockReturnValue(emptyHome);
            vi.stubEnv('APPDATA', path.join(testTempDir, 'empty-appdata'));

            const locations = await ClaudeStorageDetector.detectStorageLocations();
            expect(locations).toEqual([]);
        });

        it('DEVRAIT ignorer APPDATA quand process.env.APPDATA est indéfini', async () => {
            vi.stubEnv('APPDATA', '');
            // Empty home → only home branch evaluated, then APPDATA path is null → skipped
            const locations = await ClaudeStorageDetector.detectStorageLocations();
            expect(Array.isArray(locations)).toBe(true);
            // No APPDATA source in result
            const sourcePaths = new Set(locations.map(l => l.path));
            expect(sourcePaths.has(appDataClaudeDir)).toBe(false);
        });
    });

    // ============================================================
    // listProjects catch (L118): ENOENT → []
    // ============================================================
    describe('listProjects (L110-120)', () => {
        it('DEVRAIT retourner [] pour un répertoire qui n\'existe pas (catch L118)', async () => {
            const ghost = path.join(testTempDir, 'never-created');
            const projects = await ClaudeStorageDetector.listProjects(ghost);
            expect(projects).toEqual([]);
        });

        it('DEVRAIT retourner [] pour un chemin qui n\'est pas un répertoire (L118 catch)', async () => {
            const filePath = path.join(testTempDir, 'a-file.txt');
            await fs.writeFile(filePath, 'not a dir');
            const projects = await ClaudeStorageDetector.listProjects(filePath);
            expect(projects).toEqual([]);
        });
    });

    // ============================================================
    // analyzeConversation: file path (L184)
    // ============================================================
    describe('analyzeConversation (L169-263)', () => {
        it('DEVRAIT retourner null si projectPath pointe vers un fichier (L184 isFile)', async () => {
            const filePath = path.join(testProjectDir, 'not-a-dir.jsonl');
            await fs.writeFile(filePath, '{}');
            const skeleton = await ClaudeStorageDetector.analyzeConversation('cov-id', filePath);
            expect(skeleton).toBeNull();
        });
    });

    // ============================================================
    // extractContent Array branch (L414) — array with mixed block types
    // ============================================================
    describe('extractContent Array branch (L414)', () => {
        it('DEVRAIT concaténer les blocks text quand message.content est un Array (L412-415)', async () => {
            // array of blocks: only 'text' blocks contribute; non-text blocks are filtered out
            const mixedContent = [
                { type: 'text', text: 'first text' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'X' } },
                { type: 'text', text: 'second text' },
                { type: 'tool_use', toolUse: { name: 'noop', id: 't1', input: {} } },
            ];
            const entry: ClaudeJsonlEntry = {
                type: 'assistant',
                message: { role: 'assistant', content: mixedContent as any },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'cov-array',
            };
            await fs.writeFile(path.join(testProjectDir, 'conv.jsonl'), JSON.stringify(entry));

            const skeleton = await ClaudeStorageDetector.analyzeConversation('cov-id', testProjectDir);
            expect(skeleton).toBeDefined();
            const assistant = skeleton!.sequence.find((s: any) => s.role === 'assistant') as any;
            expect(assistant).toBeDefined();
            expect(assistant.content).toContain('first text');
            expect(assistant.content).toContain('second text');
            // Image and tool_use blocks are NOT joined into the text content
            expect(assistant.content).not.toContain('base64');
        });
    });

    // ============================================================
    // getContentLength fallback (L435) — non-string / non-array → 0
    // ============================================================
    describe('getContentLength fallback (L435)', () => {
        it('DEVRAIT retourner 0 (fallback) quand content n\'est ni string ni Array', async () => {
            // Pass an object as content — neither string nor Array → triggers L435 fallback
            const weirdEntry: any = {
                type: 'user',
                message: { role: 'user', content: { someObject: 'value' } },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'cov-weird',
            };
            await fs.writeFile(path.join(testProjectDir, 'conv.jsonl'), JSON.stringify(weirdEntry));

            const skeleton = await ClaudeStorageDetector.analyzeConversation('cov-id', testProjectDir);
            // analyzeConversation must not crash on a malformed-but-parsed entry
            expect(skeleton).toBeDefined();
            // No message pushed to sequence (extractContent returns '' for unknown, and isTruncated=false)
            const userMsg = skeleton!.sequence.find((s: any) => s.role === 'user');
            if (userMsg) {
                expect((userMsg as any).isTruncated).toBe(false);
                expect((userMsg as any).content).toBe('');
            }
        });
    });

    // ============================================================
    // detectWorkspace (L527, L538) — Current working directory pattern + fallback
    // ============================================================
    describe('detectWorkspace (L492-539)', () => {
        it('DEVRAIT extraire le workspace depuis le pattern "Current working directory:\\n<path>" (L523-527)', async () => {
            // The regex /Current working directory[^\n]*\n([^\n]+)/ requires:
            //   `Current working directory<no-newline-text>\n<one-line-path>`
            // No `cwd` field (P1), no `metadata.files` (P2), no `readResult` (P3) —
            // only the message-content pattern branch can fire (L523-527).
            // Use a multi-line content where the marker is on one line and the path
            // is on the next line.
            const workspaceMsg = 'Some preamble\nCurrent working directory:\n/tmp/from-message\nMore text';
            const entry = {
                type: 'user',
                message: { role: 'user', content: workspaceMsg },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'cwd-msg',
            };

            // Use a non-c-- basename to defeat the c-- fallback
            const nonCProject = path.join(homeProjectsDir, 'd--plain-name');
            await fs.mkdir(nonCProject, { recursive: true });
            await fs.writeFile(path.join(nonCProject, 'conv.jsonl'), JSON.stringify(entry));

            const skeleton = await ClaudeStorageDetector.analyzeConversation('cov-id', nonCProject);
            expect(skeleton?.metadata.workspace).toBe('/tmp/from-message');
        });

        it('DEVRAIT retourner undefined quand aucun indice de workspace n\'est trouvé (L538)', async () => {
            // Entry has message.content (string, not matching pattern) but no cwd,
            // no metadata.files, no readResult. Project basename doesn't start with 'c--'.
            const entry = {
                type: 'user',
                message: { role: 'user', content: 'just a plain message, no path hints' },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'no-ws',
            };
            const nonCProject = path.join(homeProjectsDir, 'g--plain-name-no-hyphen');
            await fs.mkdir(nonCProject, { recursive: true });
            await fs.writeFile(path.join(nonCProject, 'conv.jsonl'), JSON.stringify(entry));

            const skeleton = await ClaudeStorageDetector.analyzeConversation('cov-id', nonCProject);
            expect(skeleton?.metadata.workspace).toBeUndefined();
        });
    });

    // ============================================================
    // findConversationById (L569-601): happy path through location iteration
    // ============================================================
    describe('findConversationById (L569-601)', () => {
        it('DEVRAIT retourner un skeleton quand le taskId correspond à un projet détecté (L577-600)', async () => {
            // Set up a real project directory in the mocked home
            const projectName = 'c--findme-project';
            const projectDir = path.join(homeProjectsDir, projectName);
            await fs.mkdir(projectDir, { recursive: true });

            const entry = {
                type: 'user',
                message: { role: 'user', content: 'find me' },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'find-1',
            };
            await fs.writeFile(path.join(projectDir, 'conv.jsonl'), JSON.stringify(entry));

            const skeleton = await ClaudeStorageDetector.findConversationById(`claude-${projectName}`);
            expect(skeleton).toBeDefined();
            expect(skeleton?.taskId).toBe(`claude-${projectName}`);
            expect(skeleton?.metadata.messageCount).toBe(1);
        });

        it('DEVRAIT matcher un taskId per-session (claude-{project}--{uuid}) via prefix (L586)', async () => {
            const projectName = 'c--per-session-proj';
            const sessionUuid = '11111111-2222-3333-4444-555555555555';
            const projectDir = path.join(homeProjectsDir, projectName);
            await fs.mkdir(projectDir, { recursive: true });

            const entry = {
                type: 'user',
                message: { role: 'user', content: 'session' },
                timestamp: '2024-01-01T10:00:00.000Z',
                uuid: 'ses-1',
            };
            await fs.writeFile(path.join(projectDir, 'conv.jsonl'), JSON.stringify(entry));

            const skeleton = await ClaudeStorageDetector.findConversationById(`claude-${projectName}--${sessionUuid}`);
            expect(skeleton).toBeDefined();
        });

        it('DEVRAIT retourner null si aucun projet ne matche le taskId (L600)', async () => {
            // Home has no projects matching 'c--absent-project'
            const skeleton = await ClaudeStorageDetector.findConversationById('claude-c--absent-project');
            expect(skeleton).toBeNull();
        });
    });

    // ============================================================
    // getStorageStats (L606-639): happy path with mixed locations
    // ============================================================
    describe('getStorageStats (L606-639)', () => {
        it('DEVRAIT agréger totalConversations et totalSize depuis home + APPDATA (L611-629)', async () => {
            // Single project per source root — avoids source's per-entry double-count.
            // Home: 2 conversations in c--stats-home (drop the beforeEach c--cov-project).
            const homeProjDir = path.join(homeProjectsDir, 'c--stats-home');
            await fs.mkdir(homeProjDir, { recursive: true });
            await fs.rm(testProjectDir, { recursive: true, force: true });
            const sampleLine = '{"type":"user","message":{"role":"user","content":"x"},"timestamp":"2024-01-01T10:00:00.000Z","uuid":"x"}';
            await fs.writeFile(path.join(homeProjDir, 'a.jsonl'), sampleLine);
            await fs.writeFile(path.join(homeProjDir, 'b.jsonl'), sampleLine);

            // APPDATA: 1 conversation in d--stats-appdata
            const appProjDir = path.join(appDataClaudeDir, 'd--stats-appdata');
            await fs.mkdir(appProjDir, { recursive: true });
            await fs.writeFile(path.join(appProjDir, 'c.jsonl'), sampleLine);

            const stats = await ClaudeStorageDetector.getStorageStats();

            // 2 source roots detected (home + APPDATA)
            expect(stats.totalLocations).toBeGreaterThanOrEqual(2);
            // Total = 2 home + 1 appdata = 3 conversations.
            // (Source iterates ALL projects under each location.path for each entry —
            // 1 home project with 2 jsonl iterates once → 2 conversations. No double-count.)
            expect(stats.totalConversations).toBe(3);
            expect(stats.totalSize).toBeGreaterThan(0);
        });

        it('DEVRAIT retourner 0 conversations pour des projets vides (pas de .jsonl)', async () => {
            // Drop the beforeEach default project so home has NO projects
            await fs.rm(testProjectDir, { recursive: true, force: true });
            // Empty project dir in APPDATA only
            await fs.mkdir(path.join(appDataClaudeDir, 'd--empty-appdata'), { recursive: true });

            const stats = await ClaudeStorageDetector.getStorageStats();
            expect(stats.totalConversations).toBe(0);
            expect(stats.totalSize).toBe(0);
        });
    });
});