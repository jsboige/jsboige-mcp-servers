/**
 * Extracteurs de patterns pour les messages Roo
 * Module spécialisé dans l'extraction des instructions depuis différents formats de messages
 */

import { NewTaskInstruction } from '../types/conversation.js';

/**
 * Interface pour les extracteurs de patterns
 */
export interface PatternExtractor {
  /**
   * Vérifie si l'extracteur peut traiter ce message
   */
  canHandle(message: any): boolean;

  /**
   * Extrait les instructions du message
   */
  extract(message: any): NewTaskInstruction[];

  /**
   * Nom du pattern pour le debugging
   */
  getPatternName(): string;
}

/**
 * Nettoie un mode en retirant les caractères non alphanumériques
 */
export function cleanMode(mode: string): string {
  const rawMode = String(mode || 'task');
  return rawMode.replace(/[^\w\s]/g, '').trim().toLowerCase();
}

/**
 * Crée une instruction de base avec validation
 */
export function createInstruction(
  timestamp: number,
  mode: string,
  message: string,
  minLength: number = 20,
  maxLength: number = 200 // Limite par défaut pour éviter les messages géants
): NewTaskInstruction | null {
  if (typeof message !== 'string' || message.trim().length < minLength) {
    return null;
  }

  let processedMessage = message.trim();
  if (maxLength > 0 && processedMessage.length > maxLength) {
    processedMessage = processedMessage.substring(0, maxLength);
  }

  return {
    timestamp,
    mode: cleanMode(mode) || 'task',
    message: processedMessage,
  };
}

/**
 * Extrait le timestamp d'un message de manière sécurisée
 */
export function extractTimestamp(message: any): number {
  return new Date(message.timestamp || message.ts || 0).getTime();
}