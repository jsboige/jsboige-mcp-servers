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

    // Test direct avec fetch avant d'initialiser le client Qdrant
    testQdrantConnection();
    
    const qdrantConfig = {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      port: 443, // Force HTTPS port
      checkCompatibility: false,
    };
    
    client = new QdrantClient(qdrantConfig);
    console.log(`Qdrant client initialized with URL: ${process.env.QDRANT_URL}`);
  } else {
  }
  return client;
}

/**
 * Réinitialise le client Qdrant (utile après changement de configuration)
 */
export function resetQdrantClient(): void {
  client = null;
  console.log('Qdrant client reset.');
}