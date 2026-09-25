/**
 * #1747 review (C1+C2) — tests sur layout disque REEL, aucun mock fs.
 *
 * Le layout reel de ~/.claude/projects est `<projet>/<uuid>.jsonl` a plat
 * (sessions principales, profondeur 2) + `<projet>/<rep>/.../*.jsonl`
 * (transcripts imbriques, profondeur >= 3). Ces tests prouvent sur un vrai
 * disque que le batch enumere les DEUX, et que les archives restent a plat
 * (sessionIds composites sanitises) — les versions mockees de CI laissaient
 * les deux defauts en place sans le voir.
 *
 * Point d'injection : process.env.ROOSYNC_ARCHIVE_PATH (precedence directe
 * dans getArchiveBasePath) — les fs/zlib/readline restent reels.
 */
import { promises as fsp } from 'fs';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskArchiver } from '../TaskArchiver.js';
import { ArchivedTask } from '../types.js';

const gunzipAsync = promisify(gunzip);

const PROJECT = 'c--dev-roo-extensions';
const MAIN_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const SUBAGENT_UUID = '11111111-2222-3333-4444-555555555555';

const jsonlLine = (content: string, role = 'user') =>
    JSON.stringify({ timestamp: '2026-09-25T00:00:00Z', message: { role, content } });

describe('TaskArchiver.archiveClaudeCodeSessions — real disk layout (#1747 C1+C2)', () => {
    let root: string;
    let projectsBase: string;
    let archiveBase: string;
    let machinePath: string;
    const prevArchivePath = process.env.ROOSYNC_ARCHIVE_PATH;

    beforeAll(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rsm-archiver-real-'));
        projectsBase = path.join(root, 'projects');
        archiveBase = path.join(root, 'archive');
        machinePath = path.join(archiveBase, os.hostname().toLowerCase());
        process.env.ROOSYNC_ARCHIVE_PATH = archiveBase;

        const projectDir = path.join(projectsBase, PROJECT);
        await fsp.mkdir(projectDir, { recursive: true });

        // Session principale : fichier plat <uuid>.jsonl (profondeur 2) — C1
        await fsp.writeFile(
            path.join(projectDir, `${MAIN_UUID}.jsonl`),
            `${jsonlLine('flat main session')}\n${jsonlLine('second message', 'assistant')}\n`,
            'utf-8'
        );

        // Transcript imbrique sous un sous-repertoire (profondeur >= 3)
        const nestedDir = path.join(projectDir, MAIN_UUID, 'subagents');
        await fsp.mkdir(nestedDir, { recursive: true });
        await fsp.writeFile(
            path.join(nestedDir, `${SUBAGENT_UUID}.jsonl`),
            `${jsonlLine('subagent prompt')}\n`,
            'utf-8'
        );

        // Fichier non-session au niveau plat : doit etre ignore
        await fsp.writeFile(path.join(projectDir, 'notes.txt'), 'not a session', 'utf-8');
    });

    afterAll(async () => {
        if (prevArchivePath === undefined) {
            delete process.env.ROOSYNC_ARCHIVE_PATH;
        } else {
            process.env.ROOSYNC_ARCHIVE_PATH = prevArchivePath;
        }
        await fsp.rm(root, { recursive: true, force: true });
    });

    it('archives the flat main session AND the nested transcript, with flat archive filenames (no ENOENT)', async () => {
        const result = await TaskArchiver.archiveClaudeCodeSessions(projectsBase);

        expect(result.failed).toBe(0);
        expect(result.archived).toBe(2);

        const files = await fsp.readdir(machinePath);
        // C2 : sessionId composite sanitise — pas de separateur de chemin dans le nom
        expect(files).toContain(`claude-${PROJECT}__${MAIN_UUID}.json.gz`);
        expect(files).toContain(`claude-${PROJECT}__${MAIN_UUID}__${SUBAGENT_UUID}.json.gz`);
        // Layout plat : aucun sous-repertoire sous le repertoire machine
        const stats = await Promise.all(files.map(f => fsp.stat(path.join(machinePath, f))));
        expect(stats.every(s => s.isFile())).toBe(true);
    });

    it('the flat archive is readable and carries the sanitized taskId + claude-code metadata', async () => {
        const compressed = await fsp.readFile(path.join(machinePath, `claude-${PROJECT}__${MAIN_UUID}.json.gz`));
        const archived = JSON.parse((await gunzipAsync(compressed)).toString('utf-8')) as ArchivedTask;

        expect(archived.version).toBe(2);
        expect(archived.taskId).toBe(`${PROJECT}__${MAIN_UUID}`);
        expect(archived.metadata.source).toBe('claude-code');
        expect(archived.metadata.messageCount).toBe(2);
        expect(archived.messages).toHaveLength(2);
    });

    it('readArchivedTask round-trips the RAW composite sessionId (slashes tolerated on read)', async () => {
        const archived = await TaskArchiver.readArchivedTask(`${PROJECT}/${MAIN_UUID}`);
        expect(archived).not.toBeNull();
        expect(archived!.taskId).toBe(`${PROJECT}__${MAIN_UUID}`);
        expect(archived!.metadata.messageCount).toBe(2);
    });

    it('a second batch run over unchanged sources reports no failure (freshness guard)', async () => {
        const result = await TaskArchiver.archiveClaudeCodeSessions(projectsBase);
        expect(result.failed).toBe(0);
    });
});
