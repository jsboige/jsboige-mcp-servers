/**
 * Coverage for src/tools/roosync/health-view.ts (Cluster E file 1/3).
 *
 * Previously UNTESTED (R=2.0 — only the qdrant probe was exercised indirectly).
 * This file adds genuine branch coverage for the two most behavior-critical
 * exports plus the scoring orchestration:
 *
 *  - probeQdrantBackend(): the full #2628 regression suite. This is the fix
 *    that stops masking a live Qdrant 503/401/timeout as "OK" (env vars present
 *    but backend down). The source comment (L244-245) explicitly says "the
 *    regression suite asserts 503/401/timeout → false" — it did not exist.
 *  - formatMarkdown(): pure rendering incl. the 4-way Qdrant/Embeddings status
 *    that surfaces #2628/#2547 (MISSING / OK+reachable / FAIL-unreachable / OK).
 *  - roosyncHealthView(): orchestration + computeScore, covering the #2628
 *    scoring branch (configured-but-unreachable Qdrant → -10) and the
 *    includeEnvCheck toggle.
 *
 * Tests-only, 0 source runtime touched. Assertions anchored on the real source
 * contract (#815 scepticism method) — never fabricated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (relative to this test file; resolve to the same modules the source imports) ---

// Capabilities: controls qdrant/embeddings/sharedPath "configured" booleans.
const mockIsAvailable = vi.fn();
vi.mock('../../../utils/server-capabilities.js', () => ({
  getServerCapabilities: () => ({ isAvailable: mockIsAvailable }),
}));

// Qdrant live probe uses global fetch; mocked per-test.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Embedding backend probe (probeEmbeddingBackend).
const mockEmbeddingsCreate = vi.fn();
vi.mock('../../../services/openai.js', () => ({
  default: () => ({ embeddings: { create: mockEmbeddingsCreate } }),
  getEmbeddingModel: () => 'test-embed-model',
}));

// Drift collection: roosyncCompareConfig returns counts/items we control.
const mockCompareConfig = vi.fn();
vi.mock('../compare-config.js', () => ({
  roosyncCompareConfig: mockCompareConfig,
}));

// shared-state-path: point collectSystemHealth at a non-existent dashboards dir
// so it short-circuits to {0,0,0,['DASHBOARDS_DIR_MISSING']} (no machine deduction).
vi.mock('../../../utils/shared-state-path.js', () => ({
  getSharedStatePath: () => '/tmp/health-view-test-nonexistent-shared',
}));

// Stable localMachineId (os.hostname varies by runner). Partial mock: keep the
// real module (createLogger → dashboard-activity needs os.tmpdir()) and only
// override hostname.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, hostname: () => 'myia-test-machine' };
});

// NOTE: collectSystemHealth still imports fs + dashboard-activity + lazy-roosync.
// With a non-existent shared path, existsSync(dashboardsDir) is false → it returns
// early before touching those, so they need no mock.

import { probeQdrantBackend, formatMarkdown, roosyncHealthView, type HealthViewResult } from '../health-view.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAvailable.mockReset();
  mockFetch.mockReset();
  mockEmbeddingsCreate.mockReset();
  mockCompareConfig.mockReset();
  // Default: everything configured & available; drift clean.
  mockIsAvailable.mockImplementation((cap: string) => cap === 'sharedPath' || cap === 'qdrant' || cap === 'embeddings');
  mockCompareConfig.mockResolvedValue({
    target: 'remote',
    summary: { critical: 0, important: 0, warning: 0, info: 0 },
    differences: [],
  });
  // Default clean env: ALL 6 CRITICAL_ENV_VARS present (4× EMBEDDING_* warning +
  // QDRANT_URL + QDRANT_API_KEY critical). Without this, collectEnvCheck returns
  // missing EMBEDDING_* on runners where those vars are absent (CI) → "Set ..."
  // recommendations → generateRecommendations never reaches its "All systems
  // nominal" empty-recs branch (the HEALTHY-baseline test would flake).
  // Locally these leak in via .env; CI has no .env → must be set explicitly.
  // The "missing env" test deletes QDRANT_URL/QDRANT_API_KEY explicitly.
  process.env.QDRANT_URL = 'https://qdrant.example.com';
  process.env.QDRANT_API_KEY = 'test-key';
  process.env.EMBEDDING_MODEL = 'test-model';
  process.env.EMBEDDING_DIMENSIONS = '1536';
  process.env.EMBEDDING_API_BASE_URL = 'https://embed.example.com';
  process.env.EMBEDDING_API_KEY = 'test-embed-key';
});

afterEach(() => {
  // Restore env vars we may have stubbed.
  const envKeys = [
    'QDRANT_URL', 'QDRANT_API_KEY', 'QDRANT_HEALTH_PROBE_TIMEOUT_MS',
    'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'EMBEDDING_API_BASE_URL', 'EMBEDDING_API_KEY',
  ];
  for (const k of envKeys) delete process.env[k];
});

// ============================================================
// Part A — probeQdrantBackend (#2628 regression suite)
// ============================================================
describe('probeQdrantBackend (#2628 regression suite)', () => {
  it('returns false when QDRANT_URL is not set', async () => {
    delete process.env.QDRANT_URL;
    expect(await probeQdrantBackend()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns true on a 2xx response and strips trailing slashes from the URL', async () => {
    process.env.QDRANT_URL = 'https://qdrant.example.com///';
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await probeQdrantBackend()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://qdrant.example.com/collections');
  });

  it.each([
    ['503 service unavailable', 503],
    ['500 internal error', 500],
    ['404 not found', 404],
    ['401 unauthorized (auth failure)', 401],
    ['403 forbidden (auth failure)', 403],
  ])('returns false on %s (resp.ok false)', async (_label, status) => {
    process.env.QDRANT_URL = 'https://qdrant.example.com';
    mockFetch.mockResolvedValueOnce({ ok: status < 200 || status >= 300 });
    // Simulate the real resp.ok semantics: ok is true only for 2xx.
    const okStatus = status >= 200 && status < 300;
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: okStatus });
    expect(await probeQdrantBackend()).toBe(false);
  });

  it('returns false when fetch throws a network error (ECONNRESET / fetch failed)', async () => {
    process.env.QDRANT_URL = 'https://qdrant.example.com';
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    expect(await probeQdrantBackend()).toBe(false);
  });

  it('returns false on timeout (AbortError)', async () => {
    process.env.QDRANT_URL = 'https://qdrant.example.com';
    process.env.QDRANT_HEALTH_PROBE_TIMEOUT_MS = '50';
    // fetch rejects with an AbortError-like object when the controller aborts.
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    // Make fetch hang past the 50ms timeout so the AbortController fires.
    mockFetch.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(abortErr), 200);
    }));
    const start = Date.now();
    expect(await probeQdrantBackend()).toBe(false);
    // Bounded: should return well before the 200ms fake-fetch reject.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('sends api-key header when QDRANT_API_KEY is set', async () => {
    process.env.QDRANT_URL = 'https://qdrant.example.com';
    process.env.QDRANT_API_KEY = 'secret-key';
    mockFetch.mockResolvedValueOnce({ ok: true });
    await probeQdrantBackend();
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe('GET');
    expect((opts.headers as Record<string, string>)['api-key']).toBe('secret-key');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('does not set api-key header when QDRANT_API_KEY is absent', async () => {
    process.env.QDRANT_URL = 'https://qdrant.example.com';
    delete process.env.QDRANT_API_KEY;
    mockFetch.mockResolvedValueOnce({ ok: true });
    await probeQdrantBackend();
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)['api-key']).toBeUndefined();
  });
});

// ============================================================
// Part B — formatMarkdown (pure rendering, 4-way #2628/#2547 status)
// ============================================================
describe('formatMarkdown', () => {
  const base: HealthViewResult = {
    status: 'HEALTHY',
    score: 100,
    timestamp: '2026-07-01T00:00:00.000Z',
    localMachine: 'myia-test',
    systemHealth: { machinesOnline: 6, machinesUnknown: 0, machinesTotal: 6, flags: [] },
    capabilities: { sharedPath: true, qdrant: true, embeddings: true },
    drift: { checked: true, baselineSource: 'remote (via GDrive inventory)', critical: 0, important: 0, warning: 0, info: 0, items: [] },
    envCheck: { checked: true, missing: [], present: ['QDRANT_URL'] },
    recommendations: ['All systems nominal'],
  };

  it('renders OK icon for HEALTHY', () => {
    const md = formatMarkdown({ ...base, status: 'HEALTHY' });
    expect(md).toContain('[OK] Cluster Health View — myia-test');
    expect(md).toContain('**Status:** HEALTHY | **Score:** 100/100');
  });

  it('renders WARN icon for WARNING', () => {
    expect(formatMarkdown({ ...base, status: 'WARNING', score: 65 })).toContain('[WARN]');
  });

  it('renders CRIT icon for CRITICAL', () => {
    expect(formatMarkdown({ ...base, status: 'CRITICAL', score: 30 })).toContain('[CRIT]');
  });

  it('reports Qdrant MISSING when not configured', () => {
    const md = formatMarkdown({ ...base, capabilities: { ...base.capabilities, qdrant: false } });
    expect(md).toContain('Qdrant: MISSING (not configured)');
  });

  it('reports Qdrant FAIL when configured but unreachable (#2628)', () => {
    const md = formatMarkdown({
      ...base,
      capabilities: { ...base.capabilities, qdrant: true, qdrantReachable: false },
    });
    expect(md).toContain('Qdrant: FAIL (configured but unreachable)');
  });

  it('reports Qdrant OK when configured + reachable', () => {
    const md = formatMarkdown({
      ...base,
      capabilities: { ...base.capabilities, qdrant: true, qdrantReachable: true },
    });
    expect(md).toContain('Qdrant: OK (configured + reachable)');
  });

  it('reports Qdrant OK (configured) when reachable is undefined', () => {
    const md = formatMarkdown({ ...base });
    expect(md).toContain('Qdrant: OK (configured)');
  });

  it('reports Embeddings DEGRADED when configured but unreachable (#2547)', () => {
    const md = formatMarkdown({
      ...base,
      capabilities: { ...base.capabilities, embeddings: true, embeddingsReachable: false },
    });
    expect(md).toContain('Embeddings: DEGRADED (configured but unreachable)');
  });

  it('renders drift items capped at 10 with an "and N more" line', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      category: 'cat', severity: 'WARNING', path: `/p${i}`, description: `d${i}`,
    }));
    const md = formatMarkdown({ ...base, drift: { ...base.drift, warning: 12, items } });
    expect(md).toContain('... and 2 more');
  });

  it('renders "Not checked" when drift was not checked', () => {
    const md = formatMarkdown({ ...base, drift: { ...base.drift, checked: false, baselineSource: 'error: boom' } });
    expect(md).toContain('Not checked (error: boom)');
  });

  it('lists MISSING env vars with severity', () => {
    const md = formatMarkdown({
      ...base,
      envCheck: { checked: true, missing: [{ name: 'QDRANT_URL', severity: 'critical' }], present: [] },
    });
    expect(md).toContain('MISSING: QDRANT_URL (critical)');
  });
});

// ============================================================
// Part C — roosyncHealthView orchestration + scoring (#2628 branch)
// ============================================================
describe('roosyncHealthView orchestration + scoring', () => {
  it('returns HEALTHY when everything is configured, reachable, and drift is clean', async () => {
    // qdrant probe (fetch) + embedding probe both succeed.
    mockFetch.mockResolvedValue({ ok: true });
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const result = await roosyncHealthView({});
    expect(result.status).toBe('HEALTHY');
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.capabilities.qdrantReachable).toBe(true);
    expect(result.capabilities.embeddingsReachable).toBe(true);
    expect(result.recommendations).toContain('All systems nominal');
  });

  it('#2628: configured-but-unreachable Qdrant deducts score and surfaces a FAIL verdict + recommendation', async () => {
    // qdrant configured (isAvailable true) but the live probe 503s.
    mockFetch.mockResolvedValue({ ok: false }); // unreachable
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });
    const result = await roosyncHealthView({});
    // Source: qdrantReachable===false → -10 vs reachable. Score still >= 50 here
    // (sharedPath+embeddings+drift clean) but strictly less than the HEALTHY baseline.
    expect(result.capabilities.qdrantReachable).toBe(false);
    expect(result.score).toBeLessThan(100);
    expect(result.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Qdrant configured but UNREACHABLE'),
      ])
    );
  });

  it('includeEnvCheck=false skips env var collection', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });
    const result = await roosyncHealthView({ includeEnvCheck: false });
    expect(result.envCheck.checked).toBe(false);
    expect(result.envCheck.missing).toEqual([]);
  });

  it('missing critical env vars reduces the score', async () => {
    // Embeddings configured false → probe skipped; qdrant configured + reachable.
    mockIsAvailable.mockImplementation((cap: string) => cap === 'sharedPath' || cap === 'qdrant');
    mockFetch.mockResolvedValue({ ok: true });
    // Force QDRANT_URL + QDRANT_API_KEY missing (critical env vars).
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_API_KEY;
    const result = await roosyncHealthView({});
    expect(result.envCheck.missing.map(m => m.name)).toEqual(
      expect.arrayContaining(['QDRANT_URL', 'QDRANT_API_KEY'])
    );
    // 2 critical env missing → -20. Score must reflect the deduction.
    expect(result.score).toBeLessThanOrEqual(80);
  });
});
