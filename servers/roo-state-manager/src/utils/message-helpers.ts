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
 * Récupère l'ID du workspace local (optionnel)
 *
 * @returns ID du workspace ou undefined si non configuré
 *
 * @example
 * ```typescript
 * // With ROOSYNC_WORKSPACE_ID=roo-extensions
 * getLocalWorkspaceId(); // "roo-extensions"
 * // Without env var
 * getLocalWorkspaceId(); // undefined
 * ```
 */
export function getLocalWorkspaceId(): string | undefined {
  return process.env.ROOSYNC_WORKSPACE_ID || undefined;
}

/**
 * Récupère l'identifiant complet local (machine + workspace optionnel)
 *
 * @returns "machineId:workspaceId" si workspace configuré, sinon "machineId"
 *
 * @example
 * ```typescript
 * // With ROOSYNC_WORKSPACE_ID=roo-extensions on myia-ai-01
 * getLocalFullId(); // "myia-ai-01:roo-extensions"
 * // Without workspace
 * getLocalFullId(); // "myia-ai-01"
 * ```
 */
export function getLocalFullId(): string {
  const machineId = getLocalMachineId();
  const workspaceId = getLocalWorkspaceId();
  return workspaceId ? `${machineId}:${workspaceId}` : machineId;
}

/**
 * Parse un identifiant composite "machineId:workspaceId" ou simple "machineId"
 *
 * @param id L'identifiant à parser
 * @returns Objet avec machineId et workspaceId optionnel
 *
 * @example
 * ```typescript
 * parseMachineWorkspace("myia-ai-01:roo-extensions");
 * // { machineId: "myia-ai-01", workspaceId: "roo-extensions" }
 * parseMachineWorkspace("myia-ai-01");
 * // { machineId: "myia-ai-01", workspaceId: undefined }
 * ```
 */
export function parseMachineWorkspace(id: string): { machineId: string; workspaceId?: string } {
  const colonIndex = id.indexOf(':');
  if (colonIndex === -1) {
    return { machineId: id };
  }
  return {
    machineId: id.substring(0, colonIndex),
    workspaceId: id.substring(colonIndex + 1)
  };
}

/**
 * Vérifie si un message correspond au destinataire local
 *
 * Règles de matching :
 * - "all" / "All" → match tous
 * - "machineId" (sans workspace) → match toutes les instances sur cette machine
 * - "machineId:workspaceId" → match UNIQUEMENT ce workspace spécifique
 *
 * @param messageTo Destinataire du message
 * @param localMachineId ID machine locale
 * @param localWorkspaceId ID workspace local (optionnel)
 * @returns true si le message correspond au destinataire local
 */
export function matchesRecipient(
  messageTo: string,
  localMachineId: string,
  localWorkspaceId?: string
): boolean {
  // Broadcast
  if (messageTo === 'all' || messageTo === 'All') {
    return true;
  }

  const parsed = parseMachineWorkspace(messageTo);

  // Machine must match
  if (parsed.machineId !== localMachineId) {
    return false;
  }

  // If message targets a specific workspace, only that workspace should see it
  if (parsed.workspaceId) {
    return localWorkspaceId === parsed.workspaceId;
  }

  // Message targets the whole machine (no workspace specified) → all workspaces see it
  return true;
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
