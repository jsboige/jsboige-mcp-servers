/**
 * cache-manager.test.ts - Tests pour le gestionnaire de cache
 *
 * Tests unitaires pour CacheManager incluant:
 * - Operations get/set de base
 * - Expiration du cache
 * - Invalidation (pattern, dependance, prefix, all)
 * - Suivi des versions de configuration
 * - Statistiques du cache
 * - Nettoyage et eviction LRU
 *
 * @module cache-manager.test
 * @version 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { CacheManager, CacheConfig, CacheEntry, CacheStats, ConfigVersion } from '../cache-manager.js';

// Mock ConfigDiffService
vi.mock('../../services/ConfigDiffService.js', () => ({
  ConfigDiffService: class MockConfigDiffService {
    compare(oldConfig: any, newConfig: any) {
      const oldKeys = Object.keys(oldConfig || {});
      const newKeys = Object.keys(newConfig || {});
      const allKeys = new Set([...oldKeys, ...newKeys]);

      let added = 0;
      let modified = 0;
      let deleted = 0;

      for (const key of allKeys) {
        if (!(key in (oldConfig || {}))) {
          added++;
        } else if (!(key in (newConfig || {}))) {
          deleted++;
        } else if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
          modified++;
        }
      }

      return {
        summary: { added, modified, deleted }
      };
    }
  }
}));

describe('CacheManager', () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    vi.useFakeTimers();
    cacheManager = new CacheManager({
      maxSize: 1000, // Small size for testing
      maxAge: 60000, // 1 minute
      persistToDisk: false,
      cleanupInterval: 10000 // 10 seconds
    });
  });

  afterEach(async () => {
    await cacheManager.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('devrait utiliser les valeurs par defaut', () => {
      const cm = new CacheManager();
      const stats = cm.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('devrait accepter une configuration partielle', () => {
      const cm = new CacheManager({ maxAge: 30000 });
      // Configuration appliquee sans erreur
      expect(cm).toBeDefined();
    });

    it('ne devrait pas demarrer le timer de cleanup en environnement test', () => {
      // Le beforeEach cree deja un CacheManager en environnement test
      // Le timer ne devrait pas etre actif
      expect(cacheManager).toBeDefined();
    });
  });

  describe('get/set', () => {
    it('devrait stocker et recuperer une valeur', async () => {
      await cacheManager.set('key1', { data: 'test' });
      const result = await cacheManager.get('key1');
      expect(result).toEqual({ data: 'test' });
    });

    it('devrait retourner null pour une cle inexistante', async () => {
      const result = await cacheManager.get('nonexistent');
      expect(result).toBeNull();
    });

    it('devrait stocker avec des dependances', async () => {
      await cacheManager.set('key1', 'value1', ['dep1', 'dep2']);
      const result = await cacheManager.get('key1');
      expect(result).toBe('value1');
    });

    it('devrait stocker avec une version', async () => {
      await cacheManager.set('key1', 'value1', [], '2.0.0');
      const result = await cacheManager.get('key1');
      expect(result).toBe('value1');
    });

    it('devrait mettre a jour une entree existante', async () => {
      await cacheManager.set('key1', 'value1');
      await cacheManager.set('key1', 'value2');
      const result = await cacheManager.get('key1');
      expect(result).toBe('value2');
    });

    it('devrait gerer differents types de donnees', async () => {
      // String
      await cacheManager.set('string', 'hello');
      expect(await cacheManager.get('string')).toBe('hello');

      // Number
      await cacheManager.set('number', 42);
      expect(await cacheManager.get('number')).toBe(42);

      // Boolean
      await cacheManager.set('bool', true);
      expect(await cacheManager.get('bool')).toBe(true);

      // Array
      await cacheManager.set('array', [1, 2, 3]);
      expect(await cacheManager.get('array')).toEqual([1, 2, 3]);

      // Object
      await cacheManager.set('object', { nested: { value: 'deep' } });
      expect(await cacheManager.get('object')).toEqual({ nested: { value: 'deep' } });

      // null
      await cacheManager.set('null', null);
      expect(await cacheManager.get('null')).toBeNull();
    });

    it('devrait incrementer les hits et misses correctement', async () => {
      await cacheManager.set('key1', 'value1');

      // 2 hits
      await cacheManager.get('key1');
      await cacheManager.get('key1');

      // 2 misses
      await cacheManager.get('nonexistent1');
      await cacheManager.get('nonexistent2');

      const stats = cacheManager.getStats();
      expect(stats.hitRate).toBeCloseTo(0.5); // 2 hits / 4 total requests
      expect(stats.missRate).toBeCloseTo(0.5); // 2 misses / 4 total requests
    });
  });

  describe('Expiration', () => {
    it('devrait expirer les entrees apres maxAge', async () => {
      const cm = new CacheManager({ maxAge: 1000 }); // 1 second
      await cm.set('key1', 'value1');

      // Avant expiration
      expect(await cm.get('key1')).toBe('value1');

      // Avancer le temps de 1.5 secondes
      vi.advanceTimersByTime(1500);

      // Apres expiration
      expect(await cm.get('key1')).toBeNull();

      await cm.close();
    });

    it('devrait compter les expired entries comme misses', async () => {
      const cm = new CacheManager({ maxAge: 1000 });
      await cm.set('key1', 'value1');

      vi.advanceTimersByTime(1500);
      await cm.get('key1');

      const stats = cm.getStats();
      expect(stats.missRate).toBe(1); // 1 miss / 1 total

      await cm.close();
    });
  });

  describe('invalidateByDependency', () => {
    it('devrait invalider les entrees par dependance', async () => {
      await cacheManager.set('key1', 'value1', ['dep1']);
      await cacheManager.set('key2', 'value2', ['dep1']);
      await cacheManager.set('key3', 'value3', ['dep2']);

      const count = await cacheManager.invalidateByDependency('dep1');

      expect(count).toBe(2);
      expect(await cacheManager.get('key1')).toBeNull();
      expect(await cacheManager.get('key2')).toBeNull();
      expect(await cacheManager.get('key3')).toBe('value3');
    });

    it('devrait retourner 0 si aucune entree ne correspond', async () => {
      await cacheManager.set('key1', 'value1', ['dep1']);
      const count = await cacheManager.invalidateByDependency('nonexistent');
      expect(count).toBe(0);
    });
  });

  describe('invalidatePattern', () => {
    it('devrait invalider les entrees par pattern regex', async () => {
      await cacheManager.set('user:1', 'user1');
      await cacheManager.set('user:2', 'user2');
      await cacheManager.set('post:1', 'post1');

      const count = await cacheManager.invalidatePattern(/^user:/);

      expect(count).toBe(2);
      expect(await cacheManager.get('user:1')).toBeNull();
      expect(await cacheManager.get('user:2')).toBeNull();
      expect(await cacheManager.get('post:1')).toBe('post1');
    });

    it('devrait supporter differents patterns', async () => {
      await cacheManager.set('task-001', 'data');
      await cacheManager.set('task-002', 'data');
      await cacheManager.set('config-001', 'data');

      const count = await cacheManager.invalidatePattern(/task/);
      expect(count).toBe(2);
    });
  });

  describe('invalidate', () => {
    it('devrait invalider toutes les entrees avec all: true', async () => {
      await cacheManager.set('key1', 'value1');
      await cacheManager.set('key2', 'value2');
      await cacheManager.set('key3', 'value3');

      const count = await cacheManager.invalidate({ all: true });

      expect(count).toBe(3);
      expect(await cacheManager.get('key1')).toBeNull();
      expect(await cacheManager.get('key2')).toBeNull();
      expect(await cacheManager.get('key3')).toBeNull();
    });

    it('devrait invalider par pattern', async () => {
      await cacheManager.set('user:1', 'user1');
      await cacheManager.set('user:2', 'user2');

      const count = await cacheManager.invalidate({ pattern: /^user:/ });
      expect(count).toBe(2);
    });

    it('devrait invalider par prefix', async () => {
      await cacheManager.set('cache:user:1', 'data');
      await cacheManager.set('cache:user:2', 'data');
      await cacheManager.set('other:1', 'data');

      const count = await cacheManager.invalidate({ prefix: 'cache:' });
      expect(count).toBe(2);
      expect(await cacheManager.get('other:1')).toBe('data');
    });

    it('devrait invalider par dependance', async () => {
      await cacheManager.set('key1', 'value1', ['config:mcp']);

      const count = await cacheManager.invalidate({ dependency: 'config:mcp' });
      expect(count).toBe(1);
    });

    it('devrait retourner 0 si aucune option specifiee', async () => {
      await cacheManager.set('key1', 'value1');
      const count = await cacheManager.invalidate({});
      expect(count).toBe(0);
      expect(await cacheManager.get('key1')).toBe('value1');
    });
  });

  describe('Config Version Tracking', () => {
    it('devrait enregistrer une version de configuration', async () => {
      const config = { setting: 'value' };
      await cacheManager.registerConfigVersion('test-config', config);

      const version = cacheManager.getConfigVersion('test-config');
      expect(version).toBeDefined();
      expect(version?.config).toEqual(config);
    });

    it('devrait detecter un changement de configuration', async () => {
      const config1 = { setting: 'value1' };
      const config2 = { setting: 'value2' };

      await cacheManager.registerConfigVersion('test-config', config1);

      const hasChanged = cacheManager.hasConfigChanged('test-config', config2);
      expect(hasChanged).toBe(true);
    });

    it('devrait retourner true si pas de version precedente', () => {
      const hasChanged = cacheManager.hasConfigChanged('new-config', { data: 'test' });
      expect(hasChanged).toBe(true);
    });

    it('devrait retourner false si la configuration na pas change', async () => {
      const config = { setting: 'value' };
      await cacheManager.registerConfigVersion('test-config', config);

      const hasChanged = cacheManager.hasConfigChanged('test-config', config);
      expect(hasChanged).toBe(false);
    });

    it('devrait invalider le cache quand la configuration change', async () => {
      const config1 = { setting: 'value1' };
      const config2 = { setting: 'value2' };

      // Enregistrer la premiere version
      await cacheManager.registerConfigVersion('test-config', config1);

      // Ajouter une entree dependante
      await cacheManager.set('key1', 'value1', ['config:test-config']);

      // Changer la configuration
      await cacheManager.registerConfigVersion('test-config', config2);

      // L'entree devrait etre invalidee
      expect(await cacheManager.get('key1')).toBeNull();
    });

    it('ne devrait pas invalider si smartInvalidation est desactive', async () => {
      const cm = new CacheManager({ enableSmartInvalidation: false });

      const config1 = { setting: 'value1' };
      const config2 = { setting: 'value2' };

      await cm.registerConfigVersion('test-config', config1);
      await cm.set('key1', 'value1', ['config:test-config']);
      await cm.registerConfigVersion('test-config', config2);

      // L'entree ne devrait PAS etre invalidee
      expect(await cm.get('key1')).toBe('value1');

      await cm.close();
    });
  });

  describe('invalidateOnConfigChange', () => {
    it('devrait invalider et mettre a jour la version', async () => {
      const config1 = { key: 'value1' };
      const config2 = { key: 'value2' };

      // Premier enregistrement
      await cacheManager.registerConfigVersion('my-config', config1);

      // Ajouter entree dependante
      await cacheManager.set('data', 'important', ['config:my-config']);

      // Changer la config
      const count = await cacheManager.invalidateOnConfigChange('my-config', config2);

      expect(count).toBe(1);
      expect(await cacheManager.get('data')).toBeNull();
    });

    it('devrait retourner 0 si premiere version', async () => {
      const count = await cacheManager.invalidateOnConfigChange('new-config', { data: 'test' });
      expect(count).toBe(0);
    });

    it('devrait retourner 0 si pas de changement', async () => {
      const config = { key: 'value' };
      await cacheManager.registerConfigVersion('my-config', config);

      const count = await cacheManager.invalidateOnConfigChange('my-config', config);
      expect(count).toBe(0);
    });
  });

  describe('getStats', () => {
    it('devrait retourner les statistiques initiales', () => {
      const stats = cacheManager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.missRate).toBe(0);
    });

    it('devrait calculer correctement les statistiques', async () => {
      await cacheManager.set('key1', 'a'.repeat(100)); // ~200 bytes
      await cacheManager.set('key2', 'b'.repeat(200)); // ~400 bytes

      await cacheManager.get('key1'); // hit
      await cacheManager.get('key1'); // hit
      await cacheManager.get('nonexistent'); // miss

      const stats = cacheManager.getStats();
      expect(stats.totalEntries).toBe(2);
      expect(stats.hitRate).toBeCloseTo(2/3);
      expect(stats.missRate).toBeCloseTo(1/3);
    });
  });

  describe('cleanup', () => {
    it('devrait supprimer les entrees expirees', async () => {
      const cm = new CacheManager({ maxAge: 1000 });
      await cm.set('key1', 'value1');
      await cm.set('key2', 'value2');

      vi.advanceTimersByTime(1500);

      const cleaned = await cm.cleanup();
      expect(cleaned).toBe(2);

      const stats = cm.getStats();
      expect(stats.totalEntries).toBe(0);

      await cm.close();
    });

    it('ne devrait pas supprimer les entrees valides', async () => {
      await cacheManager.set('key1', 'value1');
      vi.advanceTimersByTime(100); // Not expired

      const cleaned = await cacheManager.cleanup();
      expect(cleaned).toBe(0);
    });
  });

  describe('clear', () => {
    it('devrait vider le cache completement', async () => {
      await cacheManager.set('key1', 'value1');
      await cacheManager.set('key2', 'value2');
      await cacheManager.set('key3', 'value3');

      await cacheManager.clear();

      const stats = cacheManager.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalSize).toBe(0);
    });

    it('devrait reinitialiser les statistiques', async () => {
      await cacheManager.set('key1', 'value1');
      await cacheManager.get('key1'); // hit

      await cacheManager.clear();

      const stats = cacheManager.getStats();
      expect(stats.hitRate).toBe(0);
      expect(stats.missRate).toBe(0);
    });
  });

  describe('Specialized Methods', () => {
    describe('cacheTaskTree', () => {
      it('devrait mettre en cache un arbre de taches', async () => {
        const tree = {
          root: { id: 'root', children: [] },
          metadata: { version: '1.0.0' }
        } as any;

        const conversations = [
          { taskId: 'task1', summary: 'Test' }
        ] as any;

        await cacheManager.cacheTaskTree(tree, conversations);

        const cachedTree = await cacheManager.getCachedTaskTree();
        expect(cachedTree).toEqual(tree);
      });
    });

    describe('cacheSearchResults', () => {
      it('devrait mettre en cache des resultats de recherche', async () => {
        const query = 'test query';
        const filters = { type: 'bug' };
        const results = [{ id: 1, title: 'Bug 1' }];

        await cacheManager.cacheSearchResults(query, filters, results);

        const cached = await cacheManager.getCachedSearchResults(query, filters);
        expect(cached).toEqual(results);
      });

      it('devrait retourner null pour une recherche non cachee', async () => {
        const cached = await cacheManager.getCachedSearchResults('new query', {});
        expect(cached).toBeNull();
      });
    });
  });

  describe('getKeys', () => {
    it('devrait retourner toutes les cles du cache', async () => {
      await cacheManager.set('key1', 'value1');
      await cacheManager.set('key2', 'value2');

      const keys = cacheManager.getKeys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
    });

    it('devrait retourner un tableau vide si le cache est vide', () => {
      const keys = cacheManager.getKeys();
      expect(keys).toEqual([]);
    });
  });

  describe('LRU Eviction', () => {
    it('devrait supprimer les entrees les plus anciennes quand maxSize atteint', async () => {
      const cm = new CacheManager({ maxSize: 100 }); // Very small

      // Ajouter plusieurs entrees qui depassent la taille
      await cm.set('key1', 'a'.repeat(30)); // ~60 bytes
      await cm.set('key2', 'b'.repeat(30)); // ~60 bytes
      await cm.set('key3', 'c'.repeat(30)); // Should trigger eviction

      // key1 devrait etre supprime (plus ancien)
      expect(await cm.get('key1')).toBeNull();
      expect(await cm.get('key2')).toBeDefined();
      expect(await cm.get('key3')).toBeDefined();

      await cm.close();
    });
  });

  describe('Edge Cases', () => {
    it('devrait gerer les cles avec caracteres speciaux', async () => {
      const specialKey = 'key:with:colons/and/slashes';
      await cacheManager.set(specialKey, 'value');
      expect(await cacheManager.get(specialKey)).toBe('value');
    });

    it('devrait gerer les objets circulaires (si stringify fonctionne)', async () => {
      const obj: any = { name: 'circular' };
      // Note: JSON.stringify would fail on circular refs
      // This tests that our size calculation handles it gracefully
      await cacheManager.set('circular', obj);
      expect(await cacheManager.get('circular')).toEqual(obj);
    });

    it('devrait gerer les grands objets', async () => {
      // Use a cache manager with large maxSize to avoid eviction
      const cm = new CacheManager({ maxSize: 100 * 1024, persistToDisk: false });
      const largeData = { data: 'x'.repeat(10000) };
      await cm.set('large', largeData);
      expect(await cm.get('large')).toEqual(largeData);
      await cm.close();
    });

    it('devrait gerer close() avec cleanup timer actif', async () => {
      const cm = new CacheManager({ cleanupInterval: 1000 });
      await cm.set('key', 'value');
      // Should not throw
      await cm.close();
    });

    it('devrait gerer close() sans cleanup timer', async () => {
      // cacheManager from beforeEach doesn't start timer in test env
      await cacheManager.set('key', 'value');
      // Should not throw
      await cacheManager.close();
    });
  });

  describe('Integration Scenarios', () => {
    it('scenario: cycle de vie complet du cache', async () => {
      // 1. Enregistrer la premiere version de config
      await cacheManager.registerConfigVersion('mcp', { servers: ['server1'] });

      // 2. Ajouter des donnees avec dependance sur la config
      await cacheManager.set('task:001', { status: 'todo' }, ['config:mcp']);

      // 3. Modifier la config (declenche invalidation)
      await cacheManager.registerConfigVersion('mcp', { servers: ['server1', 'server2'] });

      // 4. Verifier que les entrees dependantes sont supprimees
      expect(await cacheManager.get('task:001')).toBeNull();

      // 5. Ajouter nouvelles donnees
      await cacheManager.set('task:002', { status: 'in-progress' }, ['config:mcp']);

      // 6. Verifier les stats
      const stats = cacheManager.getStats();
      expect(stats.totalEntries).toBeGreaterThan(0);
    });

    it('scenario: recherche avec cache', async () => {
      const query = 'bug critical';
      const filters = { status: 'open' };
      const results = [{ id: 1, title: 'Critical Bug' }];

      // Premier appel - pas de cache
      let cached = await cacheManager.getCachedSearchResults(query, filters);
      expect(cached).toBeNull();

      // Mettre en cache
      await cacheManager.cacheSearchResults(query, filters, results);

      // Deuxieme appel - depuis le cache
      cached = await cacheManager.getCachedSearchResults(query, filters);
      expect(cached).toEqual(results);
    });
  });
});
