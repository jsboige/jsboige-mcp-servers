import { QdrantClient } from '@qdrant/js-client-rest';
import openaiClient from './openai.js';
import { getQdrantClient } from './qdrant.js';

// Définit la structure d'un résultat de recherche de tâche
export interface TaskSearchResult {
  id: string;
  score: number;
  payload?: {
    task_id?: string;
    [key: string]: any;
  };
}

/**
 * Recherche sémantiquement des tâches en fonction d'une requête textuelle.
 * 
 * @param query La requête de recherche en langage naturel.
 * @param options Options de filtrage, comme les dates de début et de fin.
 * @returns Une liste de résultats de recherche de tâches.
 */
export async function searchTasks(
  query: string,
  options: {
    startDate?: string;
    endDate?: string;
    limit?: number;
  } = {}
): Promise<TaskSearchResult[]> {
  
  const openai = openaiClient;
  const qdrant = getQdrantClient();
  const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

  // 1. Vectoriser la requête
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const vector = embeddingResponse.data[0].embedding;

  if (!vector) {
    throw new Error('Failed to create an embedding for the query.');
  }

  // 2. Construire le filtre Qdrant
  const filter: any = {
    must: [],
  };

  if (options.startDate || options.endDate) {
    const range: any = {};
    if (options.startDate) {
      range.gte = new Date(options.startDate).getTime();
    }
    if (options.endDate) {
      range.lte = new Date(options.endDate).getTime();
    }
    filter.must.push({
      key: 'timestamp',
      range,
    });
  }

  // 3. Interroger Qdrant
  try {
    const searchResult = await qdrant.search(collectionName, {
      vector,
      limit: options.limit || 10,
      filter: filter.must.length > 0 ? filter : undefined,
      with_payload: true,
    });
    
    // 4. Formater les résultats
    return searchResult.map((result) => ({
      id: result.id.toString(),
      score: result.score,
      payload: result.payload as TaskSearchResult['payload'],
    }));

  } catch (error) {
    console.error('Error searching Qdrant:', error);
    // Gérer les erreurs, par exemple si la collection n'existe pas
    return [];
  }
}