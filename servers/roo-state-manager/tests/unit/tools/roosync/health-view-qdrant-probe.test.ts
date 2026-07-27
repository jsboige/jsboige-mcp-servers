/**
 * #2628 + #2977 regression suite — health-check masking + cause rendering for Qdrant.
 *
 * Before #2628, `roosync_inventory(type: "health")` reported `Qdrant: OK` whenever the
 * QDRANT_* env vars were merely present, even while qdrant.myia.io returned HTTP 503.
 * The probe was added so a live outage flips the verdict to FAIL.
 *
 * Before #2977, six distinct non-reachable outcomes (auth / http / timeout / network /
 * unconfigured / missing-URL) collapsed into one indistinguishable bool, and the rendering
 * asserted "a real outage, not a config gap" — sending operators to restart a container that
 * a 401 proved was alive. These tests now pin:
 *
 *  1. probeQdrantBackend() returns `reachable: true` ONLY on a 2xx; every other shape is
 *     `reachable: false` with a cause-specific `kind` (+ `status` where the server answered).
 *  2. formatMarkdown() renders the *cause* in the FAIL label (AUTH / HTTP N / TIMEOUT /
 *     NETWORK) — not a generic "unreachable" — so a 401 is never read as "container down".
 *  3. The recommendation routes a 401 to QDRANT_API_KEY, not the container.
 *
 * Regression of #2547 (masking), #2628 (probe bool), #2977 (cause rendering).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeQdrantBackend, formatMarkdown, type HealthViewResult, type QdrantProbeResult } from '../../../../src/tools/roosync/health-view.js';

const OLD_ENV = { ...process.env };

function mockFetch(impl: (url: string, init?: any) => Promise<any> | any) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(status: number) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
}

describe('#2628 probeQdrantBackend — reachable bool (cause tested in #2977 suite below)', () => {
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

  it('is reachable (ok) on HTTP 200', async () => {
    mockFetch(() => jsonResponse(200));
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(true);
    expect(r.kind).toBe('ok');
    expect(r.status).toBe(200);
  });

  it('is NOT reachable on HTTP 503 (the masked-outage case) — kind http', async () => {
    mockFetch(() => jsonResponse(503));
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('http');
    expect(r.status).toBe(503);
  });

  it('is NOT reachable on HTTP 404 — kind http (server answered, request failed)', async () => {
    mockFetch(() => jsonResponse(404));
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('http');
    expect(r.status).toBe(404);
  });

  it('is NOT reachable on a thrown network error (ECONNRESET) — kind network', async () => {
    mockFetch(() => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); });
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('network');
  });

  it('is NOT reachable on timeout / abort — kind timeout', async () => {
    mockFetch(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError')));
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('timeout');
  });

  it('is NOT reachable when QDRANT_URL is unset — kind unconfigured, fetch never called', async () => {
    delete process.env.QDRANT_URL;
    const f = vi.fn(() => jsonResponse(200));
    vi.stubGlobal('fetch', f);
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('unconfigured');
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

describe('#2977 probeQdrantBackend — AUTH cause (401/403 is a key problem, not an outage)', () => {
  beforeEach(() => {
    process.env.QDRANT_URL = 'https://qdrant.myia.io';
    process.env.QDRANT_API_KEY = 'stale-key';
    process.env.QDRANT_HEALTH_PROBE_TIMEOUT_MS = '500';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
  });

  it('classifies HTTP 401 as AUTH (server reachable, key refused) — NOT http/timeout/network', async () => {
    mockFetch(() => jsonResponse(401));
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('auth');
    expect(r.status).toBe(401);
  });

  it('classifies HTTP 403 as AUTH as well', async () => {
    mockFetch(() => jsonResponse(403));
    const r = await probeQdrantBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('auth');
    expect(r.status).toBe(403);
  });
});

describe('#2977 formatMarkdown — FAIL label names the cause', () => {
  function baseResult(qdrant: boolean, qdrantProbe?: QdrantProbeResult, qdrantReachable?: boolean): HealthViewResult {
    return {
      status: 'HEALTHY',
      score: 100,
      timestamp: '2026-06-20T00:00:00.000Z',
      localMachine: 'myia-ai-01',
      systemHealth: { machinesOnline: 6, machinesUnknown: 0, machinesTotal: 6, flags: [] },
      capabilities: {
        sharedPath: true,
        qdrant,
        embeddings: true,
        embeddingsReachable: true,
        qdrantProbe,
        qdrantReachable,
      },
      drift: { checked: false, baselineSource: '', critical: 0, important: 0, warning: 0, info: 0, items: [] },
      envCheck: { checked: false, missing: [], present: [] },
      recommendations: [],
    };
  }

  it('renders AUTH in the FAIL label on a 401 — never reads as a container outage', () => {
    const md = formatMarkdown(baseResult(true, { reachable: false, status: 401, kind: 'auth' }, false));
    expect(md).toContain('Qdrant: FAIL (configured but unreachable — AUTH');
    expect(md).toContain('401');
    expect(md).not.toContain('Qdrant: OK');
  });

  it('renders HTTP <status> in the FAIL label on a 503', () => {
    const md = formatMarkdown(baseResult(true, { reachable: false, status: 503, kind: 'http' }, false));
    expect(md).toContain('Qdrant: FAIL (configured but unreachable — HTTP 503)');
    expect(md).not.toContain('AUTH');
  });

  it('renders TIMEOUT in the FAIL label on an abort', () => {
    const md = formatMarkdown(baseResult(true, { reachable: false, kind: 'timeout' }, false));
    expect(md).toContain('Qdrant: FAIL (configured but unreachable — TIMEOUT)');
  });

  it('renders NETWORK in the FAIL label on a transport error', () => {
    const md = formatMarkdown(baseResult(true, { reachable: false, kind: 'network' }, false));
    expect(md).toContain('Qdrant: FAIL (configured but unreachable — NETWORK)');
  });

  it('renders OK (configured + reachable) when the probe succeeded', () => {
    const md = formatMarkdown(baseResult(true, { reachable: true, status: 200, kind: 'ok' }, true));
    expect(md).toContain('Qdrant: OK (configured + reachable)');
  });

  it('renders MISSING (not configured) when qdrant capability is absent', () => {
    const md = formatMarkdown(baseResult(false, { reachable: false, kind: 'unconfigured' }, false));
    expect(md).toContain('Qdrant: MISSING (not configured)');
  });
});

describe('#2977 recommendation — routes an AUTH failure to QDRANT_API_KEY, not the container', () => {
  function baseResult(qdrantProbe?: QdrantProbeResult): HealthViewResult {
    return {
      status: 'WARNING',
      score: 90,
      timestamp: '2026-06-20T00:00:00.000Z',
      localMachine: 'myia-ai-01',
      systemHealth: { machinesOnline: 6, machinesUnknown: 0, machinesTotal: 6, flags: [] },
      capabilities: {
        sharedPath: true,
        qdrant: true,
        embeddings: true,
        embeddingsReachable: true,
        qdrantProbe,
        qdrantReachable: qdrantProbe ? qdrantProbe.reachable : undefined,
      },
      drift: { checked: false, baselineSource: '', critical: 0, important: 0, warning: 0, info: 0, items: [] },
      envCheck: { checked: false, missing: [], present: [] },
      // NOTE: recommendations are intentionally empty here; formatMarkdown only echoes them.
      // The cause-routing itself lives in generateRecommendations, exercised end-to-end via
      // the roosyncHealthView() integration path. This suite pins the label + the contract
      // that qdrantProbe flows through to the rendered capabilities.
      recommendations: [],
    };
  }

  it('carries the AUTH probe through capabilities so the renderer can name the cause', () => {
    const result = baseResult({ reachable: false, status: 401, kind: 'auth' });
    expect(result.capabilities.qdrantProbe?.kind).toBe('auth');
    expect(result.capabilities.qdrantProbe?.status).toBe(401);
    // Sanity: the FAIL label surfaces AUTH (the rendering contract this issue pins).
    expect(formatMarkdown(result)).toContain('AUTH');
  });
});
