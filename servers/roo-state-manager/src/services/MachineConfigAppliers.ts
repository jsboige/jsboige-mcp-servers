/**
 * MachineConfigAppliers — case 8 of #603 (#4611): bind every MachineConfig
 * section to the EXISTING `roosync_config apply` targets.
 *
 * The apply-by-target capability already lives in `roosync_config` (13+ targets,
 * `ConfigSharingService.applyConfig`) but was NOT expressed under the MachineConfig
 * model (#603, case 8 wording). This module is the binding layer: given a collected
 * `MachineConfig`, it returns for each section the existing target (and Claude Code
 * scope, #601) that applies it — or an explicit read-only verdict with the reason.
 *
 * Design constraints (#4611, from the issue body):
 *  - **No new write path.** This module WRITES NOTHING. Bindings only name targets
 *    that `applyConfig` already accepts; applying remains
 *    `roosync_config(action: "apply", targets: [...])` unchanged.
 *  - **No new MCP tool.** The bindings ride the `targets: ["all"]` collect response
 *    (`applyBindings` field). RSM stays at 18 exposed tools.
 *  - Applicability is data-driven from the config itself: an empty section on a seat
 *    (e.g. Roo uninstalled, #2381) binds `applicable: false` with a reason — the
 *    target itself stays valid for a future apply.
 *
 * @see src/types/machine-config.ts (MachineConfig)
 * @see src/tools/roosync/config.ts (wiring into the `all` collect)
 * @see src/services/ConfigSharingService.ts (applyConfig — the existing targets)
 */

import type { MachineConfig } from '../types/machine-config.js';

/** One section-to-target binding. */
export interface MachineConfigApplyBinding {
  /** Dotted MachineConfig path, e.g. `roo.mcpServers`. */
  section: string;
  /**
   * Existing `roosync_config` apply target (same vocabulary `applyConfig`
   * accepts), or `null` for read-only sections (with `reason`).
   */
  target: string | null;
  /** Claude Code scope when it selects the file behind the target (#601). */
  scope?: 'user' | 'project' | 'settings';
  /** False when the section carries no data on this seat (target stays valid). */
  applicable: boolean;
  /** Why not applicable, or why the section is read-only. */
  reason?: string;
}

/**
 * Bind every section of a collected MachineConfig to its apply target.
 * Pure function over the config — no filesystem, no clock.
 */
export function machineConfigApplyBindings(config: MachineConfig): MachineConfigApplyBinding[] {
  const roo = config.roo;
  const claude = config.claude;
  const bindings: MachineConfigApplyBinding[] = [
    // ---- Roo sections (mcp_settings.json, custom_modes.yaml, .roomodes, .roo/) ----
    {
      section: 'roo.mcpServers',
      target: 'mcp',
      applicable: roo.mcpServers.length > 0,
      reason: roo.mcpServers.length > 0
        ? undefined
        : 'aucun serveur MCP Roo collecté (Roo absent ?) — la cible reste valide pour un apply',
    },
    {
      section: 'roo.modes.global',
      target: 'modes-yaml',
      applicable: roo.modes.global.length > 0,
      reason: roo.modes.global.length > 0 ? undefined : 'custom_modes.yaml vide ou absent',
    },
    {
      section: 'roo.modes.local',
      target: 'roomodes',
      applicable: (roo.modes.local?.length ?? 0) > 0,
      reason: (roo.modes.local?.length ?? 0) > 0 ? undefined : 'pas de .roomodes projet',
    },
    {
      section: 'roo.rules',
      target: 'rules',
      applicable: (roo.rules?.length ?? 0) > 0,
      reason: (roo.rules?.length ?? 0) > 0 ? undefined : 'pas de .roo/rules/ sur ce siège',
    },
    {
      section: 'roo.scheduler',
      target: 'schedules',
      applicable: !!roo.scheduler,
      reason: roo.scheduler ? undefined : 'pas de .roo/schedules.json',
    },
    {
      section: 'roo.settings',
      // state.vscdb has no file target: model/mode state is written by
      // apply_profile (profiles + model-configs), not by a file-copy target.
      target: null,
      applicable: !!roo.settings,
      reason: 'state.vscdb : écrit par apply_profile (profils / model-configs), pas de cible fichier directe',
    },

    // ---- Claude sections (~/.claude.json, ~/.claude/settings.json, .mcp.json) ----
    {
      section: 'claude.userConfig',
      target: 'claude-config',
      scope: 'user',
      applicable: !!claude.userConfig,
      reason: claude.userConfig ? undefined : '~/.claude.json illisible ou absent',
    },
    {
      section: 'claude.mcpServers',
      target: 'mcp',
      scope: 'user',
      applicable: (claude.mcpServers?.length ?? 0) > 0,
      reason: (claude.mcpServers?.length ?? 0) > 0
        ? undefined
        // mcp:<name> applies a single server of this same file.
        : 'aucun serveur MCP Claude au scope user — cible mcp / mcp:<nom> reste valide',
    },
    {
      section: 'claude.settings',
      target: 'settings',
      scope: 'settings',
      applicable: !!claude.settings,
      reason: claude.settings
        ? 'claude-settings (snapshot masqué, #3545) = comparaison seule ; apply d\'un canon exige une campagne harmonization'
        : '~/.claude/settings.json illisible ou absent',
    },
    {
      section: 'claude.project',
      target: 'mcp',
      scope: 'project',
      applicable: claude.project?.hasMcpJson === true,
      reason: claude.project?.hasMcpJson
        ? 'CLAUDE.md projet : versionné git, hors périmètre apply'
        : 'pas de .mcp.json projet',
    },
    {
      section: 'claude.scheduledTasks',
      target: 'schtasks',
      applicable: (claude.scheduledTasks?.length ?? 0) > 0,
      reason: (claude.scheduledTasks?.length ?? 0) > 0 ? undefined : 'aucune tâche planifiée collectée',
    },

    // ---- Read-only sections (no apply target, by design) ----
    {
      section: 'system',
      target: null,
      applicable: false,
      reason: 'faits matériels injectés par InventoryService — rien à appliquer',
    },
    {
      section: 'environment',
      target: null,
      applicable: false,
      reason: '.env lu en NOMS de clés seulement (secrets jamais copiés) — rotation chiffrée via env:<service>',
    },
    {
      section: 'roosync',
      target: null,
      applicable: false,
      reason: 'état de coordination (rôle, heartbeat, messagerie) — pas une configuration appliquable',
    },
    {
      section: 'paths',
      target: null,
      applicable: false,
      reason: 'ancrages de fichiers résolus à la collecte — dérivés, jamais appliqués',
    },
  ];

  return bindings;
}
