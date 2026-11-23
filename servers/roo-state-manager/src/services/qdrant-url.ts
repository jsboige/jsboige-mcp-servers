/**
 * #4880: the Qdrant URL this process actually dials.
 *
 * `localhost` is a host NAME: every cold connect resolves it with
 * `dns.lookup` → `getaddrinfo`, which runs on the libuv threadpool (4 threads
 * by default), and undici's 10 s connect timeout covers DNS *and* TCP. When
 * disk I/O (DriveFS, `fs.readFile`) saturates that threadpool, the lookup
 * does not return in time and the search fails with a "network" error
 * (`fetch failed` / UND_ERR_CONNECT_TIMEOUT) while Qdrant is healthy —
 * diagnosed on ai-01 18/09, back on 23/11 because the host env block of the
 * MCP launcher still carried `http://localhost:6333` (measured: 30.7 s
 * `qdrant_client_failure` in the live host, 0.1-0.7 s per query from a fresh
 * process on an IP literal, same minute, same build).
 *
 * An IP literal skips `dns.lookup` entirely, so `localhost` is dialled as
 * `127.0.0.1`. Every other host (LAN IP, public vhost, `[::1]`) is returned
 * unchanged. The original string form (path, trailing slash) is preserved.
 * Kill switch: `QDRANT_LOOPBACK_LITERAL=0` returns the configured URL as-is.
 */
export function effectiveQdrantUrl(raw: string | undefined): string | undefined {
    if (!raw || (process.env.QDRANT_LOOPBACK_LITERAL ?? '').trim() === '0') return raw;
    let hostname: string;
    try {
        hostname = new URL(raw).hostname;
    } catch {
        return raw;
    }
    if (hostname.toLowerCase() !== 'localhost') return raw;
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?)localhost(?=[:/?#]|$)/i, '$1127.0.0.1');
}
