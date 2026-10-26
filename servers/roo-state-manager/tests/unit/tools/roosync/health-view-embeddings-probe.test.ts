/**
 * #1518 regression suite — unbounded embeddings probe stalled the whole health call.
 *
 * Before #1518, `probeEmbeddingBackend()` awaited `openai.embeddings.create` with no
 * timeout, and `roosyncHealthView()` awaited it unconditionally in its `Promise.all`.
 * A backend that accepted the TCP connection but never answered (measured 2026-10-25:
 * embeddings.myia.io socket held open, `roosync_inventory(type: "health")` mute for
 * 60 s+ on four seats while `type: "status"` answered in 316 ms) stalled the entire
 * health call until the MCP layer gave up. The Qdrant probe was already bounded
 * (QDRANT_HEALTH_PROBE_TIMEOUT_MS); the embeddings probe now mirrors it
 * (EMBEDDINGS_HEALTH_PROBE_TIMEOUT_MS). These tests pin:
 *
 *  1. probeEmbeddingBackend() RESOLVES (never hangs) when the backend never answers —
 *     `reachable: false, kind: 'timeout'` within the bound, signal forwarded to the SDK.
 *  2. ok / error / unconfigured classification (mirrors the Qdrant kinds).
 *  3. formatMarkdown() renders the *cause* in the DEGRADED label — a TIMEOUT is not
 *     read as an HTTP failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeEmbeddingBackend, formatMarkdown, type HealthViewResult, type EmbeddingProbeResult } from '../../../../src/tools/roosync/health-view.js';

const OLD_ENV = { ...process.env };

// Client-construction flag: flip to make getOpenAIClient() throw (unconfigured seat).
let ctorThrows = false;
const mockEmbeddingsCreate = vi.fn();

vi.mock('../../../../src/services/openai.js', () => ({
  default: () => {
    if (ctorThrows) throw new Error('StateManagerError: EMBEDDING_API_KEY not set');
    return { embeddings: { create: mockEmbeddingsCreate } };
  },
  // #4352 (a5): the embeddings probe uses the interactive (query) client, so the
  // unconfigured-seat case must throw from here too.
  getEmbeddingQueryClient: () => {
    if (ctorThrows) throw new Error('StateManagerError: EMBEDDING_API_KEY not set');
    return { embeddings: { create: mockEmbeddingsCreate } };
  },
  getEmbeddingModel: () => 'test-embed-model',
}));

/** embeddings.create that accepts the request, then never answers until aborted. */
function hangUntilAborted() {
  mockEmbeddingsCreate.mockImplementation(
    (_params: unknown, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      })
  );
}

describe('#1518 probeEmbeddingBackend — bounded on a hung backend (the regression)', () => {
  beforeEach(() => {
    process.env.EMBEDDINGS_HEALTH_PROBE_TIMEOUT_MS = '100';
    ctorThrows = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
  });

  it('RESOLVES with kind timeout when the backend never answers — the health call is no longer hostage', async () => {
    hangUntilAborted();
    const started = Date.now();
    const r = await probeEmbeddingBackend();
    const elapsed = Date.now() - started;
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('timeout');
    // The bound did the work: resolved near the 100 ms timeout, not at a test-runner timeout.
    expect(elapsed).toBeLessThan(2000);
  });

  it('forwards an AbortSignal to embeddings.create — the bound is wired into the request', async () => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    await probeEmbeddingBackend();
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    const opts = mockEmbeddingsCreate.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults the bound to 8000 ms when the env var is unset', async () => {
    delete process.env.EMBEDDINGS_HEALTH_PROBE_TIMEOUT_MS;
    hangUntilAborted();
    const r = await probeEmbeddingBackend();
    // The 8 s default is too long to wait in a test; the timeout kind proves the
    // bound fired, and hangUntilAborted only ever resolves via abort.
    expect(r.kind).toBe('timeout');
  }, 10_000);
});

describe('#1518 probeEmbeddingBackend — ok / error / unconfigured classification', () => {
  beforeEach(() => {
    process.env.EMBEDDINGS_HEALTH_PROBE_TIMEOUT_MS = '500';
    ctorThrows = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
  });

  it('is reachable (ok) when a non-empty vector comes back', async () => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const r = await probeEmbeddingBackend();
    expect(r.reachable).toBe(true);
    expect(r.kind).toBe('ok');
  });

  it('is NOT reachable (error) when the backend answers with a failure', async () => {
    mockEmbeddingsCreate.mockRejectedValue(new Error('500 Internal Server Error'));
    const r = await probeEmbeddingBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('error');
  });

  it('is NOT reachable (error) on an answered-but-empty embedding — kind error, not ok', async () => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [] }] });
    const r = await probeEmbeddingBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('error');
  });

  it('is NOT reachable (unconfigured) when the client cannot even be constructed', async () => {
    ctorThrows = true;
    const r = await probeEmbeddingBackend();
    expect(r.reachable).toBe(false);
    expect(r.kind).toBe('unconfigured');
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });
});

describe('#1518 formatMarkdown — DEGRADED label names the cause', () => {
  function baseResult(embeddings: boolean, embeddingsReachable: boolean | undefined, embeddingsProbe?: EmbeddingProbeResult): HealthViewResult {
    return {
      status: 'HEALTHY',
      score: 100,
      timestamp: '2026-10-25T00:00:00.000Z',
      localMachine: 'myia-po-2028',
      systemHealth: { machinesOnline: 7, machinesUnknown: 0, machinesTotal: 7, flags: [] },
      capabilities: {
        sharedPath: true,
        qdrant: true,
        embeddings,
        embeddingsReachable,
        embeddingsProbe,
      },
      drift: { checked: false, driftSource: 'myia-test-machine', driftTarget: '', driftTargetSelection: 'registry-default' as const, critical: 0, important: 0, warning: 0, info: 0, items: [] },
      envCheck: { checked: false, missing: [], present: [] },
      recommendations: [],
    };
  }

  it('renders TIMEOUT in the DEGRADED label on a bounded hang — not read as an HTTP failure', () => {
    const md = formatMarkdown(baseResult(true, false, { reachable: false, kind: 'timeout' }));
    expect(md).toContain('Embeddings: DEGRADED (configured but unreachable — TIMEOUT)');
  });

  it('renders ERROR in the DEGRADED label on an answered failure', () => {
    const md = formatMarkdown(baseResult(true, false, { reachable: false, kind: 'error' }));
    expect(md).toContain('Embeddings: DEGRADED (configured but unreachable — ERROR)');
  });

  it('keeps the legacy label (no cause suffix) when only the bool is present — backward compatible', () => {
    const md = formatMarkdown(baseResult(true, false));
    expect(md).toContain('Embeddings: DEGRADED (configured but unreachable)');
    expect(md).not.toContain('TIMEOUT');
  });

  it('renders OK (configured + reachable) when the probe succeeded', () => {
    const md = formatMarkdown(baseResult(true, true, { reachable: true, kind: 'ok' }));
    expect(md).toContain('Embeddings: OK (configured + reachable)');
  });
});
