/**
 * Tests pour message-helpers
 *
 * Vérifie les utilitaires partagés pour les outils RooSync de messagerie
 *
 * @module utils/message-helpers.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLocalMachineId,
  resolveCallerIdentity,
  formatDate,
  formatDateFull,
  getPriorityIcon,
  getStatusIcon
} from '../../../src/utils/message-helpers.js';

describe('message-helpers', () => {
  describe('getLocalMachineId', () => {
    const originalEnv = process.env.ROOSYNC_MACHINE_ID;

    afterEach(() => {
      // Restaurer l'environnement
      if (originalEnv !== undefined) {
        process.env.ROOSYNC_MACHINE_ID = originalEnv;
      } else {
        delete process.env.ROOSYNC_MACHINE_ID;
      }
    });

    it('devrait retourner ROOSYNC_MACHINE_ID si défini', () => {
      process.env.ROOSYNC_MACHINE_ID = 'test-machine-123';
      const result = getLocalMachineId();
      expect(result).toBe('test-machine-123');
    });

    it('devrait retourner un ID valide (fallback)', () => {
      // On ne teste pas le cas où ROOSYNC_MACHINE_ID n'est pas défini
      // car cela dépend du hostname système (non déterministe en tests)
      // On vérifie juste que la fonction retourne toujours quelque chose de valide
      const result = getLocalMachineId();
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('resolveCallerIdentity (#3591)', () => {
    it('sans assertion, retourne exactement la résolution locale (zéro changement)', () => {
      const id = resolveCallerIdentity(undefined);
      expect(id.fullId).toBe(`${id.machineId}:${id.workspaceId}`);
      expect(id.machineId).toBe(getLocalMachineId());
    });

    it('assertion machine:workspace passée telle quelle (déjà canonique)', () => {
      const id = resolveCallerIdentity('myia-po-2026:hermes-agent');
      expect(id).toEqual({
        machineId: 'myia-po-2026',
        workspaceId: 'hermes-agent',
        fullId: 'myia-po-2026:hermes-agent',
      });
    });

    it('canonicalise l\'alias court (po-2026 → myia-po-2026)', () => {
      const id = resolveCallerIdentity('po-2026:hermes-agent');
      expect(id.machineId).toBe('myia-po-2026');
      expect(id.fullId).toBe('myia-po-2026:hermes-agent');
    });

    it('assertion machine-seule garde workspaceId undefined (sémantique "toute la machine")', () => {
      const id = resolveCallerIdentity('myia-po-2026');
      expect(id.machineId).toBe('myia-po-2026');
      expect(id.workspaceId).toBeUndefined();
      expect(id.fullId).toBe('myia-po-2026');
    });
  });

  describe('formatDate', () => {
    it('devrait formater une date ISO en format français court', () => {
      const isoDate = '2026-01-29T15:30:00.000Z';
      const result = formatDate(isoDate);
      // Format attendu: DD/MM/YYYY HH:MM (peut varier selon timezone locale)
      expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
      expect(result).toMatch(/\d{2}:\d{2}/);
    });

    it('devrait gérer les dates avec millisecondes', () => {
      const isoDate = '2026-06-15T12:30:45.999Z';
      const result = formatDate(isoDate);
      expect(result).toBeTruthy();
      // Ne pas vérifier l'année exacte (timezone peut décaler)
      expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });
  });

  describe('formatDateFull', () => {
    it('devrait formater une date ISO en format français complet', () => {
      const isoDate = '2026-01-29T15:30:45.000Z';
      const result = formatDateFull(isoDate);
      // Devrait contenir le jour de la semaine, le mois en lettres, et les secondes
      expect(result).toMatch(/\d{2}:\d{2}:\d{2}/); // HH:MM:SS
      expect(result).toContain('2026');
    });
  });

  describe('getPriorityIcon', () => {
    it('devrait retourner 🔥 pour URGENT', () => {
      expect(getPriorityIcon('URGENT')).toBe('🔥');
    });

    it('devrait retourner ⚠️ pour HIGH', () => {
      expect(getPriorityIcon('HIGH')).toBe('⚠️');
    });

    it('devrait retourner 📝 pour MEDIUM', () => {
      expect(getPriorityIcon('MEDIUM')).toBe('📝');
    });

    it('devrait retourner 📋 pour LOW', () => {
      expect(getPriorityIcon('LOW')).toBe('📋');
    });

    it('devrait retourner 📝 par défaut pour priorité inconnue', () => {
      expect(getPriorityIcon('UNKNOWN')).toBe('📝');
      expect(getPriorityIcon('')).toBe('📝');
    });
  });

  describe('getStatusIcon', () => {
    it('devrait retourner 🆕 pour unread', () => {
      expect(getStatusIcon('unread')).toBe('🆕');
    });

    it('devrait retourner ✅ pour read', () => {
      expect(getStatusIcon('read')).toBe('✅');
    });

    it('devrait retourner 📦 pour archived', () => {
      expect(getStatusIcon('archived')).toBe('📦');
    });

    it('devrait retourner 📧 par défaut pour statut inconnu', () => {
      expect(getStatusIcon('unknown')).toBe('📧');
      expect(getStatusIcon('')).toBe('📧');
    });
  });
});
