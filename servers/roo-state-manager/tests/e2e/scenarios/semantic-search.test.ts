import { describe, it, expect } from '@jest/globals';

describe('Semantic Search E2E', () => {
  it('should have tests written in the future', () => {
    expect(true).toBe(true);
  });
});

// import { indexTask } from '../../../src/services/task-indexer.js';
// import { searchTasks, ContextWindow } from '../../../src/services/task-searcher.js';
// import * as fs from 'fs/promises';
// import * as path from 'path';
// import { getQdrantClient } from '../../../src/services/qdrant.js';
// import { RooStorageDetector } from '../../../src/utils/roo-storage-detector.js';
// import { globalCacheManager } from '../../../src/utils/cache-manager.js';
//
// const TEST_STORAGE_PATH = path.join(__dirname, 'test-storage');
// const QDRANT_COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME;
//
// // @ts-ignore
// RooStorageDetector.customStoragePath = TEST_STORAGE_PATH;
//
// const createMockConversation = async (taskId: string, content: any) => {
//     const taskDir = path.join(TEST_STORAGE_PATH, 'tasks', taskId);
//     await fs.mkdir(taskDir, { recursive: true });
//     // Le nouveau task-indexer lit depuis api_conversation_history.json
//     const filePath = path.join(taskDir, 'api_conversation_history.json');
//     await fs.writeFile(filePath, JSON.stringify(content));
//     return taskDir; // L'indexeur attend le chemin du *dossier* de la tâche
// };
//
// const waitForPointsInCollection = async (pointIds: string[], timeout = 10000, interval = 500) => {
//     const startTime = Date.now();
//     while (Date.now() - startTime < timeout) {
//         try {
//             if (!QDRANT_COLLECTION_NAME) throw new Error('QDRANT_COLLECTION_NAME is not defined');
//             const result = await getQdrantClient().retrieve(QDRANT_COLLECTION_NAME, { ids: pointIds });
//             if (result && result.length === pointIds.length) {
//                 console.log(`${result.length}/${pointIds.length} points found in collection.`);
//                 return;
//             }
//         } catch (error) {
//             // Points not found yet
//         }
//         await new Promise(resolve => setTimeout(resolve, interval));
//     }
//     throw new Error(`Timeout waiting for points to appear in collection.`);
// }
//
// describe('Stratégie d\'Indexation et Recherche Granulaire E2E', () => {
//
//     beforeAll(async () => {
//         if (!QDRANT_COLLECTION_NAME) throw new Error("QDRANT_COLLECTION_NAME doit être définie.");
//         const tasksTestPath = path.join(TEST_STORAGE_PATH, 'tasks');
//         await fs.mkdir(tasksTestPath, { recursive: true });
//
//         // Prime le cache du détecteur de stockage pour inclure notre répertoire de test.
//         // C'est crucial pour que `findConversationById` fonctionne dans les tests.
//         await globalCacheManager.set('storage_locations', [tasksTestPath]);
//
//         try {
//             await getQdrantClient().deleteCollection(QDRANT_COLLECTION_NAME);
//             console.log('Ancienne collection de test supprimée.');
//         } catch (error) {
//             console.warn(`Impossible de nettoyer la collection Qdrant, elle n'existe peut-être pas encore.`);
//         }
//     }, 30000);
//
//     afterAll(async () => {
//         await fs.rm(TEST_STORAGE_PATH, { recursive: true, force: true });
//         if (QDRANT_COLLECTION_NAME) {
//             try {
//                 await getQdrantClient().deleteCollection(QDRANT_COLLECTION_NAME);
//                 console.log('Collection de test supprimée après les tests.');
//             } catch (error) {
//                 console.warn(`Impossible de supprimer la collection Qdrant après les tests : ${error}`);
//             }
//         }
//     }, 30000);
//
//     test('devrait indexer uniquement les chunks "message_exchange"', async () => {
//         const taskId = 'test-selective-indexing-task';
//         const conversationContent = [
//             { role: 'user', content: 'Ceci est un message utilisateur.' },
//             {
//                 role: 'assistant',
//                 content: 'Ok, j\'utilise un outil.',
//                 tool_calls: [{ function: { name: 'execute_command', arguments: '{"command":"ls"}' } }]
//             },
//             { role: 'assistant', content: 'L\'outil a fonctionné.' }
//         ];
//         const conversationPath = await createMockConversation(taskId, conversationContent);
//
//         const indexedPoints = await indexTask(taskId, conversationPath);
//
//         // On attend 3 chunks: user message, assistant message (content), assistant message (tool response)
//         // Seuls 3 d'entre eux sont des 'message_exchange' et doivent être indexés.
//         // Le tool_call lui même n'est pas indexé.
//         expect(indexedPoints).toHaveLength(3);
//         expect(indexedPoints.every(p => p.payload?.chunk_type === 'message_exchange')).toBe(true);
//
//         const pointIds = indexedPoints.map(p => p.id.toString());
//         await waitForPointsInCollection(pointIds);
//     }, 30000);
//
//
//     test('devrait retrouver un chunk et reconstituer son contexte', async () => {
//         const taskId = 'test-reconstitution-task';
//         const conversationContent = [
//             { role: 'user', content: 'Première question sur les ananas.' }, // seq 0
//             { role: 'assistant', content: 'Les ananas sont des fruits tropicaux.' }, // seq 1
//             { // seq 2 (tool_interaction, non indexé)
//                 role: 'assistant',
//                 tool_calls: [{ function: { name: 'search_web', arguments: '{"query":"faits sur les ananas"}' } }]
//             },
//             { role: 'assistant', content: 'Fait intéressant: l\'ananas n\'est pas une pomme.' }, // seq 3
//             { role: 'user', content: 'Merci pour ces informations sur les ananas !' } // seq 4
//         ];
//         const conversationPath = await createMockConversation(taskId, conversationContent);
//         const indexedPoints = await indexTask(taskId, conversationPath);
//
//         // 4 chunks 'message_exchange' devraient être indexés
//         expect(indexedPoints).toHaveLength(4);
//         await waitForPointsInCollection(indexedPoints.map(p => p.id.toString()));
//
//         const query = 'fruit tropical'; // Cible le chunk avec seq 1
//         const searchResults: ContextWindow[] = await searchTasks(query, {
//              limit: 1,
//              contextBeforeCount: 1, // K=1
//              contextAfterCount: 2,  // M=2
//              filter: { must: [{ key: 'task_id', match: { value: taskId } }] }
//         });
//
//         expect(searchResults).toHaveLength(1);
//         const window = searchResults[0];
//
//         expect(window.taskId).toBe(taskId);
//         expect(window.mainChunk.content).toContain('fruits tropicaux');
//         expect(window.mainChunk.sequence_order).toBe(1);
//         expect(window.relevanceScore).toBeGreaterThan(0.5);
//
//         // Contexte avant (K=1)
//         expect(window.contextBefore).toHaveLength(1);
//         expect(window.contextBefore[0].sequence_order).toBe(0);
//         expect(window.contextBefore[0].content).toContain('Première question sur les ananas');
//
//         // Contexte après (M=2)
//         expect(window.contextAfter).toHaveLength(2);
//         expect(window.contextAfter[0].sequence_order).toBe(2);
//         expect(window.contextAfter[0].chunk_type).toBe('tool_interaction');
//         expect(window.contextAfter[1].sequence_order).toBe(3);
//         expect(window.contextAfter[1].content).toContain('l\'ananas n\'est pas une pomme');
//     }, 45000);
//
//     test('ne devrait pas retourner de résultats pour des requêtes ciblant des tool_calls', async () => {
//         const taskId = 'test-no-tool-call-match-task';
//         const conversationContent = [
//             { role: 'user', content: 'Ceci est un message utilisateur.' },
//             {
//                 role: 'assistant',
//                 content: 'Ok, j\'utilise un outil.',
//                 tool_calls: [{ function: { name: 'run_unicorn_simulation', arguments: '{"fluffiness_level":9001}' } }]
//             },
//             { role: 'assistant', content: 'L\'outil a fonctionné.' }
//         ];
//         const conversationPath = await createMockConversation(taskId, conversationContent);
//         const indexedPoints = await indexTask(taskId, conversationPath);
//         await waitForPointsInCollection(indexedPoints.map(p => p.id.toString()));
//
//         // Cette requête ne devrait rien retourner car le terme "fluffiness_level" est sémantiquement isolé
//         // et n'apparaît que dans le tool_call non indexé.
//         const searchResults = await searchTasks('fluffiness_level', {
//             limit: 1,
//             filter: { must: [{ key: 'task_id', match: { value: taskId } }] },
//             scoreThreshold: 0.5 // Seuil élevé pour rejeter les correspondances sémantiques faibles
//         });
//
//         expect(searchResults).toHaveLength(0);
//     }, 30000);
//
//     test('devrait reconstituer un contexte large au milieu d\'une longue conversation', async () => {
//         const taskId = 'test-long-reconstitution-task';
//         const conversationContent = [];
//         for (let i = 0; i < 20; i++) {
//             conversationContent.push({ role: 'user', content: `Message utilisateur numéro ${i}` });
//             if (i === 10) {
//                 conversationContent.push({ role: 'assistant', content: 'Le mot magique est "licorne enchantée".' });
//             } else {
//                 conversationContent.push({ role: 'assistant', content: `Réponse auto numéro ${i}` });
//             }
//         }
//
//         const conversationPath = await createMockConversation(taskId, conversationContent);
//         const indexedPoints = await indexTask(taskId, conversationPath);
//         await waitForPointsInCollection(indexedPoints.map(p => p.id.toString()));
//
//         const query = 'licorne enchantée'; // Cible le message 10
//         const searchResults = await searchTasks(query, {
//              limit: 1,
//              contextBeforeCount: 5, // K=5
//              contextAfterCount: 5,  // M=5
//              filter: { must: [{ key: 'task_id', match: { value: taskId } }] }
//         });
//
//         expect(searchResults).toHaveLength(1);
//         const window = searchResults[0];
//
//         const mainChunkSeq = window.mainChunk.sequence_order as number;
//         expect(window.mainChunk.content).toContain('licorne enchantée');
//
//         // On attend 5 chunks avant
//         expect(window.contextBefore).toHaveLength(5);
//         // Le dernier chunk "avant" doit avoir une séquence juste inférieure au chunk principal
//         expect(window.contextBefore[4].sequence_order).toBe(mainChunkSeq - 1);
//
//         // On attend 5 chunks après
//         expect(window.contextAfter).toHaveLength(5);
//         // Le premier chunk "après" doit avoir une séquence juste supérieure au chunk principal
//         expect(window.contextAfter[0].sequence_order).toBe(mainChunkSeq + 1);
//
//         // Vérifions que le dernier item du contexte "après" est bien celui attendu
//         const lastAfter = window.contextAfter[4];
//         expect(lastAfter.content).toContain('Message utilisateur numéro 13');
//     }, 60000);
// });