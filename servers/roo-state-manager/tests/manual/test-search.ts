import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { QdrantClient } from '@qdrant/js-client-rest';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function runSearchTest() {
  console.log('🚀 Starting Manual Search Test');
  console.log('----------------------------');

  if (!QDRANT_URL || !QDRANT_API_KEY || !OPENAI_API_KEY) {
    console.error('❌ Missing environment variables');
    return;
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const qdrant = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
    port: QDRANT_URL.startsWith('https') ? 443 : 6333,
  });

  try {
    // Check collection info
    const collectionInfo = await qdrant.getCollection(QDRANT_COLLECTION);
    console.log(`📊 Collection '${QDRANT_COLLECTION}' status:`, collectionInfo.status);
    console.log(`   Points count: ${collectionInfo.points_count}`);

    if (collectionInfo.points_count === 0) {
        console.warn('⚠️ Collection is empty. Indexing might have failed or not persisted.');
        return;
    }

    const query = "semantic search";
    console.log(`🔍 Searching for: "${query}"`);

    // Generate embedding for query
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const vector = embeddingResponse.data[0].embedding;

    // Search in Qdrant — #4808: client 1.20 removed search(); query({nearest})
    // returns { points }, so read .points for the array the loop below expects.
    const searchResponse = await qdrant.query(QDRANT_COLLECTION, {
      query: { nearest: vector },
      limit: 5,
      with_payload: true,
    });
    const searchResult = searchResponse.points ?? [];

    console.log(`✅ Found ${searchResult.length} results:`);
    searchResult.forEach((res, index) => {
      console.log(`\n[${index + 1}] Score: ${res.score}`);
      console.log(`    Task ID: ${res.payload?.task_id}`);
      const content = typeof res.payload?.content === 'string' ? res.payload.content : String(res.payload?.content || '');
      console.log(`    Content: ${content.substring(0, 100)}...`);
    });

  } catch (error) {
    console.error('❌ Search Failed:', error);
  }
}

runSearchTest().catch(console.error);