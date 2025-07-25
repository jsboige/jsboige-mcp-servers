import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import openai from './openai.js';
import { getQdrantClient } from './qdrant.js';
import { Schemas } from '@qdrant/js-client-rest';

type PointStruct = Schemas['PointStruct'];

const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Interfaces pour parser les fichiers JSON de conversation
interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | null;
    tool_calls?: any;
    timestamp?: string; // Ajout pour récupérer le timestamp
}

interface UiMessage {
    author: 'user' | 'agent';
    text: string;
    timestamp: string; // UiMessage a déjà un timestamp
}

interface DialogueEntry {
    content: string;
    timestamp: number;
    sourceFile: string;
}

/**
 * Assure que la collection Qdrant existe. Si non, la crée.
 */
async function ensureCollectionExists() {
    try {
        const qdrant = getQdrantClient();
        const result = await qdrant.getCollections();
        const collectionExists = result.collections.some((collection: { name: string }) => collection.name === COLLECTION_NAME);

        if (!collectionExists) {
            console.log(`Collection "${COLLECTION_NAME}" not found. Creating...`);
            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: {
                    size: 1536,
                    distance: 'Cosine',
                },
            });
            console.log(`Collection "${COLLECTION_NAME}" created successfully.`);
        }
    } catch (error) {
        console.error('Error ensuring Qdrant collection exists:', error);
        throw error; // Propage l'erreur pour la gestion en amont
    }
}

/**
 * Extrait le dialogue pertinent depuis les fichiers de conversation d'une tâche.
 * @param taskPath Le chemin vers le répertoire de la tâche.
 * @returns Un tableau de dialogues avec leur contenu et métadonnées.
 */
async function extractDialogues(taskPath: string): Promise<DialogueEntry[]> {
    const dialogues: DialogueEntry[] = [];
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');

    // Lire api_conversation_history.json
    try {
        if (require('fs').existsSync(apiHistoryPath)) {
            const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8');
            const apiMessages: ApiMessage[] = JSON.parse(apiHistoryContent);
            apiMessages
                .filter(msg => (msg.role === 'user' || msg.role === 'assistant') && msg.content)
                .forEach(msg => {
                    dialogues.push({
                        content: `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`,
                        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
                        sourceFile: 'api_conversation_history.json',
                    });
                });
        }
    } catch (error) {
        console.warn(`Could not read or parse ${apiHistoryPath}:`, error);
    }

    // Lire ui_messages.json
    try {
        if (require('fs').existsSync(uiMessagesPath)) {
            const uiMessagesContent = await fs.readFile(uiMessagesPath, 'utf-8');
            const uiMessages: UiMessage[] = JSON.parse(uiMessagesContent);
            uiMessages
                .filter(msg => msg.author === 'user' || msg.author === 'agent')
                .forEach(msg => {
                    dialogues.push({
                        content: `${msg.author === 'user' ? 'User' : 'Assistant'}: ${msg.text}`,
                        timestamp: new Date(msg.timestamp).getTime(),
                        sourceFile: 'ui_messages.json',
                    });
                });
        }
    } catch (error) {
        console.warn(`Could not read or parse ${uiMessagesPath}:`, error);
    }
    
    // Trier les dialogues par timestamp pour reconstruire l'ordre chronologique
    return dialogues.sort((a, b) => a.timestamp - b.timestamp);
}


/**
 * Indexe une seule tâche en générant des embeddings pour sa conversation et en les stockant dans Qdrant.
 * @param taskId L'ID de la tâche à indexer.
 * @param taskPath Le chemin complet vers le répertoire de la tâche.
 */
export async function indexTask(taskId: string, taskPath: string): Promise<PointStruct> {
    console.log(`Starting indexing for task: ${taskId}`);

    try {
        // 1. S'assurer que la collection existe
        await ensureCollectionExists();

        // 2. Extraire les dialogues de la conversation
        // Note: pour le test, on lit depuis un fichier 'messages.json' simple, pas le chemin complex.
        let dialogues: DialogueEntry[];
        if (path.basename(taskPath) === 'messages.json') {
             const content = await fs.readFile(taskPath, 'utf-8');
             const messages: ApiMessage[] = JSON.parse(content);
             dialogues = messages.map(msg => ({
                content: `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`,
                timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
                sourceFile: 'messages.json'
            }));
        } else {
            dialogues = await extractDialogues(taskPath);
        }

        if (dialogues.length === 0) {
            console.log(`No dialogues found for task ${taskId}. Skipping.`);
            // @ts-ignore
            return;
        }

        const fullConversationText = dialogues.map(d => d.content).join('\n\n');

        // 3. Générer l'embedding pour la conversation complète
        const embeddingResponse = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: fullConversationText,
        });

        const vector = embeddingResponse.data[0].embedding;

        // 4. Préparer le point pour Qdrant
        // Qdrant s'attend à un UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) ou un entier pour l'ID du point.
        // On crée un UUID déterministe à partir du taskId pour permettre les mises à jour (upsert).
        const hash = crypto.createHash('sha256').update(taskId).digest('hex');
        const pointId = `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
        const lastMessage = dialogues[dialogues.length - 1];
        
        const point: PointStruct = {
            id: pointId,
            vector: vector,
            payload: {
                task_id: taskId,
                source_file: lastMessage.sourceFile,
                timestamp: lastMessage.timestamp,
                dialogue_snippet: fullConversationText.substring(0, 500),
                user: "default-user",
            },
        };

        // 5. Stocker le vecteur dans Qdrant
        await getQdrantClient().upsert(COLLECTION_NAME, {
            wait: true,
            points: [point],
        });

        console.log(`Successfully indexed task ${taskId}. Point ID: ${point.id}`);
        return point;

    } catch (error) {
        console.error(`Failed to index task ${taskId}:`, error);
        // Propager l'erreur pour que l'appelant puisse la gérer
        throw error;
    }
}