import { QdrantClient } from '@qdrant/js-client-rest';

let client: QdrantClient | null = null;

/**
 * Test direct de la connexion à l'API Qdrant via fetch
 */
async function testQdrantConnection(): Promise<void> {
  const url = `${process.env.QDRANT_URL}/collections`;
  const apiKey = process.env.QDRANT_API_KEY;
  
  console.log(`DEBUG: Testing direct connection to: ${url}`);
  console.log(`DEBUG: API Key present: ${!!apiKey}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'api-key': apiKey || '',
        'Content-Type': 'application/json',
      },
    });
    
    console.log(`DEBUG: Direct fetch response status: ${response.status}`);
    const data = await response.json();
    console.log(`DEBUG: Direct fetch response data:`, JSON.stringify(data, null, 2));
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
    console.log(`DEBUG: Creating Qdrant client with URL: ${process.env.QDRANT_URL}`);
    console.log(`DEBUG: QDRANT_API_KEY present: ${!!process.env.QDRANT_API_KEY}`);
    
    // Test direct avec fetch avant d'initialiser le client Qdrant
    testQdrantConnection();
    
    const qdrantConfig = {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
      port: 443, // Force HTTPS port
      checkCompatibility: false,
    };
    
    console.log(`DEBUG: Qdrant config:`, JSON.stringify(qdrantConfig, null, 2));
    
    client = new QdrantClient(qdrantConfig);
    console.log(`Qdrant client initialized with URL: ${process.env.QDRANT_URL}`);
  } else {
    console.log(`DEBUG: Reusing existing Qdrant client`);
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