# Embedding endpoint failover (#4352 a5)

**Why.** On 25/10/2026 `https://embeddings.myia.io` hung from 16:10Z while the
LAN backend `http://192.168.0.46:8004` kept answering. Every embedding call spent
its 60 s timeout plus one SDK retry on the dead vhost before degrading, so
`codebase_search` and `roosync_search semantic` were unusable for six hours even
though a healthy endpoint existed on the LAN.

**What.** Both embedding factories — `services/openai.ts` (task indexer,
semantic search, health) and `services/code-index/embedding-client.ts`
(codebase index/search) — consume the same ordered endpoint plan and the same
failover `fetch` (`services/embedding-endpoints.ts`).

## Configuration

```dotenv
# Ordered list, comma-separated. FIRST entry is canonical.
EMBEDDING_API_BASE_URLS=http://192.168.0.46:8004/v1,https://embeddings.myia.io/v1

# Interactive query clients (defaults shown)
EMBEDDING_QUERY_ATTEMPT_TIMEOUT_MS=6000
EMBEDDING_QUERY_BUDGET_MS=12000
EMBEDDING_NEGATIVE_CACHE_MS=30000
```

- **Unset list** → the single `EMBEDDING_API_BASE_URL`. A NON-public base is the
  legacy path, unchanged (no wrapper, same timeout, same retries). A public-vhost
  base gains the LAN-direct entry first (see **LAN-direct default** below).
- **First entry is canonical** — the FIRST entry of the CONFIGURED list is the SDK
  `baseURL` and the host recorded in the supplement-index sentinel. A failover (or
  the LAN-direct insertion) must never read as a model or endpoint switch: the
  fingerprint stays the configured canonical host.
- **Same vector space** — every endpoint must return `EMBEDDING_DIMENSIONS`.
  An endpoint with another dimension is refused for the life of the client.
- **Transport/5xx only** — connection error, DNS failure, timeout and HTTP 5xx
  move to the next endpoint. A 4xx (401/403/404/429, malformed request) is the
  endpoint answering, and is returned immediately. 429 is deliberately *not* a
  failover trigger: it is a 4xx, and the fleet rate limiter owns that regime.
- **Interactive budget** — query clients try each endpoint for at most 6 s and
  the whole call for at most 12 s; a fully dead list degrades in under 15 s.
  Background indexing keeps the 60 s-per-attempt ceiling it needs under load.
- **Negative cache** — a transport/5xx failure removes the endpoint from
  rotation for 30 s, so repeated searches do not re-pay the timeout.

## LAN-direct default (#4395)

When the canonical endpoint is the public vhost `embeddings.myia.io`, the plan
tries a LAN-direct backend FIRST so the fleet skips the IIS hop and its Windows
11 Pro 10-connection cap (RX126: 41–51 s via the vhost vs 14–33 ms direct):

```dotenv
# Default LAN target (tried first when the canonical is the public vhost)
# EMBEDDING_LAN_DIRECT_URL=http://myia-po-2023:8004/v1
# Kill-switch: '0' → public vhost only (the pre-#4395 plan, byte-for-byte)
# EMBEDDING_LAN_DIRECT=0
```

- **Transport-only** — the SDK `baseURL`, the `canonicalBaseURL` and the
  supplement fingerprint all stay the public vhost, so **no collection is
  rebuilt**. Only the try order changes: `[LAN, public]`.
- **Kill-switch** — `EMBEDDING_LAN_DIRECT=0` (the only off spelling) restores the
  public-only plan. Both variables are hot-reloadable (`config-reload.ts`).
- **Malformed override** — an invalid `EMBEDDING_LAN_DIRECT_URL` falls back to the
  default LAN target (NOT public-only) with a warn, so a typo never takes down the
  vhost path.
- **Non-public canonical** — a custom `EMBEDDING_API_BASE_URL` is left untouched.
- **Served-by log** — the first successful call logs once, at **info** (not warn),
  which endpoint served it (host only): `first successful call served by <host>`.

## Deployment

`EMBEDDING_API_BASE_URLS` and the timing keys are host-owned (MCP env in
`~/.claude.json`). A change needs an MCP **respawn**; `roosync_diagnose reload`
only covers `.env`-managed keys.

## Acceptance probes

1. LAN seat, proxy dead, LAN up: `codebase_search` and
   `roosync_search semantic` answer from vectors in < 15 s.
2. Every endpoint dead: both degrade visibly in < 15 s with
   `All embedding endpoints unavailable (...)`.
3. A 401 from the first endpoint does not produce a second HTTP request.
