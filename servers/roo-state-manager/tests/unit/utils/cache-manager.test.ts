/**
 * Tests unitaires pour le gestionnaire de cache (CacheManager)
 *
 * Teste les fonctionnalités:
 * - Opérations de base (get/set)
 * - Invalidation (pattern, préfixe, dépendance)
 * - Cache spécialisé (task tree, search)
 * - Statistiques et nettoyage
 * - Smart invalidation basée sur config
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheManager, CacheConfig, CacheEntry } from '../../../src/utils/cache-manager.js';
import { TaskTree, TreeNode } from '../../../src/types/task-tree.js';
import { ConversationSummary } from '../../../src/types/conversation.js';

// Mock du ConfigDiffService pour éviter les dépendances
vi.mock('../../../src/services/ConfigDiffService.js', () => ({
    ConfigDiffService: class {
        compare(oldConfig: any, newConfig: any) {
            const added = Object.keys(newConfig).filter(k => !(k in oldConfig)).length;
            const deleted = Object.keys(oldConfig).filter(k => !(k in newConfig)).length;
            const modified = Object.keys(oldConfig).filter(k => k in newConfig && oldConfig[k] !== newConfig[k]).length;
            return { summary: { added, deleted, modified } };
        }
    }
}));

describe('CacheManager', () => {
    let cacheManager: CacheManager;

    beforeEach(() => {
        // Créer une instance avec config de test (sans timer, sans disque)
        cacheManager = new CacheManager({
            maxSize: 10 * 1024, // 10KB pour les tests
            maxAge: 1000, // 1 seconde pour les tests d'expiration
            persistToDisk: false,
            cleanupInterval: 60000, // Long intervalle pour éviter les side effects
            enableSmartInvalidation: true
        });
    });

    afterEach(async () => {
        await cacheManager.close();
    });

    describe('Opérations de base', () => {
        it('devrait stocker et récupérer une valeur', async () => {
            await cacheManager.set('test-key', { value: 42 });
            const result = await cacheManager.get('test-key');

            expect(result).toEqual({ value: 42 });
        });

        it('devrait retourner null pour une clé inexistante', async () => {
            const result = await cacheManager.get('non-existent');
            expect(result).toBeNull();
        });

        it('devrait retourner null pour une entrée expirée', async () => {
            // Cache avec maxAge très court
            const shortCache = new CacheManager({ maxAge: 10, persistToDisk: false });
            await shortCache.set('expiring-key', { data: 'test' });

            // Attendre l'expiration
            await new Promise(resolve => setTimeout(resolve, 50));

            const result = await shortCache.get('expiring-key');
            expect(result).toBeNull();

            await shortCache.close();
        });

        it('devrait mettre à jour une entrée existante', async () => {
            await cacheManager.set('update-key', { version: 1 });
            await cacheManager.set('update-key', { version: 2 });

            const result = await cacheManager.get('update-key');
            expect(result).toEqual({ version: 2 });
        });

        it('devrait stocker avec des dépendances', async () => {
            await cacheManager.set('dependent-key', { data: 'test' }, ['dep1', 'dep2']);

            // Vérifier que l'entrée existe
            const result = await cacheManager.get('dependent-key');
            expect(result).not.toBeNull();
        });

        it('devrait stocker avec une version personnalisée', async () => {
            await cacheManager.set('versioned-key', { data: 'test' }, [], '2.0.0');

            const result = await cacheManager.get('versioned-key');
            expect(result).not.toBeNull();
        });
    });

    describe('Invalidation', () => {
        it('devrait invalider par dépendance', async () => {
            await cacheManager.set('key1', { data: 1 }, ['common-dep']);
            await cacheManager.set('key2', { data: 2 }, ['common-dep']);
            await cacheManager.set('key3', { data: 3 }, ['other-dep']);

            const invalidated = await cacheManager.invalidateByDependency('common-dep');

            expect(invalidated).toBe(2);
            expect(await cacheManager.get('key1')).toBeNull();
            expect(await cacheManager.get('key2')).toBeNull();
            expect(await cacheManager.get('key3')).not.toBeNull();
        });

        it('devrait invalider par pattern', async () => {
            await cacheManager.set('search:query1', { results: [] });
            await cacheManager.set('search:query2', { results: [] });
            await cacheManager.set('tree:main', { nodes: [] });

            const invalidated = await cacheManager.invalidatePattern(/^search:/);

            expect(invalidated).toBe(2);
            expect(await cacheManager.get('search:query1')).toBeNull();
            expect(await cacheManager.get('search:query2')).toBeNull();
            expect(await cacheManager.get('tree:main')).not.toBeNull();
        });

        it('devrait invalider par préfixe', async () => {
            await cacheManager.set('task:1', { id: 1 });
            await cacheManager.set('task:2', { id: 2 });
            await cacheManager.set('other:1', { id: 3 });

            const invalidated = await cacheManager.invalidate({ prefix: 'task:' });

            expect(invalidated).toBe(2);
            expect(await cacheManager.get('task:1')).toBeNull();
            expect(await cacheManager.get('task:2')).toBeNull();
            expect(await cacheManager.get('other:1')).not.toBeNull();
        });

        it('devrait vider tout le cache avec all: true', async () => {
            await cacheManager.set('key1', { data: 1 });
            await cacheManager.set('key2', { data: 2 });
            await cacheManager.set('key3', { data: 3 });

            const invalidated = await cacheManager.invalidate({ all: true });

            expect(invalidated).toBe(3);
            expect(await cacheManager.get('key1')).toBeNull();
            expect(await cacheManager.get('key2')).toBeNull();
            expect(await cacheManager.get('key3')).toBeNull();
        });

        it('devrait retourner 0 si aucune option d\'invalidation', async () => {
            await cacheManager.set('key1', { data: 1 });
            const invalidated = await cacheManager.invalidate({});

            expect(invalidated).toBe(0);
            expect(await cacheManager.get('key1')).not.toBeNull();
        });
    });

    describe('Cache spécialisé TaskTree', () => {
        it('devrait mettre en cache un arbre de tâches', async () => {
            const tree: TaskTree = {
                root: { id: 'root', type: 'workspace' as any, children: [] } as TreeNode,
                metadata: { version: '1.0.0', totalNodes: 1, maxDepth: 1, lastUpdated: new Date().toISOString() }
            };
            const conversations: ConversationSummary[] = [
                { taskId: 'task-1', metadata: {} as any }
            ];

            await cacheManager.cacheTaskTree(tree, conversations);

            const cached = await cacheManager.getCachedTaskTree();
            expect(cached).toEqual(tree);
        });

        it('devrait retourner null si pas d\'arbre en cache', async () => {
            const cached = await cacheManager.getCachedTaskTree();
            expect(cached).toBeNull();
        });
    });

    describe('Cache spécialisé Search', () => {
        it('devrait mettre en cache des résultats de recherche', async () => {
            const query = 'test query';
            const filters = { type: 'conversation' };
            const results = [{ taskId: 'task-1' }];

            await cacheManager.cacheSearchResults(query, filters, results);

            const cached = await cacheManager.getCachedSearchResults(query, filters);
            expect(cached).toEqual(results);
        });

        it('devrait retourner null pour des résultats non cachés', async () => {
            const cached = await cacheManager.getCachedSearchResults('unknown', {});
            expect(cached).toBeNull();
        });

        it('devrait distinguer les caches par query et filters', async () => {
            await cacheManager.cacheSearchResults('query1', { type: 'A' }, [{ id: 1 }]);
            await cacheManager.cacheSearchResults('query1', { type: 'B' }, [{ id: 2 }]);
            await cacheManager.cacheSearchResults('query2', { type: 'A' }, [{ id: 3 }]);

            const result1 = await cacheManager.getCachedSearchResults('query1', { type: 'A' });
            const result2 = await cacheManager.getCachedSearchResults('query1', { type: 'B' });
            const result3 = await cacheManager.getCachedSearchResults('query2', { type: 'A' });

            expect(result1).toEqual([{ id: 1 }]);
            expect(result2).toEqual([{ id: 2 }]);
            expect(result3).toEqual([{ id: 3 }]);
        });
    });

    describe('Statistiques', () => {
        it('devrait calculer les stats correctement', async () => {
            await cacheManager.set('key1', { data: 'test' });
            await cacheManager.get('key1'); // hit
            await cacheManager.get('key1'); // hit
            await cacheManager.get('unknown'); // miss

            const stats = cacheManager.getStats();

            expect(stats.totalEntries).toBe(1);
            expect(stats.hitRate).toBeCloseTo(2/3, 2);
            expect(stats.missRate).toBeCloseTo(1/3, 2);
        });

        it('devrait avoir des stats à 0 pour un cache vide', () => {
            const stats = cacheManager.getStats();

            expect(stats.totalEntries).toBe(0);
            expect(stats.totalSize).toBe(0);
            expect(stats.hitRate).toBe(0);
            expect(stats.missRate).toBe(0);
        });
    });

    describe('Nettoyage', () => {
        it('devrait nettoyer les entrées expirées', async () => {
            const shortCache = new CacheManager({ maxAge: 10, persistToDisk: false });
            await shortCache.set('expiring', { data: 'test' });
            await shortCache.set('fresh', { data: 'test' });

            // Attendre l'expiration partielle
            await new Promise(resolve => setTimeout(resolve, 50));

            // Mettre à jour le timestamp de 'fresh' pour qu'elle reste valide
            await shortCache.set('fresh', { data: 'updated' });

            const cleaned = await shortCache.cleanup();

            expect(cleaned).toBeGreaterThanOrEqual(1);
            expect(await shortCache.get('fresh')).not.toBeNull();

            await shortCache.close();
        });

        it('devrait vider complètement le cache avec clear()', async () => {
            await cacheManager.set('key1', { data: 1 });
            await cacheManager.set('key2', { data: 2 });

            await cacheManager.clear();

            expect(await cacheManager.get('key1')).toBeNull();
            expect(await cacheManager.get('key2')).toBeNull();

            const stats = cacheManager.getStats();
            expect(stats.totalEntries).toBe(0);
        });
    });

    describe('Smart Invalidation (config changes)', () => {
        it('devrait enregistrer une version de config', async () => {
            const config = { setting1: 'value1' };
            await cacheManager.registerConfigVersion('test-config', config);

            const version = cacheManager.getConfigVersion('test-config');
            expect(version).not.toBeNull();
            expect(version!.config).toEqual(config);
        });

        it('devrait détecter un changement de config', async () => {
            const config1 = { setting1: 'value1' };
            const config2 = { setting1: 'value2' };

            await cacheManager.registerConfigVersion('test-config', config1);

            const hasChanged = cacheManager.hasConfigChanged('test-config', config2);
            expect(hasChanged).toBe(true);
        });

        it('devrait retourner true pour une config non enregistrée', () => {
            const hasChanged = cacheManager.hasConfigChanged('unknown-config', { any: 'value' });
            expect(hasChanged).toBe(true);
        });

        it('devrait invalider le cache quand la config change', async () => {
            const config1 = { setting1: 'value1' };
            const config2 = { setting1: 'value2' };

            // Enregistrer la première version
            await cacheManager.registerConfigVersion('test-config', config1);

            // Créer une entrée dépendante
            await cacheManager.set('dependent-data', { important: 'data' }, ['config:test-config']);

            // Changer la config
            const invalidated = await cacheManager.invalidateOnConfigChange('test-config', config2);

            expect(invalidated).toBe(1);
            expect(await cacheManager.get('dependent-data')).toBeNull();
        });

        it('ne devrait pas invalider si la config est identique', async () => {
            const config = { setting1: 'value1' };

            await cacheManager.registerConfigVersion('test-config', config);
            await cacheManager.set('dependent-data', { important: 'data' }, ['config:test-config']);

            const invalidated = await cacheManager.invalidateOnConfigChange('test-config', config);

            expect(invalidated).toBe(0);
            expect(await cacheManager.get('dependent-data')).not.toBeNull();
        });
    });

    describe('Gestion de la taille', () => {
        it('devrait respecter la taille maximale', async () => {
            const smallCache = new CacheManager({
                maxSize: 100, // Très petite taille
                persistToDisk: false
            });

            // Ajouter des entrées jusqu'à dépasser la limite
            for (let i = 0; i < 20; i++) {
                await smallCache.set(`key${i}`, { data: 'x'.repeat(50) });
            }

            // Certaines entrées auraient dû être supprimées
            const stats = smallCache.getStats();
            expect(stats.totalSize).toBeLessThanOrEqual(100);

            await smallCache.close();
        });
    });

    describe('Méthodes utilitaires', () => {
        it('devrait retourner toutes les clés avec getKeys()', async () => {
            await cacheManager.set('key1', { data: 1 });
            await cacheManager.set('key2', { data: 2 });
            await cacheManager.set('key3', { data: 3 });

            const keys = cacheManager.getKeys();

            expect(keys).toContain('key1');
            expect(keys).toContain('key2');
            expect(keys).toContain('key3');
            expect(keys.length).toBe(3);
        });

        it('devrait retourner un tableau vide si le cache est vide', () => {
            const keys = cacheManager.getKeys();
            expect(keys).toEqual([]);
        });
    });

    describe('Cas limites', () => {
        it('devrait gérer des valeurs null', async () => {
            await cacheManager.set('null-key', null);
            const result = await cacheManager.get('null-key');
            expect(result).toBeNull();
        });

        it('devrait gérer des tableaux vides', async () => {
            await cacheManager.set('empty-array', []);
            const result = await cacheManager.get('empty-array');
            expect(result).toEqual([]);
        });

        it('devrait gérer des objets imbriqués profonds', async () => {
            const deepObject = {
                level1: {
                    level2: {
                        level3: {
                            value: 'deep'
                        }
                    }
                }
            };

            await cacheManager.set('deep-object', deepObject);
            const result = await cacheManager.get('deep-object');
            expect(result).toEqual(deepObject);
        });

        it('devrait gérer des clés avec caractères spéciaux', async () => {
            const specialKey = 'key:with:colons/and/slashes-dashes_underscores';
            await cacheManager.set(specialKey, { data: 'test' });

            const result = await cacheManager.get(specialKey);
            expect(result).toEqual({ data: 'test' });
        });
    });

    describe('Fermeture', () => {
        it('devrait fermer proprement le cache', async () => {
            await cacheManager.set('key1', { data: 'test' });

            // La fermeture ne devrait pas lever d'erreur
            await expect(cacheManager.close()).resolves.not.toThrow();
        });
    });
});
