/**
 * Fonctions utilitaires partagées pour les outils RooSync de messagerie
 *
 * @module utils/message-helpers
 * @version 1.2.0 - #1364 Worktree detection: resolve parent workspace from .claude/worktrees/*
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
 * 2. Variable d'environnement WORKSPACE_PATH (basename) - set by mcp-wrapper or ${workspaceFolder}
 * 3. Nom du répertoire courant (process.cwd()) - AUTO-DETECTION (fallback)
 *
 * Note: process.cwd() is unreliable when the MCP server runs with cwd set to its
 * own directory (e.g., mcp-wrapper.cjs uses cwd: __dirname). WORKSPACE_PATH is
 * set by the wrapper from the original cwd (which is the VS Code workspace folder).
 *
 * @returns ID du workspace (jamais undefined, utilise 'default' si impossible à détecter)
 *
 * @example
 * ```typescript
 * // WORKSPACE_PATH=d:/roo-extensions (set by wrapper)
 * getLocalWorkspaceId(); // "roo-extensions"
 * // Override manuel
 * // ROOSYNC_WORKSPACE_ID=my-custom-workspace
 * getLocalWorkspaceId(); // "my-custom-workspace"
 * ```
 */
export function getLocalWorkspaceId(): string {
  // 1. Override manuel via env var (pour tests ou cas spéciaux)
  if (process.env.ROOSYNC_WORKSPACE_ID) {
    return process.env.ROOSYNC_WORKSPACE_ID;
  }

  // 2. WORKSPACE_PATH from launcher (mcp-wrapper captures original cwd,
  //    or Roo injects ${workspaceFolder} via config)
  if (process.env.WORKSPACE_PATH) {
    const normalized = process.env.WORKSPACE_PATH.replace(/\\/g, '/');
    // Worktree detection (#1364 regression fix): WORKSPACE_PATH may itself
    // point inside .claude/worktrees/* (when the wrapper captured cwd from
    // a worktree). Resolve to parent workspace before using basename.
    const worktreeWorkspace = resolveWorkspaceFromWorktree(normalized);
    if (worktreeWorkspace) {
      return worktreeWorkspace;
    }
    const wsName = path.basename(normalized);
    if (wsName && wsName !== '.' && wsName.length >= 2) {
      return wsName;
    }
  }

  // 3. Auto-détection depuis le répertoire courant
  const cwd = process.cwd();

  // 3a. Worktree detection (#1364): if cwd is inside .claude/worktrees/,
  //     resolve to the parent workspace name instead of the worktree name.
  const worktreeWorkspace = resolveWorkspaceFromWorktree(cwd);
  if (worktreeWorkspace) {
    return worktreeWorkspace;
  }

  // 3b. Standard: use basename of current directory
  const workspaceName = path.basename(cwd);

  // Validation basique : le nom doit être significatif
  if (workspaceName && workspaceName !== '.' && workspaceName.length >= 2) {
    return workspaceName;
  }

  // 4. Fallback ultime (ne devrait jamais arriver en production)
  return 'default';
}

/**
 * Detects if a path is inside a git worktree (.claude/worktrees/*) and
 * resolves the parent workspace name.
 *
 * #1364: Agents running in worktrees pollute dashboards with keys like
 * `workspace-wt-worker-*` instead of posting to the parent workspace dashboard.
 *
 * Detection patterns:
 * - Path contains `.claude/worktrees/wt-*` → extract parent workspace from
 *   the path before `.claude/` (e.g., `c:/dev/roo-extensions/.claude/worktrees/wt-X`
 *   → parent is `roo-extensions`)
 *
 * @param cwd Current working directory path
 * @returns Parent workspace name if in worktree, null otherwise
 */
export function resolveWorkspaceFromWorktree(cwd: string): string | null {
  const normalized = cwd.replace(/\\/g, '/');

  // Match pattern: <parent-path>/.claude/worktrees/wt-<name>
  const worktreeMatch = normalized.match(/(.+)\/\.claude\/worktrees\/wt-[^/]+/);
  if (worktreeMatch) {
    const parentPath = worktreeMatch[1];
    const parentName = path.basename(parentPath);
    if (parentName && parentName !== '.' && parentName.length >= 2) {
      return parentName;
    }
  }

  return null;
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
  // Replace backslashes with forward slashes for cross-platform compatibility
  // (path.basename on Linux doesn't handle Windows backslashes)
  return path.basename(workspaceId.replace(/\\/g, '/')).toLowerCase();
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
