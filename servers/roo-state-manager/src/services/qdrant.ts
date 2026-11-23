import { QdrantClient } from '@qdrant/js-client-rest';
import { effectiveQdrantUrl } from './qdrant-url.js';

let client: QdrantClient | null = null;

/**
 * Test direct de la connexion à l'API Qdrant via fetch
 */
async function testQdrantConnection(): Promise<void> {
  const url = `${process.env.QDRANT_URL}/collections`;
  const apiKey = process.env.QDRANT_API_KEY;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'api-key': apiKey || '',
        'Content-Type': 'application/json',
      },
    });
    
    const data = await response.json();
  } catch (error) {
    console.error(`DEBUG: Direct fetch failed:`, error);
  }
}

/**
 * Implémente un singleton pour le client Qdrant afin de garantir
 * qu'il n'est instancié qu'une seule fois et à la demande (lazy initialization).
 * Ceci est crucial pour l'environnement de test, afin de s'assurer que le
 * polyfill 'fetch' est déjà en place avant l'instanciation.
 * @returns {QdrantClient} L'instance du client Qdrant.
 */
export function getQdrantClient(options: { timeoutMs?: number } = {}): QdrantClient {
  // #4880: the client aborts every request at its own `timeout` — the per-call
  // `timeout` of query()/scroll() is a SERVER-side budget and cannot extend it.
  // A caller that hands the server a longer budget than QDRANT_TIMEOUT_MS asks
  // for a client whose abort sits above that budget; otherwise the server-side
  // budget is dead (measured ai-01 23/11: searches of 15-30 s cut at 15 s).
  // #831: timeout to prevent hanging on large collections
  // #851: 15s default, configurable via env for 10M+ vector collection
  const baseTimeoutMs = parseInt(process.env.QDRANT_TIMEOUT_MS || '15000');
  const wanted = options.timeoutMs;
  if (typeof wanted === 'number' && Number.isFinite(wanted) && wanted > baseTimeoutMs) {
    const existing = extendedClients.get(wanted);
    if (existing) return existing;
    const extended = new QdrantClient({ ...baseQdrantConfig(), timeout: wanted });
    extendedClients.set(wanted, extended);
    return extended;
  }
  if (!client) {
    const qdrantConfig = { ...baseQdrantConfig(), timeout: baseTimeoutMs };

    client = new QdrantClient(qdrantConfig);
    console.log(`Qdrant client initialized with URL: ${qdrantConfig.url}, timeout: ${qdrantConfig.timeout}ms`);
  }
  return client;
}

/** #4880: clients whose abort budget exceeds QDRANT_TIMEOUT_MS, keyed by that budget. */
const extendedClients = new Map<number, QdrantClient>();

function baseQdrantConfig() {
  return {
    // #4880: `localhost` is dialled as 127.0.0.1 — no getaddrinfo on the libuv
    // threadpool, so disk I/O can no longer turn into a connect timeout.
    url: effectiveQdrantUrl(process.env.QDRANT_URL),
    apiKey: process.env.QDRANT_API_KEY,
    port: 443, // Force HTTPS port
    // #4808: client/server version gap must be visible — was false since the
    // 1.16 pin while the fleet server moved to 1.20.0, hiding 4 minor versions
    // of drift. Re-enabled now that the client is aligned on the server line.
    checkCompatibility: true,
  };
}

/**
 * Réinitialise le client Qdrant (utile après changement de configuration)
 */
/**
 * Reset the Qdrant client (utile après changement de configuration)
 */
export function resetQdrantClient(): void {
  client = null;
  extendedClients.clear();
  console.log('Qdrant client reset.');
}

/**
 * Get collection size information
 * @returns Number of points count or */
export async function getCollectionSize(): Promise<number> {
  const qdrant = getQdrantClient();
  const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

  try {
    const collection = await qdrant.getCollection(collectionName);
    return collection?.points_count || 0;
  } catch {
    return 1; // Default to 1 if we fails
  }
}

/**
 * Check if collection is large (>5M vectors)
 * Used to warn users about potential slow searches
 */
export async function isLargeCollection(): Promise<boolean> {
  const size = await getCollectionSize();
  return size > 5_000_000;
}