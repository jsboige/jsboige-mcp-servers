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

- **Unset list** → the legacy single `EMBEDDING_API_BASE_URL` path, unchanged
  (no wrapper, same timeout, same retries).
- **First entry is canonical** — it is the SDK `baseURL` and the host recorded
  in the supplement-index sentinel. A failover to another endpoint must never
  read as a model or endpoint switch.
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
