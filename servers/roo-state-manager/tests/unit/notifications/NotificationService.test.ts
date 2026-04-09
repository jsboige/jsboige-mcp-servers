/**
 * Tests pour NotificationService
 *
 * Ce service implémente un pattern Observer + Firewall pour:
 * - Gérer les abonnés aux notifications
 * - Filtrer les événements via règles configurables
 * - Émettre des notifications système
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationService, NotificationEvent, FilterRule } from '../../../src/notifications/NotificationService.js';

// Mock du logger
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }))
}));

describe('NotificationService', () => {
  let service: NotificationService;
  let mockListener: { onNotify: vi.Mock };

  beforeEach(() => {
    service = new NotificationService();
    mockListener = {
      onNotify: vi.fn()
    };
  });

  describe('initialisation', () => {
    it('devrait initialiser avec des abonnés et règles vides', () => {
      expect(service['listeners']).toEqual([]);
      expect(service['filterRules']).toEqual([]);
    });
  });

  describe('abonnement aux notifications', () => {
    it('devrait ajouter un listener correctement', () => {
      service.subscribe(mockListener);

      expect(service['listeners']).toHaveLength(1);
      expect(service['listeners'][0]).toBe(mockListener);
    });

    it('devrait gérer les doublons sans erreur', () => {
      service.subscribe(mockListener);
      service.subscribe(mockListener);

      // Le listener peut être ajouté plusieurs fois (comportement actuel)
      expect(service['listeners']).toHaveLength(2);
    });
  });

  describe('désabonnement', () => {
    it('devrait retirer un listener existant', () => {
      service.subscribe(mockListener);
      service.unsubscribe(mockListener);

      expect(service['listeners']).toHaveLength(0);
    });

    it('devrait gérer le désabonnement d\'un listener inexistant sans erreur', () => {
      expect(() => service.unsubscribe(mockListener)).not.toThrow();
    });
  });

  describe('gestion des événements', () => {
    beforeEach(() => {
      service.subscribe(mockListener);
    });

    it('devrait notifier tous les listeners d\'un événement', async () => {
      const event: NotificationEvent = {
        type: 'tool_used',
        source: 'test-tool',
        priority: 'MEDIUM',
        payload: { action: 'test' },
        timestamp: '2024-01-01T00:00:00Z'
      };

      await service.notify(event);

      expect(mockListener.onNotify).toHaveBeenCalledWith(event);
    });

    it('devrait passer les événements avec timestamp valide', async () => {
      const event: NotificationEvent = {
        type: 'new_message',
        source: 'roosync',
        priority: 'HIGH',
        payload: { messageId: 'msg-123' },
        timestamp: new Date().toISOString()
      };

      await service.notify(event);

      expect(mockListener.onNotify).toHaveBeenCalledWith(event);
    });
  });

  describe('gestion des priorités', () => {
    beforeEach(() => {
      service.subscribe(mockListener);
    });

    it('devrait traiter toutes les priorités', async () => {
      const events: NotificationEvent[] = [
        { type: 'tool_used', source: 'test', priority: 'LOW', payload: {}, timestamp: new Date().toISOString() },
        { type: 'tool_used', source: 'test', priority: 'MEDIUM', payload: {}, timestamp: new Date().toISOString() },
        { type: 'tool_used', source: 'test', priority: 'HIGH', payload: {}, timestamp: new Date().toISOString() },
        { type: 'tool_used', source: 'test', priority: 'URGENT', payload: {}, timestamp: new Date().toISOString() }
      ];

      for (const event of events) {
        await service.notify(event);
      }

      expect(mockListener.onNotify).toHaveBeenCalledTimes(4);
    });
  });

  describe('méthodes utilitaires', () => {
    it('devrait lister tous les listeners', () => {
      service.subscribe(mockListener);
      const anotherListener = { onNotify: vi.fn() };
      service.subscribe(anotherListener);

      // Accès direct à la propriété privée car getListeners n'existe pas
      expect(service['listeners']).toHaveLength(2);
      expect(service['listeners']).toContain(mockListener);
      expect(service['listeners']).toContain(anotherListener);
    });

    it('devrait retourner les statistiques du service', () => {
      const mockListener1 = vi.fn();
      const mockListener2 = vi.fn();

      service.subscribe(mockListener1);
      service.subscribe(mockListener2);

      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {},
        action: 'allow',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      const stats = service.getStats();

      expect(stats.listenersCount).toBe(2);
      expect(stats.rulesCount).toBe(1);
      expect(stats.rules).toHaveLength(1);
      expect(stats.pendingApprovalsCount).toBe(0);
      expect(stats.pendingApprovals).toHaveLength(0);
    });

    describe('gestion des approbations en attente', () => {
      it('devrait ajouter un événement aux approbations en attente', async () => {
        const event: NotificationEvent = {
          type: 'tool_used',
          source: 'test-tool',
          priority: 'MEDIUM',
          payload: { action: 'test' },
          timestamp: new Date().toISOString()
        };

        // Mock la méthode evaluateFilters pour retourner require_approval
        const originalEvaluateFilters = service['evaluateFilters'];
        service['evaluateFilters'] = vi.fn().mockReturnValue({
          action: 'require_approval',
          ruleId: 'test-rule',
          notifyUser: false
        });

        await service.notify(event);

        const stats = service.getStats();
        expect(stats.pendingApprovalsCount).toBe(1);
        expect(stats.pendingApprovals[0].event).toEqual(event);
        expect(stats.pendingApprovals[0].ruleId).toBe('test-rule');

        // Restaurer la méthode originale
        service['evaluateFilters'] = originalEvaluateFilters;
      });

      it('devrait approuver un événement en attente', async () => {
        const event: NotificationEvent = {
          type: 'tool_used',
          source: 'test-tool',
          priority: 'MEDIUM',
          payload: { action: 'test' },
          timestamp: new Date().toISOString()
        };

        // Ajouter un événement en attente
        service['pendingApprovals'] = [{
          event,
          ruleId: 'test-rule',
          timestamp: new Date().toISOString()
        }];

        // Mock du listener
        service.subscribe(mockListener);

        // Approuver
        const result = await service.approvePending(0);
        expect(result).toBe(true);
        expect(mockListener.onNotify).toHaveBeenCalledWith(event);

        // Vérifier que l'événement a été retiré des approbations
        const stats = service.getStats();
        expect(stats.pendingApprovalsCount).toBe(0);
      });

      it('devrait rejeter un événement en attente', () => {
        const event: NotificationEvent = {
          type: 'tool_used',
          source: 'test-tool',
          priority: 'MEDIUM',
          payload: { action: 'test' },
          timestamp: new Date().toISOString()
        };

        // Ajouter un événement en attente
        service['pendingApprovals'] = [{
          event,
          ruleId: 'test-rule',
          timestamp: new Date().toISOString()
        }];

        // Rejeter
        const result = service.rejectPending(0);
        expect(result).toBe(true);

        // Vérifier que l'événement a été retiré des approbations
        const stats = service.getStats();
        expect(stats.pendingApprovalsCount).toBe(0);
      });

      it('devrait gérer les indices invalides pour approvePending', async () => {
        const result = await service.approvePending(99);
        expect(result).toBe(false);
      });

      it('devrait gérer les indices invalides pour rejectPending', () => {
        const result = service.rejectPending(99);
        expect(result).toBe(false);
      });
    });
  });

  describe('filtrage des événements', () => {
    beforeEach(() => {
      service.subscribe(mockListener);
    });

    it('devrait bloquer les événements quand aucune règle ne matche', async () => {
      // Ajouter une règle pour un type différent
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'new_message',
        condition: {},
        action: 'allow',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      const event: NotificationEvent = {
        type: 'tool_used', // Type non couvert par la règle
        source: 'any-tool',
        priority: 'HIGH',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(event);
      expect(mockListener.onNotify).not.toHaveBeenCalled();
    });

    it('devrait autoriser les événements quand une règle matche avec action: allow', async () => {
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {},
        action: 'allow',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      const event: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'HIGH',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(event);
      expect(mockListener.onNotify).toHaveBeenCalled();
    });

    it('devrait bloquer les événements quand une règle matche avec action: block', async () => {
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {},
        action: 'block',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      const event: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'HIGH',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(event);
      expect(mockListener.onNotify).not.toHaveBeenCalled();
    });

    it('devrait mettre en attente les événements quand une règle matche avec action: require_approval', async () => {
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {},
        action: 'require_approval',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      const event: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'HIGH',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(event);
      expect(mockListener.onNotify).not.toHaveBeenCalled();

      // Vérifier que l'événement est dans les approbations en attente
      const stats = service.getStats();
      expect(stats.pendingApprovalsCount).toBe(1);
    });

    it('devrait vérifier les conditions sourceTool', async () => {
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {
          sourceTool: ['allowed-tool']
        },
        action: 'allow',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      // Événement autorisé
      const allowedEvent: NotificationEvent = {
        type: 'tool_used',
        source: 'allowed-tool',
        priority: 'MEDIUM',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(allowedEvent);
      expect(mockListener.onNotify).toHaveBeenCalled();

      // Réinitialiser le mock
      mockListener.onNotify.mockClear();

      // Événement bloqué
      const blockedEvent: NotificationEvent = {
        type: 'tool_used',
        source: 'blocked-tool',
        priority: 'MEDIUM',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(blockedEvent);
      expect(mockListener.onNotify).not.toHaveBeenCalled();
    });

    it('devrait vérifier les conditions priority', async () => {
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {
          priority: ['HIGH']
        },
        action: 'allow',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      // Événement autorisé (HIGH priority)
      const allowedEvent: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'HIGH',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(allowedEvent);
      expect(mockListener.onNotify).toHaveBeenCalled();

      // Réinitialiser le mock
      mockListener.onNotify.mockClear();

      // Événement bloqué (MEDIUM priority)
      const blockedEvent: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'MEDIUM',
        payload: {},
        timestamp: new Date().toISOString()
      };

      await service.notify(blockedEvent);
      expect(mockListener.onNotify).not.toHaveBeenCalled();
    });

    it('devrait vérifier les conditions tags', async () => {
      const rule: FilterRule = {
        id: 'rule1',
        eventType: 'tool_used',
        condition: {
          tags: ['important']
        },
        action: 'allow',
        notifyUser: false
      };

      service['filterRules'] = [rule];

      // Événement avec tag requis
      const allowedEvent: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'MEDIUM',
        payload: { tags: ['important'] },
        timestamp: new Date().toISOString()
      };

      await service.notify(allowedEvent);
      expect(mockListener.onNotify).toHaveBeenCalled();

      // Réinitialiser le mock
      mockListener.onNotify.mockClear();

      // Événement sans tag requis
      const blockedEvent: NotificationEvent = {
        type: 'tool_used',
        source: 'any-tool',
        priority: 'MEDIUM',
        payload: { tags: ['normal'] },
        timestamp: new Date().toISOString()
      };

      await service.notify(blockedEvent);
      expect(mockListener.onNotify).not.toHaveBeenCalled();
    });
  });

  describe('cas limites', () => {
    beforeEach(() => {
      service.subscribe(mockListener);
    });

    it('devrait gérer un payload nul ou undefined', async () => {
      const event: NotificationEvent = {
        type: 'tool_used',
        source: 'test',
        priority: 'MEDIUM',
        payload: null,
        timestamp: new Date().toISOString()
      };

      await service.notify(event);
      expect(mockListener.onNotify).toHaveBeenCalledWith(event);
    });

    it('devrait gérer des événements avec des payloads complexes', async () => {
      const complexPayload = {
        user: { id: 123, name: 'Test' },
        action: 'complex_operation',
        metadata: {
          nested: { value: true },
          array: [1, 2, 3]
        }
      };

      const event: NotificationEvent = {
        type: 'new_message',
        source: 'complex-tool',
        priority: 'HIGH',
        payload: complexPayload,
        timestamp: new Date().toISOString()
      };

      await service.notify(event);
      expect(mockListener.onNotify).toHaveBeenCalledWith(event);
    });
  });
});