/**
 * Fonctions utilitaires partagées pour les outils RooSync de messagerie
 *
 * @module utils/message-helpers
 * @version 1.0.0
 */

import os from 'os';

/**
 * Récupère l'ID de la machine locale depuis le hostname OS
 *
 * @returns ID de la machine locale (hostname normalisé)
 *
 * @example
 * ```typescript
 * const machineId = getLocalMachineId();
 * // Returns: "myia-po-2023"
 * ```
 */
export function getLocalMachineId(): string {
  // Priorité à la variable d'environnement (pour les tests)
  if (process.env.ROOSYNC_MACHINE_ID) {
    return process.env.ROOSYNC_MACHINE_ID;
  }

  // Fallback vers le hostname OS
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Formatte la date en format français lisible
 *
 * @param isoDate Date au format ISO-8601
 * @returns Date formatée en français
 *
 * @example
 * ```typescript
 * formatDate('2026-01-29T15:30:00Z');
 * // Returns: "29/01/2026 15:30"
 * ```
 */
export function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Obtient l'icône correspondant à la priorité d'un message
 *
 * @param priority Priorité du message
 * @returns Emoji représentant la priorité
 *
 * @example
 * ```typescript
 * getPriorityIcon('URGENT'); // Returns: "🔥"
 * getPriorityIcon('HIGH');   // Returns: "⚠️"
 * getPriorityIcon('MEDIUM'); // Returns: "📝"
 * getPriorityIcon('LOW');    // Returns: "📋"
 * ```
 */
export function getPriorityIcon(priority: string): string {
  switch (priority) {
    case 'URGENT': return '🔥';
    case 'HIGH': return '⚠️';
    case 'MEDIUM': return '📝';
    case 'LOW': return '📋';
    default: return '📝';
  }
}

/**
 * Obtient l'icône correspondant au statut d'un message
 *
 * @param status Statut du message
 * @returns Emoji représentant le statut
 *
 * @example
 * ```typescript
 * getStatusIcon('unread');   // Returns: "🆕"
 * getStatusIcon('read');     // Returns: "✅"
 * getStatusIcon('archived'); // Returns: "📦"
 * ```
 */
export function getStatusIcon(status: string): string {
  switch (status) {
    case 'unread': return '🆕';
    case 'read': return '✅';
    case 'archived': return '📦';
    default: return '📧';
  }
}

/**
 * Formatte la date en format français complet avec jour de la semaine
 *
 * @param isoDate Date au format ISO-8601
 * @returns Date formatée en français avec jour de la semaine
 *
 * @example
 * ```typescript
 * formatDateFull('2026-01-29T15:30:00Z');
 * // Returns: "jeudi 29 janvier 2026 à 15:30:00"
 * ```
 */
export function formatDateFull(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
