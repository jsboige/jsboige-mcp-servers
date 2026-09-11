/**
 * Tests for the `.env` hot reload (services/config-reload.ts).
 *
 * Each test below is written so that removing the guard it covers turns it RED —
 * a test that would still pass with the guard deleted proves nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const resetEmbeddingOpenAIClient = vi.fn();
const resetChatOpenAIClient = vi.fn();
const resetFallbackChatOpenAIClient = vi.fn();
const resetQdrantClient = vi.fn();
const resetCodebaseEmbeddingClient = vi.fn();

vi.mock('../openai.js', () => ({
  resetEmbeddingOpenAIClient,
  resetChatOpenAIClient,
  resetFallbackChatOpenAIClient,
}));
vi.mock('../qdrant.js', () => ({ resetQdrantClient }));
vi.mock('../../tools/search/search-codebase.tool.js', () => ({ resetCodebaseEmbeddingClient }));

const { reloadConfig, fingerprint, RELOADABLE_ENV_KEYS } = await import('../config-reload.js');

let tmpDir: string;
let envPath: string;
const savedEnv: Record<string, string | undefined> = {};

/** Keys these tests touch — saved and restored so no test leaks into the next. */
const TOUCHED = [
  'OPENAI_API_KEY', 'EMBEDDING_API_KEY', 'VLLM_API_KEY_MEDIUM', 'QDRANT_URL', 'QDRANT_API_KEY',
  'ZAI_API_KEY', 'EMBEDDING_MODEL', 'QDRANT_COLLECTION_NAME',
  'ROOSYNC_SHARED_PATH', 'NODE_ENV', 'EMBEDDING_BATCH_SIZE',
];

function writeEnv(contents: string): void {
  fs.writeFileSync(envPath, contents, 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-reload-'));
  envPath = path.join(tmpDir, '.env');
  for (const k of TOUCHED) savedEnv[k] = process.env[k];
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('reloadConfig — allowlist is structural, not documentary', () => {
  it('does NOT write a key that is absent from the allowlist, even when .env sets it', () => {
    process.env.ROOSYNC_SHARED_PATH = '/original/shared';
    delete process.env.NODE_ENV;
    writeEnv('ROOSYNC_SHARED_PATH=/hijacked\nNODE_ENV=production\n');

    const report = reloadConfig(envPath);

    // The whole point: a reload cannot reach these, so it cannot redirect the
    // shared store or flip the runtime mode.
    expect(process.env.ROOSYNC_SHARED_PATH).toBe('/original/shared');
    expect(process.env.NODE_ENV).toBeUndefined();
    expect(report.changed).toHaveLength(0);
    expect(report.skippedKeys).toEqual(['NODE_ENV', 'ROOSYNC_SHARED_PATH']);
  });

  it('excludes QDRANT_COLLECTION_NAME — it is captured at module level in 3 files', () => {
    // Reloading it would leave VectorIndexer/QdrantHealthMonitor/cleanup-orphans on
    // the OLD collection while qdrant.ts:68 reads the NEW one: a silent split brain.
    expect(RELOADABLE_ENV_KEYS).not.toContain('QDRANT_COLLECTION_NAME');
    expect(RELOADABLE_ENV_KEYS).not.toContain('EMBEDDING_BATCH_SIZE');

    process.env.QDRANT_COLLECTION_NAME = 'roo_tasks_semantic_index';
    writeEnv('QDRANT_COLLECTION_NAME=some_other_collection\n');
    reloadConfig(envPath);
    expect(process.env.QDRANT_COLLECTION_NAME).toBe('roo_tasks_semantic_index');
  });
});

describe('reloadConfig — client invalidation follows the keys that changed', () => {
  it('resets exactly the clients whose configuration moved', () => {
    process.env.QDRANT_API_KEY = 'old-qdrant';
    process.env.OPENAI_API_KEY = 'unchanged-chat';
    writeEnv('QDRANT_API_KEY=new-qdrant\nOPENAI_API_KEY=unchanged-chat\n');

    const report = reloadConfig(envPath);

    expect(process.env.QDRANT_API_KEY).toBe('new-qdrant');
    expect(report.changed.map((c) => c.key)).toEqual(['QDRANT_API_KEY']);
    expect(report.clientsReset).toEqual(['qdrantClient']);
    expect(resetQdrantClient).toHaveBeenCalledTimes(1);
    // The chat key did not move, so its client must survive.
    expect(resetChatOpenAIClient).not.toHaveBeenCalled();
  });

  it('resets every client sharing a changed key (a rotated OPENAI_API_KEY hits three)', () => {
    process.env.OPENAI_API_KEY = 'pre-rotation';
    writeEnv('OPENAI_API_KEY=post-rotation\n');

    const report = reloadConfig(envPath);

    expect(report.clientsReset).toEqual(
      ['chatClient', 'codebaseEmbeddingClient', 'embeddingClient'],
    );
    expect(resetChatOpenAIClient).toHaveBeenCalledTimes(1);
    expect(resetEmbeddingOpenAIClient).toHaveBeenCalledTimes(1);
    expect(resetCodebaseEmbeddingClient).toHaveBeenCalledTimes(1);
    expect(resetQdrantClient).not.toHaveBeenCalled();
  });

  it('a rotated VLLM_API_KEY_MEDIUM resets ONLY the chat client (fleet rotation name)', () => {
    // VLLM_API_KEY_MEDIUM is the canonical fleet name for the vLLM tier the chat
    // endpoint points at. Rotating it must rebuild the chat client and nothing
    // else — the embedding clients never read that name.
    process.env.VLLM_API_KEY_MEDIUM = 'pre-rotation';
    writeEnv('VLLM_API_KEY_MEDIUM=post-rotation\n');

    const report = reloadConfig(envPath);

    expect(report.changed.map((c) => c.key)).toEqual(['VLLM_API_KEY_MEDIUM']);
    expect(report.clientsReset).toEqual(['chatClient']);
    expect(resetChatOpenAIClient).toHaveBeenCalledTimes(1);
    expect(resetEmbeddingOpenAIClient).not.toHaveBeenCalled();
    expect(resetCodebaseEmbeddingClient).not.toHaveBeenCalled();
    expect(resetQdrantClient).not.toHaveBeenCalled();
  });

  it('resets NOTHING when the file is byte-identical to the live config', () => {
    process.env.OPENAI_API_KEY = 'same';
    process.env.QDRANT_URL = 'http://localhost:6333';
    writeEnv('OPENAI_API_KEY=same\nQDRANT_URL=http://localhost:6333\n');

    const report = reloadConfig(envPath);

    expect(report.changed).toHaveLength(0);
    expect(report.unchangedCount).toBe(2);
    expect(report.clientsReset).toHaveLength(0);
    expect(resetChatOpenAIClient).not.toHaveBeenCalled();
    expect(resetQdrantClient).not.toHaveBeenCalled();
  });

  it('leaves process.env alone for allowlisted keys the file does not mention', () => {
    process.env.ZAI_API_KEY = 'from-parent-process';
    writeEnv('OPENAI_API_KEY=whatever\n');

    reloadConfig(envPath);

    expect(process.env.ZAI_API_KEY).toBe('from-parent-process');
    expect(resetFallbackChatOpenAIClient).not.toHaveBeenCalled();
  });

  it('reports not-found and drops no client when there is no .env at all', () => {
    const report = reloadConfig(path.join(tmpDir, 'absent.env'));

    expect(report.envFileFound).toBe(false);
    expect(report.clientsReset).toHaveLength(0);
    // Dropping live clients because a file is missing would be a pure regression.
    expect(resetQdrantClient).not.toHaveBeenCalled();
    expect(resetChatOpenAIClient).not.toHaveBeenCalled();
  });
});

describe('fingerprint — masks the VALUE, never the NAME', () => {
  it('never emits the secret, and still distinguishes two different secrets', () => {
    // Deliberately NOT shaped like a key. A bare 32-hex literal would be a
    // synthetic value that every secret scanner — and every reviewer — has to
    // triage by hand, in a public repo, in a PR about a 32-hex key rotation.
    // Length 32 is what the assertion needs; the hex shape is not.
    const secret = 'EXAMPLE-NOT-A-REAL-SECRET-000001';
    const other = 'EXAMPLE-NOT-A-REAL-SECRET-000002';

    const fpSecret = fingerprint(secret);
    expect(fpSecret).not.toContain(secret);
    expect(fpSecret).toMatch(/^len=32 fp=[0-9a-f]{8}$/);
    // Same length, different value → the report must still show a move.
    expect(fingerprint(other)).not.toBe(fpSecret);
    expect(fingerprint(secret)).toBe(fpSecret);
  });

  it('distinguishes absent from empty — they are different failures', () => {
    // An ABSENT credential and an EMPTY one both yield HTTP 401 downstream; the
    // report has to separate them so the reader is not left guessing.
    expect(fingerprint(undefined)).toBe('ABSENT');
    expect(fingerprint('')).toBe('EMPTY');
  });

  it('keeps secret values out of the change report entirely', () => {
    process.env.EMBEDDING_API_KEY = 'old-secret-value';
    writeEnv('EMBEDDING_API_KEY=new-secret-value\n');

    const report = reloadConfig(envPath);
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain('old-secret-value');
    expect(serialised).not.toContain('new-secret-value');
    // The NAME, however, must be there — that is what makes the report actionable.
    expect(serialised).toContain('EMBEDDING_API_KEY');
  });
});
