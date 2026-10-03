/**
 * Parité de la politique marqueur/rc (#1747, dispatch coord ai-01 03/10)
 *
 * La sérialisation `[tool_result] Result: ${rc}` (rc = string | tableau de blocks
 * text joints) vit en 3 COPIES qui doivent rester en phase :
 *   1. claude-storage-detector.extractContent (~L441, #2946/#894)
 *   2. ChunkExtractor.extractToolResultText (~L207, #2949) — plié en tête de
 *      contentText par les deux chemins d'extraction
 *   3. TaskArchiver.flattenClaudeContent (#1324/#1747) — miroir conversationnel
 *      servi par le Tier 3
 *
 * Contrat de parité : MÊME entrée (blocks de contenu) → MÊME sérialisation du
 * marqueur et du texte aux trois sites, observable bout-en-bout :
 *   - site 1 : accès direct à la statique privée (cast, précédent RooStorageDetector)
 *   - site 3 : TaskArchiver.archiveClaudeCodeSession → payload gzippé capté,
 *     décompressé, messages[0].content asserté
 *   - site 2 : extractChunksFromClaudeSession → chunks[0].content asserté
 *
 * Les fixtures portent AU PLUS UN block text par cas : les sites 1/3 joignent
 * les blocks text par '\n\n', le site 2 par ' ' + trim — la divergence de
 * joiner multi-text est hors périmètre de la politique marqueur/rc et serait
 * masquée par hasard si on laissait les fixtures la traverser.
 *
 * Écarts de durcissement connus (mesurés review #1324), volontairement hors
 * contrat : garde `block?.` (sites 2/3) vs accès direct (site 1) sur block
 * null ; `typeof block.text === 'string'` (2/3) vs truthiness (1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gunzipSync } from 'zlib';

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
    // L'interface readline factice sert les DEUX consommateurs : le wrapper
    // événementiel (.on('line')) de TaskArchiver.readJsonlFile ET le
    // for-await de ChunkExtractor.extractChunksFromClaudeSession.
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
        hostname: () => 'parity-host',
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
        homedir: () => '/home/parity',
        userInfo: () => ({ username: 'parity' }),
    };
    return { ...m, default: m };
});

// jest.setup.js mocke 'uuid' SANS l'export v5 — computeChunkId (uuidv5) throw
// alors dans le try par-ligne de l'extracteur et chaque ligne est sautée comme
// « malformed ». Rétablir le module réel (même garde que
// ChunkExtractor.coverage.test.ts).
vi.mock('uuid', async () => await vi.importActual('uuid'));

import { ClaudeStorageDetector } from '../../src/utils/claude-storage-detector.js';
import { TaskArchiver } from '../../src/services/task-archiver/TaskArchiver.js';
import { extractChunksFromClaudeSession } from '../../src/services/task-indexer/ChunkExtractor.js';

interface ParityCase {
    name: string;
    content: any[];
    /** Sérialisation attendue des tool_results (marqueur + rc), '' si aucun. */
    marker: string;
    /** Le block text de la fixture (au plus un par cas). */
    text: string;
}

const CASES: ParityCase[] = [
    {
        name: 'tool_result rc string + block text',
        content: [
            { type: 'tool_result', content: 'ls output' },
            { type: 'text', text: 'Voici le résultat' },
        ],
        marker: '[tool_result] Result: ls output',
        text: 'Voici le résultat',
    },
    {
        name: 'tool_result rc = tableau de blocks text (joint sans sépareur)',
        content: [
            { type: 'tool_result', content: [{ type: 'text', text: 'part1 ' }, { type: 'text', text: 'part2' }] },
        ],
        marker: '[tool_result] Result: part1 part2',
        text: '',
    },
    {
        name: 'plusieurs tool_results — ordre préservé, marqueur AVANT le texte',
        content: [
            { type: 'text', text: 'après' },
            { type: 'tool_result', content: 'premier' },
            { type: 'tool_result', content: 'second' },
        ],
        marker: '[tool_result] Result: premier\n\n[tool_result] Result: second',
        text: 'après',
    },
    {
        name: 'rc non-string non-array → sérialisé vide (jamais "[object]" ni throw)',
        content: [
            { type: 'tool_result', content: 42 },
            { type: 'text', text: 'ok' },
        ],
        marker: '[tool_result] Result: ',
        text: 'ok',
    },
    {
        name: 'blocks non textuels exclus (thinking, tool_use, image)',
        content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'image', source: {} },
            { type: 'text', text: 'seul le texte' },
        ],
        marker: '',
        text: 'seul le texte',
    },
];

/** Sortie attendue du contrat de parité : marqueur en tête, texte ensuite. */
function expectedFlattened(c: ParityCase): string {
    return c.marker === '' ? c.text : (c.text === '' ? c.marker : `${c.marker}\n\n${c.text}`);
}

function jsonlLine(content: any[]): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

function setLines(content: any[]): void {
    mockLines.length = 0;
    mockLines.push(jsonlLine(content));
}

describe('Parité politique marqueur/rc — 3 copies (#1747)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        // #2825 : après le for-await, le module fait rl.close() puis
        // fileStream.destroy() — le mock de createReadStream doit rendre un
        // objet vivant, sinon le throw est avalé par le try par-fichier et
        // la fonction rend silencieusement des résultats partiels vides.
        mockCreateReadStream.mockReturnValue({ destroy: vi.fn() } as any);
        mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
    });

    describe('site 1 — ClaudeStorageDetector.extractContent (accès direct)', () => {
        it.each(CASES)('$name', (c) => {
            const out = (ClaudeStorageDetector as any).extractContent(
                structuredClone(c.content),
                Number.MAX_SAFE_INTEGER
            );
            expect(out).toBe(expectedFlattened(c));
        });
    });

    describe('site 3 — TaskArchiver.flattenClaudeContent via archiveClaudeCodeSession (payload gzip relu)', () => {
        it.each(CASES)('$name', async (c) => {
            setLines(c.content);

            const outcome = await TaskArchiver.archiveClaudeCodeSession(
                'parity-1747',
                '/proj/session.jsonl'
            );
            expect(outcome).toBe('archived');

            expect(mockWriteFile).toHaveBeenCalledTimes(1);
            const written = mockWriteFile.mock.calls[0][1] as Buffer;
            const archived = JSON.parse(gunzipSync(written).toString('utf-8'));

            expect(archived.messages).toHaveLength(1);
            expect(archived.messages[0].role).toBe('user');
            expect(archived.messages[0].content).toBe(expectedFlattened(c));
        });
    });

    describe('site 2 — ChunkExtractor.extractToolResultText via extractChunksFromClaudeSession', () => {
        it.each(CASES)('$name', async (c) => {
            setLines(c.content);
            mockStat.mockResolvedValue({ isDirectory: () => true } as any);
            mockReaddir.mockResolvedValue(['session.jsonl'] as any);

            const chunks = await extractChunksFromClaudeSession('parity-1747', '/proj');

            // Un chunk message + un chunk tool_interaction par block tool_use
            // de la fixture (#2336 D2 — comportement de l'extracteur, hors
            // périmètre marqueur/rc). Le chunk message est TOUJOURS [0] :
            // poussé avant les chunks outil (sequence_order 0).
            const toolUseCount = c.content.filter((b: any) => b.type === 'tool_use').length;
            expect(chunks).toHaveLength(1 + toolUseCount);
            expect(chunks[0].content).toBe(expectedFlattened(c));
            // La politique exige le marqueur EN TÊTE : tout downstream à ancrage
            // leading (classifieur ^\[([^\]]+)\] Result:) tient sur les 3 sites.
            if (c.marker !== '') {
                expect(chunks[0].content.startsWith('[tool_result] Result:')).toBe(true);
            }
        });
    });

    describe('contrat transverse', () => {
        it('les 3 sites rendent EXACTEMENT la même chaîne pour chaque fixture (parité stricte)', async () => {
            for (const c of CASES) {
                const detector = (ClaudeStorageDetector as any).extractContent(
                    structuredClone(c.content),
                    Number.MAX_SAFE_INTEGER
                );

                setLines(c.content);
                mockStat.mockResolvedValue({ isDirectory: () => true } as any);
                mockReaddir.mockResolvedValue(['session.jsonl'] as any);
                await TaskArchiver.archiveClaudeCodeSession('parity-1747', '/proj/session.jsonl');
                const archiver = JSON.parse(
                    gunzipSync(mockWriteFile.mock.calls[0][1] as Buffer).toString('utf-8')
                ).messages[0].content;

                mockWriteFile.mockClear();
                const chunk = (await extractChunksFromClaudeSession('parity-1747', '/proj'))[0].content;

                expect(detector, `detector≠archiver sur « ${c.name} »`).toBe(archiver);
                expect(detector, `detector≠chunk sur « ${c.name} »`).toBe(chunk);
                expect(archiver, `archiver≠chunk sur « ${c.name} »`).toBe(chunk);
            }
        });
    });
});
