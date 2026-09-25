/**
 * Fonctions utilitaires pour le serveur MCP
 */

import { promises as fs } from 'fs';
import { getActiveMcpSettingsPath as getExtensionMcpSettingsPath } from './extension-paths.js';
import path from 'path';
import os from 'os';
import { exec } from 'child_process'; // kept for potential future use
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton, SkeletonHeader } from '../types/conversation.js';
import { RooStorageDetector } from './roo-storage-detector.js';
import { OUTPUT_CONFIG } from '../config/server-config.js';
import { existsSync } from 'fs';
// FIX: Dynamic import to break circular dependency cycle:
// server-helpers → tools/index → roosync/* → RooSyncService → InventoryCollector → server-helpers
// This circular dep causes ESM module evaluation deadlock (Node.js v24).
// Only 2 functions use toolExports, so lazy-loading is safe.
import { GenericError, GenericErrorCode } from '../types/errors.js';

// #1628: Re-export from shared-state-path.ts instead of duplicating.
// The isolated module has no project imports, so this does not create cycles.
export { getSharedStatePath } from './shared-state-path.js';
/**
 * Tronque les résultats trop longs
 */
export function truncateResult(result: CallToolResult): CallToolResult {
    for (const item of result.content) {
        if (item.type === 'text' && item.text.length > OUTPUT_CONFIG.MAX_OUTPUT_LENGTH) {
            item.text = item.text.substring(0, OUTPUT_CONFIG.MAX_OUTPUT_LENGTH) +
                `\n\n[...]\n\n--- OUTPUT TRUNCATED AT ${OUTPUT_CONFIG.MAX_OUTPUT_LENGTH} CHARACTERS ---`;
        }
    }
    return result;
}

/**
 * Format a millisecond duration as a compact human-readable string.
 *  - <1000 ms : "142ms"
 *  - <60 s    : "2.4s"
 *  - <60 m    : "1m23s"
 *  - else     : "1h05m"
 */
export function formatDurationMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 3600) {
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m}m${s.toString().padStart(2, '0')}s`;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h${m.toString().padStart(2, '0')}m`;
}

/**
 * Inject execution duration into a tool result so callers can see how long
 * each MCP tool took. Sets `result._meta.durationMs` (MCP spec field) AND
 * appends a compact footer line to the first text content for human visibility.
 *
 * Footer format: `\n\n[⏱ <toolName> 142ms]`
 *
 * Safe by design:
 *  - Footer is appended (never inserted), so JSON-text consumers that read
 *    `content[0].text` will get the footer at the end. Existing convention
 *    (cf. truncateResult) already appends non-JSON markers.
 *  - When the result has no text content, only `_meta.durationMs` is set.
 *  - errors during injection are swallowed — the original result is returned.
 */
export function injectDuration(
    result: CallToolResult,
    durationMs: number,
    toolName?: string
): CallToolResult {
    try {
        // Always set MCP spec _meta field
        const meta = (result as any)._meta || {};
        meta.durationMs = durationMs;
        meta.toolName = toolName;
        (result as any)._meta = meta;

        // Append a compact footer to the first text item for visibility
        const first = result.content && result.content[0];
        if (first && first.type === 'text' && typeof first.text === 'string') {
            const label = toolName ? `${toolName} ` : '';
            first.text = `${first.text}\n\n[⏱ ${label}${formatDurationMs(durationMs)}]`;
        }
    } catch {
        // Never fail tool calls because of instrumentation
    }
    return result;
}

/**
 * Gère la commande touch_mcp_settings
 * Utilise l'API native Node.js pour éviter les problèmes d'échappement PowerShell
 */
export async function handleTouchMcpSettings(): Promise<CallToolResult> {
    try {
        const settingsPath = getExtensionMcpSettingsPath();

        // SAFETY GUARD: In test environments, reject paths to REAL mcp_settings.json.
        // Incidents: 2026-03-08 (ai-01), 2026-04-03 (po-2023).
        if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
            const isTestPath = settingsPath.includes('__test-data__') ||
                settingsPath.includes('__roo-state-manager-test-appdata__') ||
                settingsPath.includes('mcp-settings-integration') ||
                (process.env.APPDATA || '').includes('__test-data__') ||
                (process.env.APPDATA || '') === 'C:\\Users\\Test\\AppData\\Roaming' ||
                (process.env.APPDATA || '').includes('/home/test') ||
                (process.env.APPDATA || '').includes('/tmp/');
            if (!isTestPath) {
                throw new Error(
                    `SAFETY ABORT: handleTouchMcpSettings() would touch REAL mcp_settings.json in test mode!\n` +
                    `  Resolved: ${settingsPath}\n` +
                    `  APPDATA: ${process.env.APPDATA || '(unset)'}`
                );
            }
        }
        
        // Vérifier que le fichier existe
        try {
            await fs.access(settingsPath);
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        error: `Fichier mcp_settings.json introuvable à : ${settingsPath}`
                    })
                }],
                isError: true
            };
        }
        
        // Toucher le fichier en modifiant son timestamp (atime et mtime)
        const now = new Date();
        await fs.utimes(settingsPath, now, now);
        
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: `Fichier mcp_settings.json touché avec succès à ${now.toISOString()}`,
                    path: settingsPath
                })
            }]
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: `Erreur lors du touch : ${errorMessage}`
                })
            }],
            isError: true
        };
    }
}

/**
 * Gère l'export JSON
 */
export async function handleExportConversationJson(
    args: {
        taskId: string;
        filePath?: string;
        jsonVariant?: 'light' | 'full';
        truncationChars?: number;
    },
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    try {
        const { taskId } = args;
        
        if (!taskId) {
            throw new GenericError("taskId est requis", GenericErrorCode.INVALID_ARGUMENT);
        }

        const conversation = conversationCache.get(taskId);
        if (!conversation) {
            throw new GenericError(`Conversation avec taskId ${taskId} introuvable`, GenericErrorCode.INVALID_ARGUMENT, { taskId });
        }

        const getConversationSkeleton = async (id: string) => {
            return conversationCache.get(id) || null;
        };

        // #1110 FIX: Direct import from sub-module instead of barrel (avoids ESM circular deadlock)
        const { handleExportConversationJson: handleExportJson } = await import('../tools/export/export-conversation-json.js');
        const result = await handleExportJson(args, getConversationSkeleton);

        return {
            content: [{ type: 'text', text: result }]
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `❌ Erreur lors de l'export JSON: ${errorMessage}` }],
            isError: true
        };
    }
}

/**
 * Gère l'export CSV
 */
export async function handleExportConversationCsv(
    args: {
        taskId: string;
        filePath?: string;
        csvVariant?: 'conversations' | 'messages' | 'tools';
        truncationChars?: number;
    },
    conversationCache: Map<string, ConversationSkeleton>
): Promise<CallToolResult> {
    try {
        const { taskId } = args;
        
        if (!taskId) {
            throw new GenericError("taskId est requis", GenericErrorCode.INVALID_ARGUMENT);
        }

        const conversation = conversationCache.get(taskId);
        if (!conversation) {
            throw new GenericError(`Conversation avec taskId ${taskId} introuvable`, GenericErrorCode.INVALID_ARGUMENT, { taskId });
        }

        const getConversationSkeleton = async (id: string) => {
            return conversationCache.get(id) || null;
        };

        // #1110 FIX: Direct import from sub-module instead of barrel (avoids ESM circular deadlock)
        const { handleExportConversationCsv: handleExportCsv } = await import('../tools/export/export-conversation-csv.js');
        const result = await handleExportCsv(args, getConversationSkeleton);

        return {
            content: [{ type: 'text', text: result }]
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        return {
            content: [{ type: 'text', text: `❌ Erreur lors de l'export CSV: ${errorMessage}` }],
            isError: true
        };
    }
}

/**
 * #3007: Resolve a full ConversationSkeleton from cache + disk on demand.
 *
 * The in-memory `conversationCache` is populated as `SkeletonHeader` (no
 * `sequence` field) for Tier 1 (Roo local) sources — see state-manager.service.ts
 * (`conversationCache: Map<string, SkeletonHeader>`). Tools that need the
 * conversation sequence (export XML, view, summarize) MUST go through this
 * resolver; otherwise `XmlExporterService.generateTaskXml` iterates
 * `skeleton.sequence ?? []` and produces an empty `<sequence/>` (issue #3007).
 *
 * Resolution strategy (mirrors view-details.tool.ts:118-140 — the canonical
 * cache→Claude→Roo-disk resolution used by `view_task_details`):
 *
 *   1. Cache hit with full sequence (Tier 2/3 hot tiers — Claude/Archive):
 *      return as-is. `sequence` is non-empty, no disk read needed.
 *   2. Claude Code session (`id` starts with `claude-`): the cache holds a
 *      header-only entry (or none). `loadFullSkeleton` reads Roo `.skeletons/`
 *      and cannot serve a Claude session, so route to
 *      `ClaudeStorageDetector.findConversationById` (Claude JSONL store).
 *      Covers the Claude half of #3007 (the measured 17-msg claude-* task).
 *   3. Cache hit header-only (Tier 1 Roo): delegate to `loadFullSkeleton`
 *      which reads `<storage>/tasks/.skeletons/<id>.json`. The disk file
 *      is the source of truth for the sequence.
 *   4. Cache miss: scan Roo storage for the conversation directory. Found
 *      directory → `RooStorageDetector.analyzeConversation` rebuilds a
 *      full skeleton from `ui_messages.json` + `api_conversation_history.json`.
 *   5. Not found anywhere → null.
 *
 * Designed to fail OPEN (return whatever partial data exists) rather than
 * throw — callers (export_data, task_export, etc.) decide how to surface
 * the absence via their own error contracts. Never throws.
 */
/**
 * #3661 AC8 — Résout une conversation Tier 3 (archive GDrive) depuis le
 * SkeletonCacheService : peek sync (aucun cold load déclenché), puis
 * hydratation à la demande du SEUL corps demandé via
 * `ensureConversationHydrated()` (borné par SKELETON_ARCHIVE_TIER_MAX_MB,
 * éviction LRU des autres corps — jamais de la fraîche).
 * Retour null = pas une entrée Tier 3 du cache chaud : l'appelant continue
 * ses chemins locaux normaux, comportement inchangé.
 */
export async function hydrateTier3SkeletonFromCache(
    id: string,
    cache?: Map<string, SkeletonHeader>
): Promise<ConversationSkeleton | null> {
    try {
        const { SkeletonCacheService } = await import('../services/skeleton-cache.service.js');
        const scs = SkeletonCacheService.getInstance();
        const stub = scs.peekSkeleton(id);
        if (!stub || (stub as any).metadata?.dataSource !== 'gdrive-archive') return null;
        // #1217 follow-up 3 (review ai-01) — précédence local > archive : un id
        // à la fois stub Tier 3 et tâche Roo LOCALE vivante doit être servi par
        // le local (le frais bat le snapshot). Garde à moindre coût : un dossier
        // tasks/<id> local court-circuite la branche ; l'appelant retombe alors
        // sur ses chemins locaux inchangés.
        try {
            const locations = await RooStorageDetector.detectStorageLocations();
            for (const loc of locations) {
                if (existsSync(path.join(loc, 'tasks', id))) return null;
            }
        } catch {
            // Détection impossible : ne pas bloquer le chemin archive pour autant.
        }
        if (!(await scs.ensureConversationHydrated(id))) return null;
        // hydrateTier3Entry mute l'entrée in place : le peek relit le corps.
        const hydrated = scs.peekSkeleton(id) ?? null;
        // Éviction LRU concurrente : un stub survivant (hydrated=false) n'est PAS
        // un corps résolu — le rendre ferait afficher une archive vide au lieu de
        // laisser l'appelant retomber sur ses chemins locaux.
        if (!hydrated || (hydrated as any).metadata?.hydrated !== true) return null;
        // Écriture dans le cache appelant : view reconstruit ses cartes dessus,
        // et les résolutions suivantes court-circuitent sur la séquence non vide.
        cache?.set(id, hydrated as any);
        return hydrated;
    } catch {
        return null;
    }
}

export async function resolveFullConversationSkeleton(
    id: string,
    cache: Map<string, SkeletonHeader>
): Promise<ConversationSkeleton | null> {
    try {
        const cached = cache.get(id);

        // 1. Cache hit — Tier 2/3 hot tiers carry a full sequence inline.
        if (cached) {
            const cachedAny = cached as any;
            const hasFullSequence = Array.isArray(cachedAny.sequence) && cachedAny.sequence.length > 0;
            if (hasFullSequence) {
                return cached as any as ConversationSkeleton;
            }
        }

        // 2. #3007 Claude branch — claude-* ids resolve from the Claude JSONL store.
        //    `loadFullSkeleton` (step 3) reads Roo `.skeletons/` (background-services.ts:140)
        //    and cannot serve a Claude session, so a claude-* header-only entry (or a
        //    cache miss) would otherwise fall through to the Roo disk scan → null. The
        //    #3007 measurement covered TWO tasks — Roo (61 msgs) AND Claude (17 msgs) —
        //    both with empty <sequence/>; this branch covers the Claude half. Mirrors
        //    view-details.tool.ts:118-140.
        if (id.startsWith('claude-')) {
            // Empty cached conversation — no disk read needed (mirror Roo empty-header).
            if (cached && cached.metadata.messageCount === 0) {
                return { ...cached, sequence: [] } as any as ConversationSkeleton;
            }
            const { ClaudeStorageDetector } = await import('./claude-storage-detector.js');
            const loaded = await ClaudeStorageDetector.findConversationById(id);
            if (loaded) {
                if (!loaded.metadata) loaded.metadata = {} as any;
                (loaded.metadata as any).source = 'claude-code';
                (loaded.metadata as any).dataSource = 'claude';
                cache.set(id, loaded as any as SkeletonHeader);
                return loaded;
            }
            // Not found in Claude storage — fall through to Roo paths (rare).
        }

        // 3. Tier 1 Roo: header-only in cache — load the disk-backed full skeleton.
        if (cached) {
            if (cached.metadata.messageCount > 0) {
                const { loadFullSkeleton } = await import('../services/background-services.js');
                const full = await loadFullSkeleton(id, cache);
                if (full) return full;
                // Fall through to disk scan if the disk file is missing/corrupt.
            } else {
                // Empty conversation — return header with empty sequence (no disk read needed).
                return { ...cached, sequence: [] } as any as ConversationSkeleton;
            }
        }

        // 3b. #3661 AC8 — Tier 3 stub (archive GDrive) : le corps vit dans le
        //     SkeletonCacheService, pas dans ce cache. Peek + hydratation à la
        //     demande ; null si l'entrée n'est pas un stub Tier 3 chaud.
        const tier3 = await hydrateTier3SkeletonFromCache(id, cache);
        if (tier3) return tier3;

        // 4. Disk scan — Roo tasks whose header was never loaded into cache.
        const locations = await RooStorageDetector.detectStorageLocations();
        for (const loc of locations) {
            // #1325: detectStorageLocations returns base paths, need 'tasks' segment.
            const taskPath = path.join(loc, 'tasks', id);
            if (existsSync(taskPath)) {
                const skeleton = await RooStorageDetector.analyzeConversation(id, taskPath);
                if (skeleton) {
                    cache.set(id, skeleton as any as SkeletonHeader);
                    return skeleton;
                }
            }
        }
        return null;
    } catch {
        // Never throw — export tools must degrade gracefully.
        return null;
    }
}