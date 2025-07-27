import { TaskNavigator } from '../../src/services/task-navigator.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import { ApiMessage, TaskMetadata, ConversationSummary } from '../../src/types/conversation.js';
import { globalCacheManager } from '../../src/utils/cache-manager.js';

const TEST_STORAGE_PATH = path.join(__dirname, 'test-storage-nav');

// @ts-ignore
RooStorageDetector.customStoragePath = TEST_STORAGE_PATH;

// Crée une tâche simulée et la met en cache, imitant le comportement du vrai système
const createMockTask = async (taskId: string, parentId: string | null = null, title: string = '') => {
    const taskDir = path.join(TEST_STORAGE_PATH, 'tasks', taskId);
    await fs.mkdir(taskDir, { recursive: true });

    const metadata: any = {
        taskId,
        parentTaskId: parentId || undefined, // a été renommé en parentTaskId
        title: title || `Tâche ${taskId}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
        totalMessages: 1,
    };

    const summary: ConversationSummary = {
        taskId,
        path: taskDir,
        metadata: metadata as TaskMetadata,
        messageCount: 1,
        lastActivity: new Date().toISOString(),
        hasApiHistory: true,
        hasUiMessages: false,
        size: 100
    };

    // La logique de navigation se base sur le cache
    await globalCacheManager.set(`conversation:${taskId}`, summary);
    if (parentId) {
        const parentChildren = await globalCacheManager.get<string[]>(`children-index:${parentId}`) || [];
        if (!parentChildren.includes(taskId)) {
            parentChildren.push(taskId);
            await globalCacheManager.set(`children-index:${parentId}`, parentChildren);
        }
    }
    
    return summary;
};


describe('Navigation Arborescente des Tâches E2E', () => {
    let taskNavigator: TaskNavigator;

    beforeAll(async () => {
        await fs.mkdir(path.join(TEST_STORAGE_PATH, 'tasks'), { recursive: true });
        taskNavigator = TaskNavigator.getInstance();
    });

    afterAll(async () => {
        await fs.rm(TEST_STORAGE_PATH, { recursive: true, force: true });
        await globalCacheManager.clear(); // Nettoyer aussi le cache
    });

    beforeEach(async () => {
        await globalCacheManager.clear();
    });

    // Scénario de test
    // root
    // ├── child-1
    // │   └── grandchild-1
    // └── child-2
    const setupHierarchy = async () => {
        await createMockTask('root', null, 'Tâche Racine');
        await createMockTask('child-1', 'root', 'Enfant 1');
        await createMockTask('child-2', 'root', 'Enfant 2');
        await createMockTask('grandchild-1', 'child-1', 'Petit-enfant 1');
    };

    test('devrait correctement identifier le parent d\'une sous-tâche', async () => {
        await setupHierarchy();
        
        const parent = await taskNavigator.getTaskParent('grandchild-1');
        
        expect(parent).not.toBeNull();
        expect(parent?.taskId).toBe('child-1');
        expect(parent?.metadata?.title).toBe('Enfant 1');
    });

    test('devrait retourner null pour le parent d\'une tâche racine', async () => {
        await setupHierarchy();
        const parent = await taskNavigator.getTaskParent('root');
        expect(parent).toBeNull();
    });

    test('devrait lister les enfants directs d\'une tâche parent', async () => {
        await setupHierarchy();
        const children = await taskNavigator.getTaskChildren('root');
        
        expect(children).toHaveLength(2);
        expect(children.map(c => c.taskId).sort()).toEqual(['child-1', 'child-2']);
    });

    test('devrait retourner une liste vide pour les enfants d\'une tâche feuille', async () => {
        await setupHierarchy();
        const children = await taskNavigator.getTaskChildren('grandchild-1');
        expect(children).toHaveLength(0);
    });

    test('devrait reconstruire l\'arbre complet des tâches depuis la racine', async () => {
        await setupHierarchy();
        const tree = await taskNavigator.getTaskTree('root');

        expect(tree).not.toBeNull();
        expect(tree?.taskId).toBe('root');
        expect(tree?.children).toHaveLength(2);

        const child1 = tree?.children.find(c => c.taskId === 'child-1');
        const child2 = tree?.children.find(c => c.taskId === 'child-2');

        expect(child1).toBeDefined();
        expect(child2).toBeDefined();
        expect(child1?.children).toHaveLength(1);
        expect(child2?.children).toHaveLength(0);

        expect(child1?.children[0].taskId).toBe('grandchild-1');
        expect(child1?.children[0].children).toHaveLength(0);
    });
});