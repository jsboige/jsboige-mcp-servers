/**
 * Tests pour ConfigDiffService
 *
 * Ce service implémente un système de comparaison de configurations
 * qui détecte les ajouts, modifications et suppressions entre deux configurations.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigDiffService, DiffResult } from '../../../src/services/ConfigDiffService.js';

describe('ConfigDiffService', () => {
  let service: ConfigDiffService;

  beforeEach(() => {
    service = new ConfigDiffService();
  });

  describe('initialisation', () => {
    it('devrait initialiser correctement', () => {
      expect(service).toBeInstanceOf(ConfigDiffService);
    });
  });

  describe('comparaison de configurations primitives', () => {
    it('devrait détecter les modifications sur des primitives', () => {
      const baseline = { value: 42 };
      const current = { value: 100 };
      const result = service.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
      expect(result.summary.added).toBe(0);
      expect(result.summary.deleted).toBe(0);

      const change = result.changes[0];
      expect(change.type).toBe('modify');
      expect(change.path).toEqual(['value']);
      expect(change.oldValue).toBe(42);
      expect(change.newValue).toBe(100);
    });

    it('devrait gérer les types différents comme des modifications', () => {
      const baseline = { value: 'test' };
      const current = { value: 42 };
      const result = service.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
    });

    it('devrait ne pas détecter de changement pour des valeurs identiques', () => {
      const config = { value: 'test' };
      const result = service.compare(config, config);

      expect(result.summary).toEqual({
        added: 0,
        modified: 0,
        deleted: 0,
        conflicts: 0
      });
      expect(result.changes).toHaveLength(0);
    });
  });

  describe('comparaison d\'objets imbriqués', () => {
    it('devrait détecter les modifications dans les objets imbriqués', () => {
      const baseline = {
        user: {
          name: 'Alice',
          age: 30
        },
        settings: {
          theme: 'dark'
        }
      };

      const current = {
        user: {
          name: 'Bob', // Modifié
          age: 30,
          email: 'bob@test.com' // Ajouté
        },
        settings: {
          theme: 'light' // Modifié
        },
        newSetting: 'value' // Ajouté
      };

      const result = service.compare(baseline, current);

      expect(result.summary.added).toBe(2); // email et newSetting
      expect(result.summary.modified).toBe(2); // name et theme
      expect(result.summary.deleted).toBe(0);
      expect(result.changes).toHaveLength(2);
    });

    it('devrait gérer les ajouts et suppressions dans les objets', () => {
      const baseline = {
        a: 1,
        b: 2
      };

      const current = {
        a: 1,
        c: 3 // b supprimé, c ajouté
      };

      const result = service.compare(baseline, current);

      expect(result.summary.added).toBe(1);
      expect(result.summary.deleted).toBe(1);
      expect(result.summary.modified).toBe(0);

      const deleted = result.changes.find(c => c.type === 'delete');
      const added = result.changes.find(c => c.type === 'add');

      expect(deleted?.path).toEqual(['b']);
      expect(added?.path).toEqual(['c']);
    });
  });

  describe('comparaison de tableaux', () => {
    it('devrait détecter les ajouts et suppressions dans les tableaux', () => {
      const baseline = ['item1', 'item2', 'item3'];
      const current = ['item1', 'item2', 'item4']; // item3 remplacé par item4

      const result = service.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
      expect(result.changes).toHaveLength(1);

      const change = result.changes[0];
      expect(change.path).toEqual(['2']);
      expect(change.type).toBe('modify');
      expect(change.oldValue).toBe('item3');
      expect(change.newValue).toBe('item4');
    });

    it('devrait gérer les tableaux de longueurs différentes', () => {
      const baseline = ['item1', 'item2'];
      const current = ['item1', 'item2', 'item3'];

      const result = service.compare(baseline, current);

      expect(result.summary.added).toBe(1);
      expect(result.changes).toHaveLength(1);

      const change = result.changes[0];
      expect(change.path).toEqual(['2']);
      expect(change.type).toBe('add');
    });

    it('devrait gérer les tableaux vides', () => {
      const baseline: string[] = [];
      const current: string[] = [];

      const result = service.compare(baseline, current);

      expect(result.changes).toHaveLength(0);
      expect(result.summary.added).toBe(0);
      expect(result.summary.modified).toBe(0);
      expect(result.summary.deleted).toBe(0);
    });
  });

  describe('calcul de sévérité', () => {
    it('devrait détecter les clés sensibles comme critiques', () => {
      const baseline = {
        normal: 'value',
        secret: 'hidden',
        password: 'pass123',
        api_key: 'key',
        token: 'token123'
      };

      const current = {
        normal: 'value',
        secret: 'changed',
        password: 'newpass',
        api_key: 'newkey',
        token: 'newtoken'
      };

      const result = service.compare(baseline, current);

      result.changes.forEach(change => {
        const key = change.path[change.path.length - 1];
        if (key && /secret|password|token|key|auth|credential/i.test(key)) {
          expect(change.severity).toBe('critical');
        } else {
          expect(change.severity).toBe('info');
        }
      });
    });

    it('devrait marquer les suppressions comme warnings', () => {
      const baseline = {
        important_setting: 'value'
      };

      const current = {
        // important_setting supprimé
      };

      const result = service.compare(baseline, current);

      const deleted = result.changes.find(c => c.type === 'delete');
      expect(deleted?.severity).toBe('warning');
    });

    it('devrait marquer les ajouts/modifications standards comme info', () => {
      const baseline = {
        setting: 'value'
      };

      const current = {
        setting: 'modified'
      };

      const result = service.compare(baseline, current);

      const change = result.changes[0];
      expect(change.severity).toBe('info');
    });
  });

  describe('comparaison avec versions personnalisées', () => {
    it('devrait utiliser les versions personnalisées', () => {
      const baseline = { value: 1 };
      const current = { value: 2 };
      const result = service.compare(baseline, current, 'v1', 'v2');

      expect(result.sourceVersion).toBe('v1');
      expect(result.targetVersion).toBe('v2');
    });

    it('devrait utiliser les versions par défaut', () => {
      const baseline = { value: 1 };
      const current = { value: 2 };
      const result = service.compare(baseline, current);

      expect(result.sourceVersion).toBe('local');
      expect(result.targetVersion).toBe('baseline');
    });
  });

  describe('objets complexes', () => {
    it('devrait gérer la structure complexe imbriquée', () => {
      const baseline = {
        config: {
          users: [
            { id: 1, name: 'Alice', roles: ['admin'] },
            { id: 2, name: 'Bob', roles: ['user'] }
          ],
          features: {
            search: true,
            notifications: false
          }
        }
      };

      const current = {
        config: {
          users: [
            { id: 1, name: 'Alice', roles: ['admin', 'editor'] }, // role ajouté
            { id: 2, name: 'Bob' } // roles supprimés
          ],
          features: {
            search: true,
            notifications: true // modifié
          },
          newFeature: 'added' // ajouté
        }
      };

      const result = service.compare(baseline, current);

      expect(result.summary.added).toBe(2); // newFeature et editor role
      expect(result.summary.modified).toBe(1); // notifications
      expect(result.summary.deleted).toBe(1); // roles de Bob
      expect(result.changes).toHaveLength(3);
    });

    it('devrait gérer les null et undefined', () => {
      const baseline = {
        value: null,
        missing: undefined,
        present: 'exists'
      };

      const current = {
        value: 'changed',
        missing: 'now_exists',
        present: 'exists'
      };

      const result = service.compare(baseline, current);

      expect(result.summary.modified).toBe(2);
      expect(result.changes).toHaveLength(2);
    });
  });

  describe('cas limites', () => {
    it('devrait gérer les objets avec prototype extendu', () => {
      const baseline = Object.create({ inherited: 'value' });
      baseline.own = 'value';

      const current = Object.create({ inherited: 'value' });
      current.own = 'changed';

      const result = service.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
      expect(result.changes[0].path).toEqual(['own']);
    });

    it('devrait gérer les dates comme des primitives', () => {
      const baseline = {
        created: new Date('2024-01-01'),
        updated: null
      };

      const current = {
        created: new Date('2024-01-02'),
        updated: new Date()
      };

      const result = service.compare(baseline, current);

      expect(result.summary.modified).toBe(2);
      expect(result.changes[0].type).toBe('modify');
      expect(result.changes[1].type).toBe('add');
    });
  });
});