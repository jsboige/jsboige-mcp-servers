import { QdrantClient } from '@qdrant/js-client-rest';

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
export function getQdrantClient(): QdrantClient {
  if (!client) {
    const qdrantConfig = {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      port: 443, // Force HTTPS port
      checkCompatibility: false,
      // #831: Add timeout to prevent hanging on large collections
      // #851: Reduced default to 15s for faster failure detection
      timeout: parseInt(process.env.QDRANT_TIMEOUT_MS || '15000'), // 15s default, configurable
    };

    client = new QdrantClient(qdrantConfig);
    console.log(`Qdrant client initialized with URL: ${process.env.QDRANT_URL}, timeout: ${qdrantConfig.timeout}ms`);
  }
  return client;
}

/**
 * Réinitialise le client Qdrant (utile après changement de configuration)
 */
/**
 * Reset the Qdrant client (utile après changement de configuration)
 */
export function resetQdrantClient(): void {
  client = null;
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