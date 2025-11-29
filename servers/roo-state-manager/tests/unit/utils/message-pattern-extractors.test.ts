/**
 * Tests unitaires pour les extracteurs de patterns de messages
 * Couverture complète des fonctionnalités d'extraction
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanMode, createInstruction, extractTimestamp } from '../../../src/utils/message-pattern-extractors.js';
import { NewTaskInstruction } from '../../../src/types/conversation.js';

describe('Message Pattern Extractors', () => {
  describe('cleanMode', () => {
    it('devrait nettoyer les modes avec emojis', () => {
      expect(cleanMode('💻 Code mode')).toBe('code mode');
      expect(cleanMode('🏗️ Architect mode')).toBe('architect mode');
      expect(cleanMode('❓ Ask mode')).toBe('ask mode');
    });

    it('devrait nettoyer les modes avec caractères spéciaux', () => {
      expect(cleanMode('mode@#$%')).toBe('mode');
      expect(cleanMode('  mode  ')).toBe('mode');
      expect(cleanMode('MODE')).toBe('mode');
    });

    it('devrait retourner "task" par défaut', () => {
      expect(cleanMode('')).toBe('task');
      expect(cleanMode(null as any)).toBe('task');
      expect(cleanMode(undefined as any)).toBe('task');
    });
  });

  describe('createInstruction', () => {
    it('devrait créer une instruction valide', () => {
      const instruction = createInstruction(1234567890, 'code', 'Test message with sufficient length', 20);
      
      expect(instruction).toEqual({
        timestamp: 1234567890,
        mode: 'code',
        message: 'Test message with sufficient length'
      });
    });

    it('devrait rejeter les messages trop courts', () => {
      const instruction = createInstruction(1234567890, 'code', 'Short', 20);
      expect(instruction).toBeNull();
    });

    it('devrait nettoyer le mode automatiquement', () => {
      const instruction = createInstruction(1234567890, '💻 Code', 'Valid message length', 20);
      expect(instruction?.mode).toBe('code');
    });

    it('devrait utiliser "task" comme mode par défaut', () => {
      const instruction = createInstruction(1234567890, '', 'Valid message length', 20);
      expect(instruction?.mode).toBe('task');
    });

    it('devrait gérer les messages non-string', () => {
      expect(createInstruction(1234567890, 'code', null as any, 20)).toBeNull();
      expect(createInstruction(1234567890, 'code', 123 as any, 20)).toBeNull();
    });
  });

  describe('extractTimestamp', () => {
    it('devrait extraire le timestamp depuis message.timestamp', () => {
      const message = { timestamp: '2023-11-28T10:00:00.000Z' };
      const timestamp = extractTimestamp(message);
      expect(timestamp).toBe(new Date('2023-11-28T10:00:00.000Z').getTime());
    });

    it('devrait extraire le timestamp depuis message.ts', () => {
      const message = { ts: '2023-11-28T10:00:00.000Z' };
      const timestamp = extractTimestamp(message);
      expect(timestamp).toBe(new Date('2023-11-28T10:00:00.000Z').getTime());
    });

    it('devrait retourner 0 par défaut', () => {
      const message = {};
      const timestamp = extractTimestamp(message);
      expect(timestamp).toBe(0);
    });

    it('devrait gérer les timestamps numériques', () => {
      const message = { timestamp: 1234567890 };
      const timestamp = extractTimestamp(message);
      expect(timestamp).toBe(1234567890);
    });
  });
});