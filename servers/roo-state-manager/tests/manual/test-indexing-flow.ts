import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { QdrantClient } from '@qdrant/js-client-rest';
import OpenAI from 'openai';
import { indexTask } from '../../src/services/task-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TASK_ID = 'test-task-123';
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/test-task-123');

async function runTest() {
  console.log('🚀 Starting Manual Indexing Flow Test');
  console.log('-----------------------------------');

  // 1. Validate OpenAI Connection
  console.log('\n1️⃣ Testing OpenAI Connection...');
  if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is missing');
    return;
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const embedding = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'Test embedding',
    });
    console.log('✅ OpenAI Connection Successful');
    console.log(`   Embedding dimension: ${embedding.data[0].embedding.length}`);
  } catch (error) {
    console.error('❌ OpenAI Connection Failed:', error);
    return;
  }

  // 2. Validate Qdrant Connection
  console.log('\n2️⃣ Testing Qdrant Connection...');
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.error('❌ QDRANT_URL or QDRANT_API_KEY is missing');
    return;
  }
  console.log(`   URL: ${QDRANT_URL}`);

  try {
    const qdrant = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY,
      port: QDRANT_URL.startsWith('https') ? 443 : 6333,
    });
    const collections = await qdrant.getCollections();
    console.log('✅ Qdrant Connection Successful');
    console.log(`   Collections: ${collections.collections.map(c => c.name).join(', ')}`);

    // Check if collection exists
    const exists = collections.collections.some(c => c.name === QDRANT_COLLECTION);
    if (!exists) {
        console.warn(`⚠️ Collection '${QDRANT_COLLECTION}' does not exist. It should be created by the indexer.`);
    } else {
        console.log(`   Collection '${QDRANT_COLLECTION}' found.`);
        const info = await qdrant.getCollection(QDRANT_COLLECTION);
        console.log(`   Points count: ${info.points_count}`);
    }

  } catch (error) {
    console.error('❌ Qdrant Connection Failed:', error);
    return;
  }

  // 3. Test Task Indexing Logic
  console.log('\n3️⃣ Testing Task Indexing Logic...');
  try {
    console.log(`   Indexing fixture task ${TASK_ID} from ${FIXTURE_PATH}...`);

    // Call the standalone indexTask function directly with the fixture path
    const result = await indexTask(TASK_ID, FIXTURE_PATH);

    if (result && result.length > 0) {
        console.log(`✅ Indexing reported success: ${result.length} points indexed`);
    } else {
        console.error('❌ Indexing reported failure or no points indexed');
    }

  } catch (error) {
    console.error('❌ Task Indexing Failed:', error);
    // Print full stack trace
    if (error instanceof Error) {
        console.error(error.stack);
    }
  }
}

runTest().catch(console.error);