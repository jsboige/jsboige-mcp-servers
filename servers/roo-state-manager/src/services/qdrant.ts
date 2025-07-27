// import { QdrantClient } from '@qdrant/js-client-rest';
//
// let client: QdrantClient | null = null;
//
// /**
//  * Implémente un singleton pour le client Qdrant afin de garantir
//  * qu'il n'est instancié qu'une seule fois et à la demande (lazy initialization).
//  * Ceci est crucial pour l'environnement de test, afin de s'assurer que le
//  * polyfill 'fetch' est déjà en place avant l'instanciation.
//  * @returns {QdrantClient} L'instance du client Qdrant.
//  */
// export function getQdrantClient(): QdrantClient {
//   if (!client) {
//     client = new QdrantClient({
//       url: process.env.QDRANT_URL,
//       apiKey: process.env.QDRANT_API_KEY,
//       checkCompatibility: false,
//     });
//     console.log('Qdrant client initialized.');
//   }
//   return client;
// }