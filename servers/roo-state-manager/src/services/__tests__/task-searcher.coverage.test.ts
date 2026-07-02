/**
 * task-searcher.coverage.test.ts — complément de couverture #833 Sprint C3
 *
 * Add-only, tests-only. Zéro modification source / test existant.
 * Cible les branches de filtre avancé #604/#636 de `searchTasks` laissées froides
 * par `task-searcher.test.ts` : source, chunk_type, role, tool_name, has_errors, model
 * (L189-208) — leurs arms présents ET absents — ainsi que la fusion avec
 * `options.filter.must` et le fallback `QDRANT_SEARCH_TIMEOUT_MS`.
 *
 * @module services/__tests__/task-searcher.coverage.test
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────── mocks (mêmes spécificateurs que le SUT) ───────────────────

const mockEmbeddingsCreate = vi.fn();
const mockQdrantSearch = vi.fn();
const mockFindConversationById = vi.fn();
const mockReadFile = vi.fn();
const mockAccess = vi.fn();
const mockReadArchivedTask = vi.fn();

vi.mock('../openai.js', () => ({
  default: () => ({
    embeddings: {
      create: (...args: any[]) => mockEmbeddingsCreate(...args),
    },
  }),
  getEmbeddingModel: () => 'test-embedding-model',
}));

vi.mock('../qdrant.js', () => ({
  getQdrantClient: () => ({
    search: (...args: any[]) => mockQdrantSearch(...args),
  }),
}));

vi.mock('../../utils/roo-storage-detector.js', () => ({
  RooStorageDetector: {
    findConversationById: (...args: any[]) => mockFindConversationById(...args),
  },
}));

vi.mock('fs', () => ({
  promises: {
    access: (...args: any[]) => mockAccess(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
  },
}));

import { searchTasks } from '../task-searcher.js';

// Récupère l'objet de recherche Qdrant passé lors du 1er appel.
function lastSearchArg(): any {
  return mockQdrantSearch.mock.calls[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  mockQdrantSearch.mockResolvedValue([]); // pas de résultat → on n'exerce que le build du filtre
  mockFindConversationById.mockResolvedValue(null);
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
});

describe('searchTasks — filtres avancés #604/#636 (coverage complement)', () => {
  test('source (≠ all) ajoute une condition source (L189-191)', async () => {
    await searchTasks('q', { source: 'roo' });
    expect(lastSearchArg().filter.must).toContainEqual({ key: 'source', match: { value: 'roo' } });
  });

  test("source === 'all' n'ajoute AUCUNE condition (arm falsy L189)", async () => {
    await searchTasks('q', { source: 'all' });
    // Aucune condition construite → searchFilter retombe sur options.filter (undefined).
    expect(lastSearchArg().filter).toBeUndefined();
  });

  test('chunk_type ajoute une condition chunk_type (L194-195)', async () => {
    await searchTasks('q', { chunk_type: 'tool_interaction' });
    expect(lastSearchArg().filter.must).toContainEqual({
      key: 'chunk_type',
      match: { value: 'tool_interaction' },
    });
  });

  test('role ajoute une condition role (L197-198)', async () => {
    await searchTasks('q', { role: 'user' });
    expect(lastSearchArg().filter.must).toContainEqual({ key: 'role', match: { value: 'user' } });
  });

  test('tool_name ajoute une condition tool_name (L200-201)', async () => {
    await searchTasks('q', { tool_name: 'read_file' });
    expect(lastSearchArg().filter.must).toContainEqual({
      key: 'tool_name',
      match: { value: 'read_file' },
    });
  });

  test('has_errors === true ajoute une condition has_error (L203-205)', async () => {
    await searchTasks('q', { has_errors: true });
    expect(lastSearchArg().filter.must).toContainEqual({ key: 'has_error', match: { value: true } });
  });

  test('has_errors === false n\'ajoute PAS de condition (arm falsy L203)', async () => {
    await searchTasks('q', { has_errors: false });
    expect(lastSearchArg().filter).toBeUndefined();
  });

  test('model ajoute une condition model (L206-208)', async () => {
    await searchTasks('q', { model: 'opus' });
    expect(lastSearchArg().filter.must).toContainEqual({ key: 'model', match: { value: 'opus' } });
  });

  test('fusionne options.filter.must avec les filtres avancés (L184-185 + L210)', async () => {
    await searchTasks('q', {
      filter: { must: [{ key: 'task_id', match: { value: 'abc' } }] },
      source: 'claude-code',
      model: 'sonnet',
    });
    const must = lastSearchArg().filter.must;
    expect(must).toContainEqual({ key: 'task_id', match: { value: 'abc' } });
    expect(must).toContainEqual({ key: 'source', match: { value: 'claude-code' } });
    expect(must).toContainEqual({ key: 'model', match: { value: 'sonnet' } });
  });
});

describe('reconstructAllChunksForTask — fallback archive GDrive (coverage complement)', () => {
  // Un seul `doMock`, factory déléguant à un vi.fn mutable → la même mock intercepte
  // l'import dynamique `./task-archiver/index.js` pour les deux chemins (succès + throw)
  // sans `vi.resetModules()`. Dans ce fichier, aucun autre test ne déclenche la
  // reconstruction (tous les résultats Qdrant sont vides), donc `task-archiver` est
  // importé pour la 1re fois ici, APRÈS l'enregistrement du doMock → interception fiable.
  function armArchiveMock() {
    vi.doMock('../task-archiver/index.js', () => ({
      TaskArchiver: {
        readArchivedTask: (...args: any[]) => mockReadArchivedTask(...args),
      },
    }));
  }

  test('archive trouvée → pousse les messages, arms timestamp présent/absent (L118-133)', async () => {
    armArchiveMock();
    mockQdrantSearch.mockResolvedValue([
      { id: 't-arch', version: 0, score: 0.9, payload: { task_id: 't-arch', chunk_type: 'message_exchange', content: 'x', sequence_order: 0 } },
    ]);
    mockFindConversationById.mockResolvedValue(null); // pas de local → chunks vide → fallback
    mockReadArchivedTask.mockResolvedValue({
      machineId: 'myia-ai-01',
      messages: [
        { role: 'user', content: 'avec timestamp', timestamp: '2025-01-01T00:00:00Z' }, // arm gauche L128
        { role: 'assistant', content: 'sans timestamp' }, // arm droit L128 → new Date().toISOString()
      ],
    });

    const result = await searchTasks('q');
    expect(Array.isArray(result)).toBe(true);
    expect(mockReadArchivedTask).toHaveBeenCalledWith('t-arch');
  });

  test('archive en échec → catch swallow, retourne un tableau (L135-137)', async () => {
    armArchiveMock();
    mockQdrantSearch.mockResolvedValue([
      { id: 't-arch2', version: 0, score: 0.9, payload: { task_id: 't-arch2', chunk_type: 'message_exchange', content: 'x', sequence_order: 0 } },
    ]);
    mockFindConversationById.mockResolvedValue(null);
    mockReadArchivedTask.mockRejectedValue(new Error('archive boom'));

    // Le catch L135-137 avale l'erreur → searchTasks ne rejette pas.
    const result = await searchTasks('q');
    expect(Array.isArray(result)).toBe(true);
    expect(mockReadArchivedTask).toHaveBeenCalledWith('t-arch2');
  });
});

describe('searchTasks — timeout de recherche Qdrant (coverage complement)', () => {
  const original = process.env.QDRANT_SEARCH_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.QDRANT_SEARCH_TIMEOUT_MS;
    else process.env.QDRANT_SEARCH_TIMEOUT_MS = original;
  });

  test('convertit QDRANT_SEARCH_TIMEOUT_MS (ms→s, arrondi sup.) quand défini (L214)', async () => {
    process.env.QDRANT_SEARCH_TIMEOUT_MS = '4500';
    await searchTasks('q');
    // Math.ceil(4500/1000) = 5
    expect(lastSearchArg().timeout).toBe(5);
  });
});
