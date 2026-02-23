/**
 * Fonctions utilitaires partagées pour les outils RooSync de messagerie
 *
 * @module utils/message-helpers
 * @version 1.1.0 - Auto-détection workspace depuis process.cwd()
 */

import os from 'os';
import path from 'path';

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
  // Normalisation lowercase pour cohérence (évite doublons case-sensitive)
  if (process.env.ROOSYNC_MACHINE_ID) {
    return process.env.ROOSYNC_MACHINE_ID.toLowerCase();
  }

  // Fallback vers le hostname OS
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Récupère l'ID du workspace local
 *
 * Stratégie de détection (par ordre de priorité) :
 * 1. Variable d'environnement ROOSYNC_WORKSPACE_ID (override manuel)
 * 2. Nom du répertoire courant (process.cwd()) - AUTO-DETECTION
 *
 * @returns ID du workspace (jamais undefined, utilise 'default' si impossible à détecter)
 *
 * @example
 * ```typescript
 * // Dans d:/dev/roo-extensions
 * getLocalWorkspaceId(); // "roo-extensions"
 * // Avec override manuel
 * // ROOSYNC_WORKSPACE_ID=my-custom-workspace
 * getLocalWorkspaceId(); // "my-custom-workspace"
 * ```
 */
export function getLocalWorkspaceId(): string {
  // 1. Override manuel via env var (pour tests ou cas spéciaux)
  if (process.env.ROOSYNC_WORKSPACE_ID) {
    return process.env.ROOSYNC_WORKSPACE_ID;
  }

  // 2. Auto-détection depuis le répertoire courant
  const cwd = process.cwd();
  const workspaceName = path.basename(cwd);

  // Validation basique : le nom doit être significatif
  if (workspaceName && workspaceName !== '.' && workspaceName.length >= 2) {
    return workspaceName;
  }

  // 3. Fallback ultime (ne devrait jamais arriver en production)
  return 'default';
}

/**
 * Récupère l'identifiant complet local (machine + workspace)
 *
 * @returns "machineId:workspaceId" - toujours avec workspace depuis auto-détection
 *
 * @example
 * ```typescript
 * // Sur myia-ai-01 dans d:/dev/roo-extensions
 * getLocalFullId(); // "myia-ai-01:roo-extensions"
 * // Sur myia-po-2023 dans c:/projects/my-app
 * getLocalFullId(); // "myia-po-2023:my-app"
 * ```
 */
export function getLocalFullId(): string {
  const machineId = getLocalMachineId();
  const workspaceId = getLocalWorkspaceId();
  return `${machineId}:${workspaceId}`;
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
 * Normalise un identifiant de workspace pour comparaison.
 *
 * Gère les cas où l'expéditeur utilise un chemin complet (ex: "D:\vllm")
 * alors que le récepteur utilise un basename (ex: "vllm").
 * Comparaison case-insensitive pour compatibilité Windows.
 *
 * @param workspaceId Identifiant brut du workspace
 * @returns Basename normalisé en lowercase
 */
export function normalizeWorkspaceId(workspaceId: string): string {
  return path.basename(workspaceId).toLowerCase();
}

/**
 * Vérifie si un message correspond au destinataire local
 *
 * Règles de matching :
 * - "all" / "All" → match tous
 * - "machineId" (sans workspace) → match toutes les instances sur cette machine
 * - "machineId:workspaceId" → match UNIQUEMENT ce workspace spécifique
 *   (comparaison normalisée : basename, case-insensitive)
 *
 * @param messageTo Destinataire du message
 * @param localMachineId ID machine locale
 * @param localWorkspaceId ID workspace local (auto-détecté)
 * @returns true si le message correspond au destinataire local
 */
export function matchesRecipient(
  messageTo: string,
  localMachineId: string,
  localWorkspaceId: string
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
  // Normalize both sides: basename + lowercase (handles "D:\vllm" vs "vllm")
  if (parsed.workspaceId) {
    return normalizeWorkspaceId(localWorkspaceId) === normalizeWorkspaceId(parsed.workspaceId);
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
