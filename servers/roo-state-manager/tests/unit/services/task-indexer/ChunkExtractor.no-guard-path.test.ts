/**
 * #2639 — le chemin réel de l'extracteur SANS garde uuid locale.
 *
 * Contexte : jest.setup.js mocke 'uuid'. Tant que ce mock n'exposait pas v5,
 * `computeChunkId` (uuidv5) levait une TypeError à l'intérieur du try/catch
 * par-ligne de `extractChunksFromClaudeSession`, et CHAQUE ligne JSONL était
 * silencieusement sautée comme « malformed » — un test d'extracteur sans garde
 * locale ne testait donc plus le chemin d'extraction mais le chemin
 * « toutes lignes malformées » (0 chunk, aucune erreur visible).
 *
 * Ce fichier n'installe AUCUN `vi.mock('uuid', ...)` : il consomme le mock
 * global du setup, exactement comme le ferait un nouveau test d'extracteur
 * qui ignore le piège. Il verrouille deux propriétés :
 *   1. le mock global expose v5, et v5 est déterministe (délégué au réel) ;
 *   2. une ligne JSONL valide produit bien 1 chunk avec un chunk_id au format
 *      UUID v5 — la preuve que le vrai chemin est emprunté.
 *
 * La mutation de contrôle (retirer `v5: actual.v5` du setup) fait rougir ces
 * deux tests : computeChunkId throw et l'extracteur rend 0 chunk.
 */
import { describe, it, expect, vi } from 'vitest';

const { mockReadFile, mockWriteFile, mockMkdir, mockAccess, mockReaddir, mockStat, mockExistsSync, mockCreateReadStream, mockLines, makeRl } = vi.hoisted(() => ({
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
    mockAccess: vi.fn(),
    mockReaddir: vi.fn(),
    mockStat: vi.fn(),
    mockExistsSync: vi.fn(() => false),
    mockCreateReadStream: vi.fn(),
    mockLines: [] as string[],
    // L'interface readline factice sert le for-await de l'extracteur.
    makeRl: () => ({
        on: vi.fn((event: string, cb: (v: string) => void) => {
            if (event === 'line') {
                for (const l of [...mockLines]) cb(l);
            }
            if (event === 'close') cb();
        }),
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
            for (const l of [...mockLines]) yield l;
        },
    }),
}));

vi.mock('fs', () => {
    const promises = {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
        mkdir: mockMkdir,
        access: mockAccess,
        readdir: mockReaddir,
        stat: mockStat,
    };
    return {
        promises,
        default: { promises, existsSync: mockExistsSync, createReadStream: mockCreateReadStream },
        createReadStream: mockCreateReadStream,
        existsSync: mockExistsSync,
    };
});

vi.mock('readline', () => ({
    createInterface: vi.fn(() => makeRl()),
}));

vi.mock('os', () => {
    const m = {
        hostname: () => 'no-guard-host',
        platform: () => 'linux',
        arch: () => 'x64',
        tmpdir: () => '/tmp',
        EOL: '\n',
        type: () => 'Linux',
        release: () => '5.0',
        networkInterfaces: () => ({}),
        totalmem: () => 1,
        freemem: () => 1,
        cpus: () => [],
        homedir: () => '/home/no-guard',
        userInfo: () => ({ username: 'no-guard' }),
    };
    return { ...m, default: m };
});

// PAS de vi.mock('uuid', ...) ici — c'est tout l'objet du fichier.

import { computeChunkId, extractChunksFromClaudeSession } from '../../../../src/services/task-indexer/ChunkExtractor.js';

const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('#2639 — chemin extracteur sans garde uuid', () => {
    it('computeChunkId rend un UUID v5 déterministe via le mock global', () => {
        const id1 = computeChunkId('no-guard-task', 'user', 1, 'contenu');
        const id2 = computeChunkId('no-guard-task', 'user', 1, 'contenu');
        const id3 = computeChunkId('no-guard-task', 'user', 2, 'contenu');
        expect(id1).toMatch(UUID_V5_RE);
        expect(id2).toBe(id1); // déterministe : même seed → même UUID
        expect(id3).not.toBe(id1); // le seed discrimine
    });

    it('une ligne JSONL valide produit 1 chunk message avec chunk_id v5 (pas le chemin malformed)', async () => {
        mockLines.length = 0;
        mockLines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'bonjour' }] } }));
        mockCreateReadStream.mockReturnValue({ destroy: vi.fn() } as any);
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        mockStat.mockResolvedValue({ isDirectory: () => true } as any);
        mockReaddir.mockResolvedValue(['session.jsonl'] as any);

        const chunks = await extractChunksFromClaudeSession('no-guard-task', '/proj');

        // 0 chunk = la ligne a été sautée comme « malformed » (v5 absent du mock).
        expect(chunks).toHaveLength(1);
        expect(chunks[0].source).toBe('claude-code');
        expect(chunks[0].chunk_id).toMatch(UUID_V5_RE);
    });
});