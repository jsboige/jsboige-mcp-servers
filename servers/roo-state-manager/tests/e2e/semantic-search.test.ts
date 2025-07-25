console.log('QDRANT_URL in test worker:', process.env.QDRANT_URL);
console.log('QDRANT_API_KEY in test worker:', process.env.QDRANT_API_KEY);
import { indexTask } from '../../src/services/task-indexer.js';
import { searchTasks, TaskSearchResult } from '../../src/services/task-searcher.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getQdrantClient } from '../../src/services/qdrant.js';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';

const TEST_STORAGE_PATH = path.join(__dirname, 'test-storage');
const QDRANT_COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME;

// @ts-ignore
RooStorageDetector.customStoragePath = TEST_STORAGE_PATH;

const createMockConversation = async (taskId: string, content: any) => {
    const taskDir = path.join(TEST_STORAGE_PATH, 'tasks', taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const filePath = path.join(taskDir, 'messages.json');
    await fs.writeFile(filePath, JSON.stringify(content));
    return filePath;
};

const waitForPointInCollection = async (pointId: string, timeout = 10000, interval = 500) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            if (!QDRANT_COLLECTION_NAME) throw new Error('QDRANT_COLLECTION_NAME is not defined');
            const result = await getQdrantClient().retrieve(QDRANT_COLLECTION_NAME, { ids: [pointId] });
            if (result && result.length > 0) {
                console.log(`Point ${pointId} found in collection.`);
                return;
            }
        } catch (error) {
            // Point not found yet, continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Timeout waiting for point ${pointId} to appear in collection.`);
}

describe('Recherche sémantique E2E', () => {

    beforeAll(async () => {
        if (!QDRANT_COLLECTION_NAME) {
            throw new Error("La variable d'environnement QDRANT_COLLECTION_NAME doit être définie.");
        }
        
        await fs.mkdir(path.join(TEST_STORAGE_PATH, 'tasks'), { recursive: true });
        
        try {
            const qdrant = getQdrantClient();
            await qdrant.getCollection(QDRANT_COLLECTION_NAME);
            console.log('Ancienne collection de test trouvée, suppression...');
            await qdrant.deleteCollection(QDRANT_COLLECTION_NAME);
            console.log('Ancienne collection de test supprimée.');
        } catch (error) {
            console.warn(`Impossible de nettoyer la collection Qdrant, elle n'existe peut-être pas encore.`);
        }
    }, 30000);

    afterAll(async () => {
        await fs.rm(TEST_STORAGE_PATH, { recursive: true, force: true });
        if (QDRANT_COLLECTION_NAME) {
            try {
                await getQdrantClient().deleteCollection(QDRANT_COLLECTION_NAME);
                 console.log('Collection de test supprimée après les tests.');
            } catch (error) {
                console.warn(`Impossible de supprimer la collection Qdrant après les tests : ${error}`);
            }
        }
    }, 30000);

    test('devrait indexer une tâche et la retrouver via une recherche sémantique', async () => {
        const taskId = 'test-task-e2e-123';
        const conversationContent = [
            { role: 'user', content: 'Peux-tu me créer un site web simple pour un restaurant ?' },
            { role: 'assistant', content: 'Bien sûr, quel type de cuisine propose le restaurant ?' }
        ];
        const conversationPath = await createMockConversation(taskId, conversationContent);

        const indexedPoint = await indexTask(taskId, conversationPath);
        expect(indexedPoint).toBeDefined();

        await waitForPointInCollection(indexedPoint.id as string);

        const query = 'Chercher une tâche sur la création d\'un site pour un restaurant';
        const searchResults: TaskSearchResult[] = await searchTasks(query);

        expect(searchResults).toBeDefined();
        expect(searchResults.length).toBeGreaterThan(0);
        
        const foundTask = searchResults.find(r => r.payload?.task_id === taskId);
        expect(foundTask).toBeDefined();
        
        if (foundTask) {
            console.log(`Résultat trouvé pour la tâche ${taskId} avec un score de ${foundTask.score}`);
            // Le score peut varier légèrement en fonction des modèles d'embedding.
            // On s'assure juste qu'il est raisonnablement élevé.
            expect(foundTask.score).toBeGreaterThan(0.65);
        }
    }, 30000);
});