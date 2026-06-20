/**
 * #2628 regression suite — health-check masking Qdrant 503.
 *
 * Before this fix, `roosync_inventory(type: "health")` reported `Qdrant: OK` whenever
 * the QDRANT_* env vars were merely present, even while qdrant.myia.io returned HTTP 503
 * (or timed out / reset). The health verdict was derived from env-var PRESENCE, never a
 * live round-trip. These tests pin the corrected behavior:
 *
 *  1. probeQdrantBackend() returns true ONLY on a 2xx; 503 / 401 / 404 / network error /
 *     timeout / missing-URL all resolve to false.
 *  2. formatMarkdown() renders `Qdrant: FAIL (configured but unreachable)` when the probe
 *     failed — not `OK` — and `OK (configured + reachable)` when it succeeded.
 *
 * Regression of #2547 (same masking defect, previously only patched for embeddings).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeQdrantBackend, formatMarkdown, type HealthViewResult } from '../../../../src/tools/roosync/health-view.js';

const OLD_ENV = { ...process.env };

function mockFetch(impl: (url: string, init?: any) => Promise<any> | any) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(status: number) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
}

describe('#2628 probeQdrantBackend — live reachability, not env-var presence', () => {
  beforeEach(() => {
    process.env.QDRANT_URL = 'https://qdrant.myia.io';
    process.env.QDRANT_API_KEY = 'test-key';
    process.env.QDRANT_HEALTH_PROBE_TIMEOUT_MS = '500';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
  });

  it('returns true on HTTP 200', async () => {
    mockFetch(() => jsonResponse(200));
    await expect(probeQdrantBackend()).resolves.toBe(true);
  });

  it('returns FALSE on HTTP 503 (the masked-outage case)', async () => {
    mockFetch(() => jsonResponse(503));
    await expect(probeQdrantBackend()).resolves.toBe(false);
  });

  it('returns FALSE on HTTP 401 (auth failure)', async () => {
    mockFetch(() => jsonResponse(401));
    await expect(probeQdrantBackend()).resolves.toBe(false);
  });

  it('returns FALSE on HTTP 404', async () => {
    mockFetch(() => jsonResponse(404));
    await expect(probeQdrantBackend()).resolves.toBe(false);
  });

  it('returns FALSE on a thrown network error (ECONNRESET / fetch failed)', async () => {
    mockFetch(() => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); });
    await expect(probeQdrantBackend()).resolves.toBe(false);
  });

  it('returns FALSE on timeout / abort', async () => {
    mockFetch(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError')));
    await expect(probeQdrantBackend()).resolves.toBe(false);
  });

  it('returns FALSE when QDRANT_URL is unset, without calling fetch', async () => {
    delete process.env.QDRANT_URL;
    const f = vi.fn(() => jsonResponse(200));
    vi.stubGlobal('fetch', f);
    await expect(probeQdrantBackend()).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('sends the api-key header to GET /collections', async () => {
    const f = vi.fn(() => jsonResponse(200));
    vi.stubGlobal('fetch', f);
    await probeQdrantBackend();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://qdrant.myia.io/collections');
    expect(init.method).toBe('GET');
    expect(init.headers['api-key']).toBe('test-key');
  });
});

describe('#2628 formatMarkdown — Qdrant verdict reflects reachability', () => {
  function baseResult(qdrant: boolean, qdrantReachable?: boolean): HealthViewResult {
    return {
      status: 'HEALTHY',
      score: 100,
      timestamp: '2026-06-20T00:00:00.000Z',
      localMachine: 'myia-ai-01',
      systemHealth: { machinesOnline: 6, machinesUnknown: 0, machinesTotal: 6, flags: [] },
      capabilities: { sharedPath: true, qdrant, embeddings: true, embeddingsReachable: true, qdrantReachable },
      drift: { checked: false, baselineSource: '', critical: 0, important: 0, warning: 0, info: 0, items: [] },
      envCheck: { checked: false, missing: [], present: [] },
      recommendations: [],
    };
  }

  it('renders FAIL when configured but unreachable (probe false) — NOT OK', () => {
    const md = formatMarkdown(baseResult(true, false));
    expect(md).toContain('Qdrant: FAIL (configured but unreachable)');
    expect(md).not.toContain('Qdrant: OK (configured + reachable)');
  });

  it('renders OK when configured and reachable (probe true)', () => {
    const md = formatMarkdown(baseResult(true, true));
    expect(md).toContain('Qdrant: OK (configured + reachable)');
  });

  it('renders MISSING when not configured', () => {
    const md = formatMarkdown(baseResult(false, false));
    expect(md).toContain('Qdrant: MISSING (not configured)');
  });
});
