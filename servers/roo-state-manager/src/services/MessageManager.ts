/**
 * Service de gestion de messagerie inter-agents RooSync
 * 
 * Gère l'envoi, la réception et l'archivage de messages structurés
 * au format JSON entre machines dans l'écosystème RooSync.
 * 
 * @module MessageManager
 * @version 1.0.0
 */

import { existsSync, promises as fs, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { withReadTimeout } from '../utils/with-read-timeout.js';
import { MessageManagerError, MessageManagerErrorCode } from '../types/errors.js';
import { parseMachineWorkspace, matchesRecipient, getLocalWorkspaceId, normalizeWorkspaceId, canonicalizeFullId, isMachineWideTarget, perReaderStatus } from '../utils/message-helpers.js';
// Safe as a static import: AttachmentManager pulls only fs/path/crypto/logger, so it
// cannot re-enter the cycle documented below.
import { AttachmentManager } from './roosync/AttachmentManager.js';
// #3151 Phase A/A.2 — RooSync channel dual-write (env-gated, never throws).
// A: creation (send/reply/amend/attachments). A.2: state transitions and destruction.
import {
  dualWriteRooSyncMessageToStore,
  dualWriteRooSyncMessageAmendment,
  dualWriteRooSyncAttachmentRefs,
  dualWriteRooSyncMessageRead,
  dualWriteRooSyncMessageBroadcastRead,
  dualWriteRooSyncMessageArchived,
  dualWriteRooSyncMessageDestroyed,
  dualWriteRooSyncMessageReminderSent,
  mapMessageToRow,
} from './unified-store/roosync-channel-dual-write.js';
// #3151 Phase B — PG-primary channel reads (env-gated, GDrive fallback).
import {
  getChannelPgReader,
  readChannelInboxFromPg,
  countChannelInboxFromPg,
  getChannelMessageFromPg,
} from './unified-store/roosync-channel-read.js';
// #3151 Phase D — PG-primary channel writes (env-gated, GDrive fallback on
// PG failure). The dual-write above made GDrive primary and PG the mirror;
// these invert it, so GDrive becomes the read-only legacy archive.
import {
  isChannelPgPrimary,
  insertRooSyncMessagePrimary,
  updateRooSyncMessagePrimary,
  destroyRooSyncMessageInStore,
  purgeArchivedChannelMessages,
} from './unified-store/roosync-channel-write.js';
// #3292 — periodic GDrive→PG reconcile: heals the dual-write loss classes
// (hard kill, PG outage, machine state regression) that block #3151 Phase B.
import {
  reconcileChannelFromGDrive,
  type ChannelReconcileResult,
} from './unified-store/roosync-channel-reconcile.js';
import type { RooSyncMessageUpdate } from './unified-store/types.js';
// #1110 FIX: Dynamic import to break ESM circular dependency.
// server-helpers → tools/index → roosync/* → MessageManager → server-helpers
import { GenericError, GenericErrorCode } from '../types/errors.js';

const logger = createLogger('MessageManager');

/**
 * Interface d'un message RooSync
 */
export interface Message {
  /** ID unique du message */
  id: string;
  
  /** ID de la machine émettrice */
  from: string;
  
  /** ID de la machine destinataire */
  to: string;
  
  /** Sujet du message */
  subject: string;
  
  /** Corps du message (markdown supporté) */
  body: string;
  
  /** Priorité du message */
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  
  /** Timestamp ISO-8601 de création */
  timestamp: string;
  
  /** Statut du message */
  status: 'unread' | 'read' | 'archived';

  /** Tags optionnels */
  tags?: string[];

  /** ID de thread pour regrouper les conversations */
  thread_id?: string;

  /** ID du message auquel on répond */
  reply_to?: string;

  /** Machines/workspaces ayant lu ce message (tracking multi-lecteurs #629) */
  read_by?: string[];
  /** Full reader ids ("machine:workspace") that have read a MACHINE-WIDE message.
   *  `read_by` is machine-granular and cannot separate two workspaces of the same
   *  machine, which is exactly what a machine-wide target needs. */
  read_by_workspace?: string[];

  /** Timestamps de lecture par machine (machineId → ISO timestamp) */
  acknowledged_at?: Record<string, string>;

  /** Auto-destruction activée (#629) */
  auto_destruct?: boolean;

  /** Lecteurs requis avant destruction (si auto_destruct=true) */
  destruct_after_read_by?: string[];

  /** Durée TTL avant destruction (ex: "30m", "2h", "1d") */
  destruct_after?: string;

  /** Timestamp d'expiration calculé (ISO-8601) */
  expires_at?: string;

  /** Timestamp de destruction effective (ISO-8601) */
  destroyed_at?: string;

  /** Raison de la destruction */
  destroyed_reason?: 'read_by_recipient' | 'read_by_all' | 'ttl_expired';

  /** Rappel d'expiration envoyé (#629) */
  reminder_sent?: boolean;

  /** Métadonnées optionnelles (amendements, etc.) */
  metadata?: {
    amended?: boolean;
    original_content?: string;
    amendment_reason?: string;
    amendment_timestamp?: string;
  };

  /** Pièces jointes (#674) */
  attachments?: Array<{
    uuid: string;
    filename: string;
    sizeBytes: number;
  }>;
}

/**
 * Interface d'un élément de liste de messages (vue condensée)
 */
export interface MessageListItem {
  /** ID unique du message */
  id: string;
  
  /** ID de la machine émettrice */
  from: string;
  
  /** ID de la machine destinataire */
  to: string;
  
  /** Sujet du message */
  subject: string;
  
  /** Priorité du message */
  priority: string;
  
  /** Timestamp ISO-8601 de création */
  timestamp: string;
  
  /** Statut du message */
  status: string;
  
  /** Aperçu des premiers caractères du corps */
  preview: string;
}

/**
 * Gestionnaire de messagerie RooSync
 * 
 * Responsabilités :
 * - Création et envoi de messages structurés
 * - Lecture de la boîte de réception
 * - Gestion du statut des messages (lu/non-lu)
 * - Archivage des messages
 */
export class MessageManager {
  private sharedStatePath: string;
  private messagesPath: string;
  private inboxPath: string;
  private sentPath: string;
  private archivePath: string;

  /**
   * Lazily built so the common paths (send/read/list) pay nothing for it — only
   * destruction touches attachments. Injectable for tests via `setAttachmentManager`.
   */
  private _attachmentManager?: AttachmentManager;

  private get attachmentManager(): AttachmentManager {
    if (!this._attachmentManager) {
      this._attachmentManager = new AttachmentManager(this.sharedStatePath);
    }
    return this._attachmentManager;
  }

  /** Test seam: inject a double so destruction can be exercised without a real store. */
  setAttachmentManager(manager: AttachmentManager): void {
    this._attachmentManager = manager;
  }

  /** In-memory metadata cache for inbox messages (#638 perf) */
  private inboxCache: MessageListItem[] | null = null;
  /** Full message cache keyed by id (for status/read_by checks) */
  private inboxFullCache: Map<string, Message> = new Map();
  /** Timestamp of last cache build */
  private cacheBuiltAt: number = 0;

  /**
   * When the cache CONTENT was last read from disk.
   *
   * Distinct from `cacheBuiltAt`, which the count fast-path RENEWS without
   * re-reading anything. That renewal is what made staleness unbounded: an
   * in-place mutation by another process (markAsRead, amend) leaves the file
   * COUNT unchanged, so the fast-path kept refreshing the TTL of a cache whose
   * content nothing had revalidated - for as long as no message was added or
   * removed. Never renewed by the fast-path, so it bounds that.
   */
  private contentBuiltAt: number = 0;
  /** Cache TTL in ms (5 minutes — file count check detects external changes) */
  private static readonly CACHE_TTL_MS = 300_000;

  /**
   * Hard bound on how long the count heuristic may keep serving content that
   * nothing has re-read from disk (#3205 follow-up).
   *
   * The count check detects files ADDED or REMOVED. It cannot detect an
   * in-place mutation, which is precisely what `markAsRead` does - so without
   * this bound a process could report "unread" for hours a message another
   * process had already handled. Past this bound the call falls through to the
   * stale-while-revalidate path: the warm cache is still served IMMEDIATELY,
   * and the re-read happens in the background. Callers never wait for it.
   */
  private static readonly CONTENT_REVALIDATE_MS = 900_000;
  /** Max concurrent file reads during cache rebuild (GDrive-safe) */
  private static readonly READ_CONCURRENCY = 50;
  /**
   * Per-file read timeout during inbox cache build (ms).
   *
   * `Promise.allSettled` waits for every file in a chunk; a single cloud-only
   * GDrive file that hangs `fs.readFile` would otherwise wedge the whole chunk
   * until the 120s MCP tool timeout — wedging inbox listing + the 3 cleanup ops
   * (autoArchiveOld/cleanupExpiredMessages/sendExpiryReminders) that all
   * transit `ensureInboxCache`. Bounding each read lets the chunk skip a hung
   * file (rejected → existing allSettled handler) and return a partial result.
   * Cf. #818 (AttachmentManager) + #2267.
   */
  private static readonly INBOX_READ_TIMEOUT_MS = 10_000;
  /** Per-file read timeout (overridable for tests; production = INBOX_READ_TIMEOUT_MS) */
  private readonly readTimeoutMs: number;
  /** Negative-cache TTL (overridable for tests; production = NEGATIVE_CACHE_TTL_MS) */
  private readonly negativeCacheTtlMs: number;
  /** Rebuild budget (overridable for tests; production = INBOX_REBUILD_BUDGET_MS) */
  private readonly rebuildBudgetMs: number;
  /** Last known file count in inbox dir (cheap invalidation check) */
  private lastInboxFileCount: number = -1;
  /** Files that failed to read during a cache build, mapped to failure timestamp.
   *  Skipped on rebuild while unexpired so a cloud-only GDrive file that times out
   *  once isn't re-read (~10s each) every 5-min rebuild (#3205). */
  private negativeCache: Map<string, number> = new Map();
  /** Negative-cache TTL in ms (15 min — long enough to skip repeated dead reads,
   *  short enough to retry once a file hydrates). */
  private static readonly NEGATIVE_CACHE_TTL_MS = 900_000;
  /**
   * Wall-clock budget for one full inbox rebuild (ms).
   *
   * `INBOX_READ_TIMEOUT_MS` bounds each FILE; nothing bounded the whole pass.
   * With ~3 160 inbox files at a concurrency of 50 that is 64 chunks, and
   * `allSettled` waits for the slowest file of each chunk — one cloud-only file
   * per chunk is enough to cost 64 x 10s. Past this budget the pass returns what
   * it has rather than blow through the caller's tool timeout (#3205).
   */
  private static readonly INBOX_REBUILD_BUDGET_MS = 60_000;
  /** In-flight rebuild, shared by concurrent callers (#3205). */
  private inboxRebuildInFlight: Promise<{ items: MessageListItem[]; full: Map<string, Message> }> | null = null;
  /**
   * Cold-start recent slice size (#3292). The stdio server restarts with every
   * Claude Code session, and the old cold start parsed the ENTIRE shared pool
   * (3 921 files, 99.7 % dead weight) before answering — 48-120 s. Message ids
   * embed their timestamp (`msg-YYYYMMDDHHMMSS-*`), so a lexical sort of the
   * readdir listing IS a recency sort: parse only these N newest files
   * synchronously, hydrate the rest in the background.
   */
  private static readonly COLD_START_SLICE_SIZE = 100;
  /** True while `inboxCache`/`inboxFullCache` hold only the recent slice (#3292). */
  private inboxCachePartial = false;

  /** Auto-archive daemon timer (#809 — prevents inbox unbounded growth) */
  private autoArchiveTimer: NodeJS.Timeout | null = null;
  /**
   * Daemon config + last run (#3292) — surfaced by getAutoArchiveStatus() so the
   * fleet can VERIFY the rotation is running. The "nothing schedules the
   * archiving" belief on #3292 persisted precisely because the daemon was
   * invisible: it ran (live pool showed 0 files past the 90-day lane) while
   * the issue diagnosed the pool as "never rotated".
   */
  private autoArchiveConfig: { maxAgeDays: number; intervalHours: number; unreadMaxAgeDays: number } | null = null;
  private autoArchiveLastRun: { at: string; archived: number; durationMs: number; error?: string } | null = null;

  /**
   * Channel reconcile daemon timer (#3292 — GDrive→PG, heals dual-write loss).
   * Own timer, not a passenger of the auto-archive runOnce: the two have
   * independent gates (MESSAGE_AUTO_ARCHIVE_ENABLED vs dual-write armed) and
   * conflating them would lose the reconcile on every machine that turns the
   * archive daemon off.
   */
  private channelReconcileTimer: NodeJS.Timeout | null = null;
  private channelReconcileConfig: { intervalHours: number; lookbackDays: number } | null = null;
  private channelReconcileLastRun: { at: string; result?: ChannelReconcileResult; error?: string } | null = null;

  /**
   * Constructeur du MessageManager
   *
   * @param sharedStatePath Chemin vers le répertoire .shared-state
   * @param readTimeoutMs Per-file read timeout for inbox cache build (tests).
   *   Defaults to INBOX_READ_TIMEOUT_MS (10s).
   */
  constructor(
    sharedStatePath: string,
    readTimeoutMs: number = MessageManager.INBOX_READ_TIMEOUT_MS,
    negativeCacheTtlMs: number = MessageManager.NEGATIVE_CACHE_TTL_MS,
    rebuildBudgetMs: number = MessageManager.INBOX_REBUILD_BUDGET_MS,
  ) {
    this.sharedStatePath = sharedStatePath;
    this.readTimeoutMs = readTimeoutMs;
    this.negativeCacheTtlMs = negativeCacheTtlMs;
    this.rebuildBudgetMs = rebuildBudgetMs;
    this.messagesPath = join(sharedStatePath, 'messages');
    this.inboxPath = join(this.messagesPath, 'inbox');
    this.sentPath = join(this.messagesPath, 'sent');
    this.archivePath = join(this.messagesPath, 'archive');

    // Créer les répertoires si nécessaires
    this.ensureDirectories();
  }

  /**
   * Crée les répertoires de messagerie s'ils n'existent pas
   * @private
   */
  private ensureDirectories(): void {
    const dirs = [
      this.messagesPath,
      this.inboxPath,
      this.sentPath,
      this.archivePath
    ];
    
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
          logger.info(`Répertoire créé: ${dir}`);
        } catch (error) {
          logger.error(`Erreur création répertoire ${dir}`, error);
        }
      }
    }
  }

  /**
   * Invalidate the in-memory inbox cache (nuclear option).
   * Prefer targeted updates (addToCache/updateInCache/removeFromCache) for single-message mutations.
   */
  invalidateCache(): void {
    this.inboxCache = null;
    this.inboxFullCache.clear();
    this.cacheBuiltAt = 0;
    this.contentBuiltAt = 0;
    this.lastInboxFileCount = -1;
    this.inboxCachePartial = false;
  }

  /** True while the inbox cache holds only the cold-start recent slice (#3292). */
  isInboxCachePartial(): boolean {
    return this.inboxCachePartial;
  }

  /** Prune expired negative-cache entries. Returns true if any were pruned
   *  (signals a forced rebuild so hydrated files are retried — the count-only
   *  fast path alone would never re-read them, #3205). */
  private pruneNegativeCache(): boolean {
    let pruned = false;
    const now = Date.now();
    for (const [file, failedAt] of this.negativeCache) {
      if (now - failedAt >= this.negativeCacheTtlMs) {
        this.negativeCache.delete(file);
        pruned = true;
      }
    }
    return pruned;
  }

  /** True if the file is in the negative cache (unexpired — pruning happens at build start). */
  private isNegativelyCached(file: string): boolean {
    return this.negativeCache.has(file);
  }

  /**
   * Add a message to the in-memory cache without full rebuild (#809 perf).
   * Called after sendMessage writes to inbox.
   */
  private addToCache(message: Message): void {
    this.inboxFullCache.set(message.id, message);
    if (this.inboxCache) {
      const listItem: MessageListItem = {
        id: message.id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        priority: message.priority,
        timestamp: message.timestamp,
        status: message.status,
        preview: message.body.substring(0, 100) + (message.body.length > 100 ? '...' : '')
      };
      // Insert in sorted position (most recent first)
      const insertIdx = this.inboxCache.findIndex(
        item => new Date(message.timestamp).getTime() >= new Date(item.timestamp).getTime()
      );
      if (insertIdx === -1) {
        this.inboxCache.push(listItem);
      } else {
        this.inboxCache.splice(insertIdx, 0, listItem);
      }
    }
    if (this.lastInboxFileCount >= 0) this.lastInboxFileCount++;
  }

  /**
   * Update a message in the in-memory cache without full rebuild (#809 perf).
   * Called after markAsRead, amend, destroy, updateAttachments.
   */
  private updateInCache(messageId: string, message: Message): void {
    this.inboxFullCache.set(messageId, message);
    if (this.inboxCache) {
      const idx = this.inboxCache.findIndex(item => item.id === messageId);
      if (idx !== -1) {
        this.inboxCache[idx] = {
          id: message.id,
          from: message.from,
          to: message.to,
          subject: message.subject,
          priority: message.priority,
          timestamp: message.timestamp,
          status: message.status,
          preview: message.body.substring(0, 100) + (message.body.length > 100 ? '...' : '')
        };
      }
    }
  }

  /**
   * Remove a message from the in-memory cache without full rebuild (#809 perf).
   * Called after archiveMessage removes the file from inbox.
   */
  private removeFromCache(messageId: string): void {
    this.inboxFullCache.delete(messageId);
    if (this.inboxCache) {
      this.inboxCache = this.inboxCache.filter(item => item.id !== messageId);
    }
    if (this.lastInboxFileCount > 0) this.lastInboxFileCount--;
  }

  /**
   * Build or return the cached inbox metadata.
   * Reads all inbox JSON files once, caches results for CACHE_TTL_MS.
   * Uses file count as a cheap invalidation heuristic for external changes.
   * #3292: a COLD start parses only the COLD_START_SLICE_SIZE most recent files
   * synchronously (ids embed their timestamp, so a lexical sort is a recency
   * sort) and hydrates the rest in the background — the stdio server restarts
   * with every session and the old full-pool cold start cost 48-120 s.
   * `deep: true` opts out of the slice and waits for the full pool.
   * @private
   */
  private async ensureInboxCache(opts?: { deep?: boolean }): Promise<{ items: MessageListItem[]; full: Map<string, Message> }> {
    if (!existsSync(this.inboxPath)) {
      return { items: [], full: new Map() };
    }

    // Fast path: return cached data if still within TTL (skip readdir entirely).
    // #3292: deep never takes this path while the cache holds only the recent
    // slice — it must fall through and join the full-pool hydration below.
    const now = Date.now();
    if (
      this.inboxCache !== null &&
      (now - this.cacheBuiltAt) < MessageManager.CACHE_TTL_MS &&
      !(opts?.deep && this.inboxCachePartial)
    ) {
      return { items: this.inboxCache, full: this.inboxFullCache };
    }

    // TTL expired — check file count for external changes
    const files = (await fs.readdir(this.inboxPath)).filter(f => f.endsWith('.json'));

    // Prune expired negative-cache entries; a prune forces a rebuild so hydrated
    // files are retried (count alone would never trigger one, #3205).
    const negativePruned = this.pruneNegativeCache();

    // If count unchanged and cache exists, refresh TTL without re-reading files.
    // Bounded (#3205 follow-up): the count is blind to IN-PLACE mutations, and
    // this branch renews `cacheBuiltAt`, so on its own it renews indefinitely a
    // cache nothing has revalidated. Past CONTENT_REVALIDATE_MS we fall through
    // to the stale-while-revalidate path below, which serves this same warm
    // cache immediately and re-reads in the background - no caller waits.
    if (
      this.inboxCache !== null &&
      files.length === this.lastInboxFileCount &&
      !negativePruned &&
      (now - this.contentBuiltAt) < MessageManager.CONTENT_REVALIDATE_MS
    ) {
      this.cacheBuiltAt = now;
      return { items: this.inboxCache, full: this.inboxFullCache };
    }

    // #3292 cold start on a big pool: serve a recent slice synchronously, then
    // hydrate the rest in the background. Slice FIRST so its ~2 chunks don't
    // compete with 50 concurrent background reads on a contended DriveFS.
    if (
      this.inboxCache === null &&
      !opts?.deep &&
      files.length > MessageManager.COLD_START_SLICE_SIZE
    ) {
      const sliced = await this.buildRecentSlice(files, now);
      this.startInboxRebuild(files);
      return sliced;
    }

    // Past this point the per-file read phase is required, and it is the only
    // expensive one — the readdir and the count check above stay in the foreground
    // so external-change detection keeps its exact semantics. Two changes (#3205):
    //   - the rebuild is DEDUPLICATED: N concurrent callers trigger one pass, not N;
    //   - a warm cache is served IMMEDIATELY and refreshed in the background.
    // Only a cold cache is awaited, because there is nothing else to hand back.
    // Before this, whichever caller happened to land on an expired TTL paid the
    // whole rebuild and hit its tool timeout, while the retry right behind it got
    // the fast path in ~30ms — the "times out, then instantly fine" signature.
    const rebuild = this.startInboxRebuild(files);
    // deep: never hand back the slice — a partial warm cache is completed by the
    // awaited rebuild (deduped: joins the in-flight pass if there is one).
    if (this.inboxCache !== null && !(opts?.deep && this.inboxCachePartial)) {
      return { items: this.inboxCache, full: this.inboxFullCache };
    }
    return rebuild;
  }

  /**
   * Parse only the N most recent inbox files and install them as a PARTIAL
   * cache (#3292). `lastInboxFileCount = -1` defeats the count fast-path so the
   * next expired-TTL call rejoins the background hydration instead of trusting
   * the slice as complete.
   *
   * @private
   */
  private async buildRecentSlice(allFiles: string[], now: number): Promise<{ items: MessageListItem[]; full: Map<string, Message> }> {
    const recent = [...allFiles]
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MessageManager.COLD_START_SLICE_SIZE);
    const readable = recent.filter(f => !this.isNegativelyCached(f));
    const { items, full } = await this.parseInboxFiles(readable, now + this.rebuildBudgetMs);

    this.inboxCache = items;
    this.inboxFullCache = full;
    this.cacheBuiltAt = now;
    this.contentBuiltAt = now;
    this.lastInboxFileCount = -1;
    this.inboxCachePartial = true;
    logger.info(`Inbox cold start: recent slice served (${items.length} msgs from ${readable.length}/${allFiles.length} files) — full pool hydrating in background (#3292)`);

    return { items, full };
  }

  /**
   * Start a rebuild, or join the one already running (#3205).
   *
   * @private
   */
  private startInboxRebuild(files: string[]): Promise<{ items: MessageListItem[]; full: Map<string, Message> }> {
    if (this.inboxRebuildInFlight) {
      return this.inboxRebuildInFlight;
    }
    const pass = this.rebuildInboxCache(files);
    this.inboxRebuildInFlight = pass;
    // Settle a DERIVED chain, never `pass` itself: a background refresh that
    // rejects with nobody awaiting it is an unhandled rejection, which takes the
    // process down. Callers awaiting `pass` still observe the original rejection.
    void pass
      .catch(err => { logger.error('Inbox cache rebuild failed', err); })
      .then(() => { if (this.inboxRebuildInFlight === pass) this.inboxRebuildInFlight = null; });
    return pass;
  }

  /**
   * Read the inbox files and rebuild the cache. Bounded by
   * INBOX_REBUILD_BUDGET_MS; a truncated pass never replaces a more complete cache.
   *
   * @private
   */
  private async rebuildInboxCache(files: string[]): Promise<{ items: MessageListItem[]; full: Map<string, Message> }> {
    const now = Date.now();

    // Skip files that failed a recent read (negative cache): a cloud-only GDrive
    // file that timed out once will usually time out again for a while, and
    // re-reading it every 5-min rebuild burns ~10s on a read that can't succeed.
    const readableFiles = files.filter(f => !this.isNegativelyCached(f));
    const skippedCount = files.length - readableFiles.length;

    logger.info(`Building inbox cache (${readableFiles.length} files${skippedCount ? `, ${skippedCount} skipped (negative cache)` : ''}, concurrency=${MessageManager.READ_CONCURRENCY})`);

    const deadline = now + this.rebuildBudgetMs;
    const { items, full, truncated } = await this.parseInboxFiles(readableFiles, deadline);

    if (truncated && this.inboxCache !== null) {
      // A truncated pass is a SUBSET. Installing it would turn a complete cache
      // into a partial one — a regression no caller can see. Keep what we have;
      // -1 defeats the count check so the next call rebuilds, while the TTL still
      // throttles how often that happens.
      this.lastInboxFileCount = -1;
      this.cacheBuiltAt = now;
      return { items: this.inboxCache, full: this.inboxFullCache };
    }

    this.inboxCache = items;
    this.inboxFullCache = full;
    this.cacheBuiltAt = now;
    this.contentBuiltAt = now;
    // On a cold-start truncation there is nothing better to serve, so the partial
    // result IS installed — and it must be FLAGGED as such. `false` here would
    // hand a truncated pool to the caller labelled complete, which is exactly the
    // reading this flag exists to prevent. -1 forces the next call to finish the job.
    this.inboxCachePartial = truncated;
    this.lastInboxFileCount = truncated ? -1 : files.length;

    return { items, full };
  }

  /**
   * Parallel chunked read+parse of inbox files (#3292: extracted so the cold-start
   * recent slice and the full rebuild share the exact same per-file semantics —
   * read timeout, negative cache, phantom guard, sort).
   *
   * @private
   */
  private async parseInboxFiles(
    readableFiles: string[],
    deadline: number
  ): Promise<{ items: MessageListItem[]; full: Map<string, Message>; truncated: boolean }> {
    const items: MessageListItem[] = [];
    const full = new Map<string, Message>();
    let truncated = false;

    // Parallel chunked reads — 50 concurrent instead of serial (84s → ~2s on GDrive)
    for (let i = 0; i < readableFiles.length; i += MessageManager.READ_CONCURRENCY) {
      if (Date.now() >= deadline) {
        truncated = true;
        logger.warn(`Inbox cache rebuild hit its budget after ${i}/${readableFiles.length} files - returning early (#3205)`);
        break;
      }
      const chunk = readableFiles.slice(i, i + MessageManager.READ_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async file => {
          // Bound each read against GDrive cloud-only hangs: allSettled waits
          // for every file in the chunk, so one hung read would wedge the whole
          // chunk (and thus inbox listing + the 3 cleanup ops) until the 120s
          // MCP tool timeout. On timeout, throw → this becomes a rejected
          // settled result → the existing rejected-handler below logs + skips
          // the file, so the inbox returns a partial result (#818 / #2267).
          const content = await withReadTimeout(
            fs.readFile(join(this.inboxPath, file), 'utf-8'),
            this.readTimeoutMs,
          );
          if (content === null) {
            throw new Error(`Inbox file read timed out (cloud-only?): ${file}`);
          }
          const message: Message = JSON.parse(content);
          return message;
        })
      );
      for (let r = 0; r < results.length; r++) {
        const result = results[r];
        if (result.status === 'fulfilled') {
          const message = result.value;
          // Read succeeded — clear any negative-cache entry so a recovered file is
          // not skipped on the next build (#3205).
          this.negativeCache.delete(chunk[r]);
          // Phantom-message guard: the inbox is LISTED by each file's internal `id`,
          // but every mutation (getMessage/markAsRead/archiveMessage/destroyMessage)
          // locates the file by reconstructing `inbox/${id}.json`. A file whose name
          // does not match its `id` is therefore listed forever yet can never be
          // opened, marked read, or archived — a silent un-actionable phantom.
          // Skip such files from the listing and warn so the operator can archive/rename.
          const fileName = chunk[r];
          if (fileName !== `${message.id}.json`) {
            logger.warn(`Inbox file name/id mismatch — skipping to avoid phantom listing: file="${fileName}", id="${message.id}" (expected "${message.id}.json"). Archive or rename this file.`);
            continue;
          }
          full.set(message.id, message);
          items.push({
            id: message.id,
            from: message.from,
            to: message.to,
            subject: message.subject,
            priority: message.priority,
            timestamp: message.timestamp,
            status: message.status,
            preview: message.body.substring(0, 100) + (message.body.length > 100 ? '...' : '')
          });
        } else {
          const failedFile = chunk[r] ? join(this.inboxPath, chunk[r]) : 'unknown';
          // Record the read failure so the file is skipped on subsequent rebuilds
          // until the window elapses (or it reads successfully), #3205.
          if (chunk[r]) {
            this.negativeCache.set(chunk[r], Date.now());
          }
          logger.error(`Error reading message file during parallel cache build: ${failedFile}`, result.reason);
        }
      }
    }

    // Sort by timestamp descending (most recent first) once
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { items, full, truncated };
  }

  /**
   * Génère un ID unique pour un message
   * Format: msg-YYYYMMDDHHMMSS-{random}
   *
   * @returns ID unique du message
   * @private
   */
  private generateMessageId(): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:.]/g, '')
      .slice(0, 15); // YYYYMMDDHHmmssS
    const random = Math.random().toString(36).substring(2, 8);
    return `msg-${timestamp}-${random}`;
  }

  /**
   * Envoie un message à une autre machine
   * 
   * Crée le message dans l'inbox du destinataire et dans
   * le répertoire sent de l'expéditeur.
   * 
   * @param from ID de la machine émettrice
   * @param to ID de la machine destinataire
   * @param subject Sujet du message
   * @param body Corps du message (markdown supporté)
   * @param priority Priorité du message (défaut: MEDIUM)
   * @param tags Tags optionnels
   * @param threadId ID du thread de conversation
   * @param replyTo ID du message auquel on répond
   * @returns Le message créé
   */
  /**
   * Parse a duration string (e.g. "30m", "2h", "1d") to milliseconds.
   * Supported units: m (minutes), h (hours), d (days).
   * @returns Duration in ms, or null if invalid
   */
  static parseDuration(duration: string): number | null {
    const match = duration.match(/^(\d+)(m|h|d)$/);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return null;
    }
  }

  async sendMessage(
    from: string,
    to: string,
    subject: string,
    body: string,
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM',
    tags?: string[],
    threadId?: string,
    replyTo?: string,
    options?: {
      auto_destruct?: boolean;
      destruct_after_read_by?: string[];
      destruct_after?: string;
    }
  ): Promise<Message> {
    logger.info(`Sending message from ${from} to ${to}`);

    // #3292 canonicalization: rewrite legacy short forms ("po-2024", "ai-01")
    // and capitalization variants to their canonical machineId before any
    // validation. Without this, every new message would re-pollute the inbox
    // with non-canonical `to` values, defeating both the sharding layout and
    // the matchesRecipient fix on the read side.
    from = canonicalizeFullId(from);
    to = canonicalizeFullId(to);

    // Validation anti-auto-messages (workspace-aware)
    // Same machine + same workspace = blocked
    // Same machine + different workspace = allowed
    const fromParsed = parseMachineWorkspace(from);
    const toParsed = parseMachineWorkspace(to);
    if (fromParsed.machineId === toParsed.machineId &&
        fromParsed.workspaceId === toParsed.workspaceId) {
      throw new MessageManagerError(
        `Auto-message interdit : ${from} ne peut pas envoyer de message à ${to}`,
        MessageManagerErrorCode.INVALID_RECIPIENT,
        { from, to, type: 'self-message' }
      );
    }

    // Dashed Claude-projects keys (e.g. "c--dev-roo-extensions") never match the
    // receiver's auto-detected workspace (a basename like "roo-extensions"), so
    // the recipient's inbox would list the message while getMessage/mark_read
    // deny it — the phantom "listed but introuvable" (friction po-204). Reject
    // at the source: the convention is machine[:workspace-basename].
    if (toParsed.workspaceId && /^[a-zA-Z]--/.test(toParsed.workspaceId)) {
      throw new MessageManagerError(
        `Destinataire invalide : « ${to} » cible la clé dashée « ${toParsed.workspaceId} », que le destinataire ne pourra jamais faire correspondre à son workspace auto-détecté. ` +
        `Convention : « machine » (toute la machine) ou « machine:basename-du-workspace » (ex. « myia-po-2024:roo-extensions »).`,
        MessageManagerErrorCode.INVALID_RECIPIENT,
        { from, to, type: 'dashed-workspace-key' }
      );
    }

    // Compute expires_at from destruct_after TTL
    let expiresAt: string | undefined;
    if (options?.destruct_after) {
      const ms = MessageManager.parseDuration(options.destruct_after);
      if (ms === null) {
        throw new MessageManagerError(
          `Invalid destruct_after format: "${options.destruct_after}". Use "30m", "2h", or "1d".`,
          MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
          { destruct_after: options.destruct_after }
        );
      }
      expiresAt = new Date(Date.now() + ms).toISOString();
    }

    const message: Message = {
      id: this.generateMessageId(),
      from,
      to,
      subject,
      body,
      priority,
      timestamp: new Date().toISOString(),
      status: 'unread',
      tags,
      thread_id: threadId,
      reply_to: replyTo,
      ...(options?.auto_destruct ? {
        auto_destruct: true,
        ...(options.destruct_after_read_by ? { destruct_after_read_by: options.destruct_after_read_by } : {}),
        ...(options.destruct_after ? { destruct_after: options.destruct_after } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {})
      } : {})
    };

    try {
      // #3151 Phase D — PG-primary write: persist to roosync_messages and
      // skip the GDrive files entirely (GDrive = read-only legacy archive).
      // insertRooSyncMessagePrimary returns false on PG failure, falling
      // through to the file path below — the send is never lost.
      if (isChannelPgPrimary() && await insertRooSyncMessagePrimary(message)) {
        this.addToCache(message);
        logger.info(`Message sent (PG primary): ${message.id}`);
        return message;
      }

      // Sauvegarder dans inbox du destinataire
      const inboxFile = join(this.inboxPath, `${message.id}.json`);
      await fs.writeFile(inboxFile, JSON.stringify(message, null, 2), 'utf-8');
      logger.info(`Message saved to inbox: ${inboxFile}`);

      // Sauvegarder dans sent de l'expéditeur
      const sentFile = join(this.sentPath, `${message.id}.json`);
      await fs.writeFile(sentFile, JSON.stringify(message, null, 2), 'utf-8');
      logger.info(`Message saved to sent: ${sentFile}`);

      this.addToCache(message);
      // #3151 Phase A: dual-write to PG (fire-and-forget, env-gated, never blocks GDrive)
      dualWriteRooSyncMessageToStore(message).catch(() => {});
      logger.info(`Message sent successfully: ${message.id}`);
      return message;
    } catch (error) {
      logger.error('Error sending message', error);
      throw error;
    }
  }

  /**
   * Met à jour les pièces jointes d'un message existant (#674)
   *
   * Met à jour les fichiers dans inbox/ et sent/ pour ajouter les refs d'attachments.
   *
   * @param messageId ID du message à mettre à jour
   * @param attachments Liste des références d'attachments à ajouter
   * @returns true quand les refs sont persistées dans au moins un store que la
   *   lecture consulte (fichiers GDrive ou row PG-primary). false = refs
   *   perdues : update PG-primary échoué ET aucun fichier écrit (#3270) —
   *   les blobs existent dans le store mais ne sont référencés nulle part.
   */
  async updateMessageAttachments(
    messageId: string,
    attachments: Array<{ uuid: string; filename: string; sizeBytes: number }>
  ): Promise<boolean> {
    const locations = [
      join(this.inboxPath, `${messageId}.json`),
      join(this.sentPath, `${messageId}.json`),
    ];

    let filesPersisted = false;
    for (const filePath of locations) {
      if (!existsSync(filePath)) continue;
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const msg: Message = JSON.parse(raw);
        msg.attachments = attachments;
        await fs.writeFile(filePath, JSON.stringify(msg, null, 2), 'utf-8');
        filesPersisted = true;
      } catch (err) {
        logger.warn(`Failed to update attachments in ${filePath}`, err as Record<string, any>);
      }
    }
    // Targeted update: refresh cached message from the file we just wrote
    for (const filePath of locations) {
      if (existsSync(filePath) && filePath.startsWith(this.inboxPath)) {
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const msg: Message = JSON.parse(raw);
          this.updateInCache(messageId, msg);
        } catch { /* non-critical */ }
      }
    }
    // #3151 Phase A: refresh attachment_refs on the PG copy (fire-and-forget).
    // Phase D: when PG is primary the files above are usually absent — the
    // PG row is then the ONLY copy of the refs, so the update is awaited AND
    // its result is read (#3270): false = refs persisted nowhere. When the
    // send fell back to the GDrive files (PG insert failed), those files
    // carry the refs — PG failure is then a degradation, not a loss.
    if (isChannelPgPrimary()) {
      const pgPersisted = await updateRooSyncMessagePrimary(
        messageId,
        { attachment_refs: attachments ?? [] }
      );
      return pgPersisted || filesPersisted;
    }
    dualWriteRooSyncAttachmentRefs(messageId, attachments).catch(() => {});
    return true;
  }

  /**
   * Lit la boîte de réception d'une machine
   *
   * Filtre les messages par destinataire et statut, puis les trie
   * par ordre chronologique décroissant (plus récents en premier).
   *
   * Supporte le format workspace: "machineId:workspaceId"
   * - Messages à "machineId" (sans workspace) → visibles par tous les workspaces
   * - Messages à "machineId:workspaceId" → visibles uniquement par ce workspace
   * - Messages à "all" → visibles par tous
   *
   * @param machineId ID de la machine destinataire
   * @param status Filtrer par statut (unread, read, all)
   * @param limit Nombre maximum de messages à retourner
   * @param workspaceId ID optionnel du workspace pour filtrage
   * @returns Liste des messages correspondants
   */
  async readInbox(
    machineId: string,
    status?: 'unread' | 'read' | 'all',
    limit?: number,
    workspaceId?: string,
    page?: number,
    perPage?: number,
    deep?: boolean,
    fromFilter?: string,
    subjectFilter?: string
  ): Promise<MessageListItem[]> {
    const effectiveWorkspaceId = workspaceId;
    logger.info(`Reading inbox for: ${machineId}${effectiveWorkspaceId ? ':' + effectiveWorkspaceId : ''}`, { fromFilter, subjectFilter });

    // #3151 Phase B — PG-primary read (env-gated). null = PG unavailable →
    // dégradation gracieuse vers GDrive ci-dessous.
    const pgReader = getChannelPgReader();
    if (pgReader) {
      const startedAt = Date.now();
      const pgItems = await readChannelInboxFromPg(pgReader, machineId, status, effectiveWorkspaceId);
      if (pgItems !== null) {
        // #3351: filters apply BEFORE pagination so limit/page slice the
        // filtered set on the PG path too, never the raw one.
        const matching = this.applyInboxFilters(pgItems, fromFilter, subjectFilter);
        logger.info(
          `[channel-pg] inbox served from PG in ${Date.now() - startedAt}ms (${matching.length}/${pgItems.length} items)`
        );
        return this.paginateItems(matching, limit, page, perPage);
      }
      logger.warn('[channel-pg] PG mailbox read failed — falling back to GDrive');
    }

    try {
      // Use cached data (#638 perf optimization). deep: skip the #3292 cold-start
      // recent slice and wait for the full pool instead.
      const { items, full } = await this.ensureInboxCache({ deep });

      if (items.length === 0) {
        return [];
      }

      // Filter from cache (items are already sorted by timestamp desc)
      const filtered: MessageListItem[] = [];

      for (const item of items) {
        // Filter by recipient (workspace-aware) — need full message for broadcast read_by
        const fullMsg = full.get(item.id);
        if (!fullMsg) continue;

        if (!matchesRecipient(fullMsg.to, machineId, effectiveWorkspaceId)) {
          continue;
        }

        // Filter by status — per-machine for broadcasts (#629)
        if (status && status !== 'all') {
          const perReader = perReaderStatus(fullMsg, machineId, effectiveWorkspaceId);
          if (perReader !== null) {
            if (perReader !== status) continue;
          } else {
            if (fullMsg.status !== status) continue;
          }
        }

        // #2307 Phase 4: For broadcast messages, adjust status per-machine so
        // callers (read.ts inbox display) see the correct read/unread state.
        // Without this, broadcast messages always show "unread" even after being read.
        const perReader = perReaderStatus(fullMsg, machineId, effectiveWorkspaceId);
        if (perReader !== null) {
          filtered.push({ ...item, status: perReader });
        } else {
          filtered.push(item);
        }
      }

      // #3351: sender/subject filters — applied BEFORE pagination (#638) so
      // limit/page slice the FILTERED set. Semantics mirror bulkOperation
      // (case-insensitive substring, AND logic) so both surfaces read the
      // pool the same way.
      const matching = this.applyInboxFilters(filtered, fromFilter, subjectFilter);

      // Apply pagination (#638)
      const result = this.paginateItems(matching, limit, page, perPage);

      logger.info(`Returning ${result.length}/${matching.length} messages (cached)`);
      return result;
    } catch (error) {
      logger.error('Error reading inbox', error);
      return [];
    }
  }

  /**
   * #3351: inbox sender/subject predicates, shared by the PG and cache read
   * paths. Case-insensitive substring match, AND logic when both provided —
   * the exact semantics of bulkOperation's filters.
   */
  private applyInboxFilters(
    items: MessageListItem[],
    fromFilter?: string,
    subjectFilter?: string
  ): MessageListItem[] {
    if (!fromFilter && !subjectFilter) return items;
    const from = fromFilter?.toLowerCase();
    const subject = subjectFilter?.toLowerCase();
    return items.filter(m =>
      (!from || m.from.toLowerCase().includes(from)) &&
      (!subject || m.subject.toLowerCase().includes(subject))
    );
  }

  /**
   * Shared pagination for the inbox read paths (#638 semantics, unchanged):
   * explicit page/perPage first, then limit, then everything.
   */
  private paginateItems(
    items: MessageListItem[],
    limit?: number,
    page?: number,
    perPage?: number
  ): MessageListItem[] {
    if (page !== undefined && perPage !== undefined && perPage > 0) {
      const startIdx = (page - 1) * perPage;
      return items.slice(startIdx, startIdx + perPage);
    }
    if (limit) {
      return items.slice(0, limit);
    }
    return items;
  }

  /**
   * Returns the total count of filtered messages (for pagination metadata).
   * Uses the same cache as readInbox for consistency.
   */
  async getFilteredCount(
    machineId: string,
    status?: 'unread' | 'read' | 'all',
    workspaceId?: string,
    deep?: boolean
  ): Promise<{ total: number; unread: number; read: number }> {
    const effectiveWorkspaceId = workspaceId;

    // #3151 Phase B — PG-primary count, GDrive fallback.
    const pgReader = getChannelPgReader();
    if (pgReader) {
      const pgCounts = await countChannelInboxFromPg(pgReader, machineId, effectiveWorkspaceId);
      if (pgCounts !== null) return pgCounts;
      logger.warn('[channel-pg] PG mailbox count failed — falling back to GDrive');
    }

    const { items, full } = await this.ensureInboxCache({ deep });

    let total = 0;
    let unread = 0;
    let read = 0;

    for (const item of items) {
      const fullMsg = full.get(item.id);
      if (!fullMsg) continue;
      if (!matchesRecipient(fullMsg.to, machineId, effectiveWorkspaceId)) continue;

      total++;
      const perReader = perReaderStatus(fullMsg, machineId, effectiveWorkspaceId);
      const isUnreadForMachine =
        perReader !== null ? perReader === 'unread' : fullMsg.status === 'unread';

      if (isUnreadForMachine) unread++;
      else read++;
    }

    return { total, unread, read };
  }

  /**
   * #2287 access check shared by the PG and GDrive read paths of `getMessage`:
   * allow if the caller is the recipient (workspace-aware) or the sender.
   * No callerId → allow (backward compat, matches the original behavior).
   */
  private callerCanAccessMessage(message: Message, callerId?: string): boolean {
    if (!callerId) return true;
    const caller = parseMachineWorkspace(callerId);
    const isRecipient = matchesRecipient(message.to, caller.machineId, caller.workspaceId);
    const isSender = parseMachineWorkspace(message.from).machineId === caller.machineId;
    return isRecipient || isSender;
  }

  /**
   * #2287 denied path — throw instead of returning null. A null from getMessage
   * renders as "Message introuvable / peut-être supprimé" in every tool, which
   * lied about messages that exist and are simply addressed elsewhere (po-204:
   * dashed Claude-projects keys like "c--dev-roo-extensions" never match the
   * receiver's auto-detected workspace basename, so the inbox lists the message
   * while getMessage/mark_read report it missing).
   */
  private accessDeniedError(messageId: string, message: Message, callerId: string): MessageManagerError {
    return new MessageManagerError(
      `Accès refusé : le message ${messageId} existe mais est adressé à « ${message.to} » (expéditeur « ${message.from} ») ; l'appelant est « ${callerId} ». ` +
      `Convention d'adressage : « machine » (toute la machine) ou « machine:basename-du-workspace » (ex. « myia-po-2024:roo-extensions »). ` +
      `Une clé dashée de projet Claude (ex. « c--dev-roo-extensions ») ne correspond jamais au workspace auto-détecté du destinataire — le message apparaît alors dans son inbox mais reste illisible.`,
      MessageManagerErrorCode.ACCESS_DENIED,
      { messageId, to: message.to, from: message.from, caller: callerId }
    );
  }

  /**
   * Obtient un message spécifique par son ID
   *
   * Cherche dans PG (Phase B, env-gated) puis inbox, sent, puis archive.
   * Vérifie que le message est destiné au caller (machine + workspace) (#2287).
   *
   * @param messageId ID du message à récupérer
   * @param callerId ID complet du caller (machine:workspace) pour vérification d'accès
   * @returns Le message complet ou null si introuvable
   * @throws MessageManagerError ACCESS_DENIED si le message existe mais est adressé
   *   à un autre machine:workspace que celui du caller (po-204)
   */
  async getMessage(messageId: string, callerId?: string): Promise<Message | null> {
    logger.info(`Getting message: ${messageId}`);

    // #3151 Phase B — PG-primary lookup. null = PG unavailable OR unknown id;
    // both fall through to the GDrive paths (a miss is a miss on either side).
    //
    // Requires a callerId. On GDrive the filesystem itself was the access
    // boundary — a message addressed elsewhere is simply not in this machine's
    // inbox/sent/archive — which is why `callerCanAccessMessage` can allow a
    // caller that provides no id. `roosync_messages` holds the whole fleet's
    // mail in one table, so that same allowance would hand a foreign message to
    // the five entry points that omit callerId (archive_message,
    // mark_message_read, reply_message, send threading, ToolUsageInterceptor) —
    // all of which read "found" as "it is in my mailbox". Those keep the
    // file-bounded path; only callers that identify themselves get the fast one.
    const pgReader = callerId ? getChannelPgReader() : null;
    if (pgReader) {
      const pgMessage = await getChannelMessageFromPg(pgReader, messageId);
      if (pgMessage) {
        if (!this.callerCanAccessMessage(pgMessage, callerId)) {
          logger.warn(`Access denied: message ${messageId} targets ${pgMessage.to}, caller is ${callerId}`);
          throw this.accessDeniedError(messageId, pgMessage, callerId!);
        }
        logger.info(`Message served from PG: ${messageId}`);
        return pgMessage;
      }
      logger.info(`[channel-pg] message not in PG (or PG down) — trying GDrive paths: ${messageId}`);
    }

    const searchPaths = [
      join(this.inboxPath, `${messageId}.json`),
      join(this.sentPath, `${messageId}.json`),
      join(this.archivePath, `${messageId}.json`)
    ];

    for (const filePath of searchPaths) {
      if (existsSync(filePath)) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const message: Message = JSON.parse(content);
          logger.info(`Message found in: ${filePath}`);

          // #2287: Verify workspace access — allow if caller is recipient OR sender
          if (!this.callerCanAccessMessage(message, callerId)) {
            logger.warn(`Access denied: message ${messageId} targets ${message.to}, caller is ${callerId}`);
            throw this.accessDeniedError(messageId, message, callerId!);
          }

          return message;
        } catch (error) {
          // po-204: the access-denied throw above is a protocol error, not a
          // filesystem error — never swallow it into "try the next path".
          if (error instanceof MessageManagerError) throw error;
          logger.error(`Error reading message from ${filePath}`, error);
        }
      }
    }

    logger.warn(`Message not found: ${messageId}`);

    // #2307 Phase 4: If message was in cache but not on disk, it was likely
    // auto-archived between cache build and this call. Return the cached copy
    // (marked as archived) so callers can handle it as "already processed"
    // instead of returning "Message introuvable" to the agent.
    if (this.inboxFullCache.has(messageId)) {
      logger.info(`Stale cache entry for ${messageId} — returning cached copy as archived`);
      const cached = this.inboxFullCache.get(messageId)!;
      // Force cache rebuild so next call is fresh
      this.inboxCache = null;
      this.inboxFullCache = new Map();
      this.cacheBuiltAt = 0;
      this.contentBuiltAt = 0;
      this.lastInboxFileCount = -1;
      // po-204: the inbox cache can hold messages the caller cannot access
      // (e.g. addressed to a dashed workspace key) — same denial as the disk path.
      if (!this.callerCanAccessMessage(cached, callerId)) {
        throw this.accessDeniedError(messageId, cached, callerId!);
      }
      // Return cached message with archived status so callers treat it as processed
      return { ...cached, status: 'archived' as const };
    }

    return null;
  }

  /**
   * Marque un message comme lu par une machine spécifique.
   *
   * Pour les messages broadcast (to: "all"), utilise le tracking per-machine
   * via read_by[]. Le status global ne passe à 'read' que quand la machine
   * spécifiée a lu (pour les messages ciblés) ou reste 'unread' pour les
   * broadcasts tant que d'autres machines ne l'ont pas lu.
   *
   * @param messageId ID du message à marquer comme lu
   * @param readerId ID de la machine qui lit (optionnel, défaut: machine locale)
   * @returns true si succès, false sinon
   */
  async markAsRead(messageId: string, readerId?: string): Promise<boolean> {
    logger.info(`Marking message as read: ${messageId}${readerId ? ` by ${readerId}` : ''}`);

    // #3151 Phase D — PG-primary mutation: the message lives in
    // roosync_messages (sends skip the files), so load and persist there.
    // Falls back to the file path when the row is unknown (legacy message,
    // GDrive-only) or when the PG update fails — for a PG-only message the
    // fallback then surfaces "not found" and the caller retries.
    if (isChannelPgPrimary()) {
      const reader = getChannelPgReader();
      if (reader) {
        const pgMessage = await getChannelMessageFromPg(reader, messageId);
        if (pgMessage) {
          if (!MessageManager.applyReadTracking(pgMessage, readerId)) {
            return false;
          }
          const isBroadcast = pgMessage.to === 'all' || pgMessage.to === 'All';
          const fields: RooSyncMessageUpdate = isBroadcast
            ? { read_by: pgMessage.read_by ?? [] }
            : { status: 'read', read_at: new Date().toISOString() };
          fields.options = mapMessageToRow(pgMessage).options;
          if (await updateRooSyncMessagePrimary(messageId, fields)) {
            this.updateInCache(messageId, pgMessage);
            // Check auto-destruct conditions after read (#629)
            if (pgMessage.auto_destruct) {
              const shouldDestroy = this.checkAutoDestructCondition(pgMessage);
              if (shouldDestroy) {
                await this.destroyMessage(messageId, shouldDestroy);
              }
            }
            logger.info('Message marked as read (PG primary)');
            return true;
          }
          logger.warn(`[channel-pg] markAsRead: PG update failed for ${messageId} — trying GDrive path`);
        }
      }
    }

    const filePath = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(filePath)) {
      // Phantom message fix (#2307 Phase 4): message may have been auto-archived
      // between cache build and this mutation. Check archive for idempotency.
      const archiveFile = join(this.archivePath, `${messageId}.json`);
      if (existsSync(archiveFile)) {
        logger.info(`Message found in archive (already processed): ${messageId}`);
        return true;
      }
      logger.warn(`Message not found in inbox or archive: ${messageId}`);
      return false;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const message: Message = JSON.parse(content);

      // #2287 guards + #629 per-machine tracking + targeted status flip —
      // shared with the PG-primary branch via applyReadTracking.
      if (!MessageManager.applyReadTracking(message, readerId)) {
        return false;
      }
      const isBroadcast = message.to === 'all' || message.to === 'All';

      await fs.writeFile(filePath, JSON.stringify(message, null, 2), 'utf-8');

      // #3151 Phase A.2/B — mirror the read transition. Targeted messages flip
      // status=read; broadcasts mirror `read_by` instead (migrations/005), since
      // a global 'read' would hide them from machines that have not read them.
      if (isBroadcast) {
        dualWriteRooSyncMessageBroadcastRead(messageId, message.read_by ?? []).catch(() => {});
      } else if (isMachineWideTarget(message.to)) {
        // Per-workspace read state has no PG column yet (migrations/005 mirrors
        // read_by only). Mirroring status=read here would reintroduce, in PG,
        // exactly the global flip this change removes - so mirror NOTHING and
        // leave GDrive authoritative for this class. PG channel reads are off.
        // TODO(#3151): add a read_by_workspace column, then mirror it here.
      } else {
        dualWriteRooSyncMessageRead(messageId).catch(() => {});
      }

      // Also update sent/ directory if message was sent from this machine
      const sentPath = join(this.sentPath, `${messageId}.json`);
      if (existsSync(sentPath)) {
        await fs.writeFile(sentPath, JSON.stringify(message, null, 2), 'utf-8');
        logger.info('Message also updated in sent/');
      }

      this.updateInCache(messageId, message);

      // Check auto-destruct conditions after read (#629)
      if (message.auto_destruct) {
        const shouldDestroy = this.checkAutoDestructCondition(message);
        if (shouldDestroy) {
          await this.destroyMessage(messageId, shouldDestroy);
        }
      }

      logger.info('Message marked as read');
      return true;
    } catch (error) {
      logger.error('Error marking message as read', error);
      return false;
    }
  }

  /**
   * Shared read-tracking mutation for markAsRead — #2287 workspace guard,
   * #2287/#629 access check + per-machine read_by/acknowledged_at tracking,
   * and the targeted (non-broadcast) status flip. Applied identically
   * whichever store the message was loaded from (GDrive file or PG row,
   * #3151 Phase D).
   *
   * @returns false when the reader is denied; true with `message` mutated.
   */
  private static applyReadTracking(message: Message, readerId?: string): boolean {
    if (readerId) {
      // #2287: Workspace guard — reject if reader's workspace doesn't match message target
      const readerParsed = parseMachineWorkspace(readerId);
      const isBroadcast = message.to === 'all' || message.to === 'All';
      if (!isBroadcast && readerParsed.workspaceId) {
        const msgTo = message.to;
        // Only check workspace when message targets a specific workspace
        const targetParsed = parseMachineWorkspace(msgTo);
        if (targetParsed.workspaceId) {
          if (normalizeWorkspaceId(readerParsed.workspaceId) !== normalizeWorkspaceId(targetParsed.workspaceId)) {
            logger.warn(`Workspace mismatch: reader ${readerId} tried to mark message for ${msgTo} — rejected`);
            return false;
          }
        }
      }

      const readerMachineId = readerParsed.machineId;
      const readerWorkspaceId = readerParsed.workspaceId;

      // #2287: Verify the caller has access to this message before marking read.
      // Allow if: matches recipient OR is in destruct_after_read_by (auto-destruct authorized reader)
      const isRecipient = matchesRecipient(message.to, readerMachineId, readerWorkspaceId);
      const isAuthorizedReader = message.destruct_after_read_by?.includes(readerMachineId) ?? false;
      if (!isRecipient && !isAuthorizedReader) {
        logger.warn(`markAsRead denied: message ${message.id} targets ${message.to}, reader is ${readerId}`);
        return false;
      }

      if (!message.read_by) {
        message.read_by = [];
      }
      if (!message.read_by.includes(readerMachineId)) {
        message.read_by.push(readerMachineId);
      }
      if (!message.acknowledged_at) {
        message.acknowledged_at = {};
      }
      if (!message.acknowledged_at[readerMachineId]) {
        message.acknowledged_at[readerMachineId] = new Date().toISOString();
      }
      logger.info(`Reader ${readerMachineId} tracked in read_by (${message.read_by.length} readers)`);

      // Machine-wide target: also track the READER'S WORKSPACE, so the other
      // workspaces of the same machine keep seeing the message as unread.
      if (isMachineWideTarget(message.to) && readerWorkspaceId) {
        if (!message.read_by_workspace) {
          message.read_by_workspace = [];
        }
        const fullReader = canonicalizeFullId(readerMachineId + ':' + readerWorkspaceId);
        if (!message.read_by_workspace.includes(fullReader)) {
          message.read_by_workspace.push(fullReader);
        }
      }
    }

    // For workspace-targeted messages, set global status to 'read'.
    // Two classes keep status as-is because their readers are tracked individually:
    //   - broadcasts ("all"/"All")     -> read_by, per machine (#629)
    //   - machine-wide ("myia-ai-01")  -> read_by_workspace, per workspace
    // A global flip on either would hide the message from readers who never saw it.
    const isBroadcast = message.to === 'all' || message.to === 'All';
    const machineWide = isMachineWideTarget(message.to);
    // A reader without a workspace cannot be tracked per workspace: fall back to
    // the global flip so the message can still be cleared at all.
    const trackedPerWorkspace =
      machineWide && !!parseMachineWorkspace(readerId ?? '').workspaceId;
    if (!isBroadcast && !trackedPerWorkspace) {
      message.status = 'read';
    }
    return true;
  }

  /**
   * Check if auto-destruct conditions are met for a message.
   * @returns The destruction reason, or null if not yet ready
   */
  private checkAutoDestructCondition(message: Message): 'read_by_recipient' | 'read_by_all' | null {
    if (!message.auto_destruct) return null;

    // Mode: destruct after specific readers
    if (message.destruct_after_read_by && message.destruct_after_read_by.length > 0) {
      const readBy = message.read_by || [];
      const allRead = message.destruct_after_read_by.every(m => readBy.includes(m));
      return allRead ? 'read_by_all' : null;
    }

    // Mode: destruct after recipient reads (default auto-destruct)
    const isBroadcast = message.to === 'all' || message.to === 'All';
    if (isBroadcast) {
      // For broadcasts, no auto-destruct on single read (need destruct_after_read_by)
      return null;
    }

    // For targeted messages: destruct when the recipient has read
    const recipientMachine = parseMachineWorkspace(message.to).machineId;
    const readBy = message.read_by || [];
    return readBy.includes(recipientMachine) ? 'read_by_recipient' : null;
  }

  /**
   * Destroy a message: wipe body content but keep metadata for traceability.
   * The message file remains but with body replaced by "[DESTROYED]".
   *
   * @param messageId ID of the message to destroy
   * @param reason Reason for destruction
   * @returns true if success
   */
  async destroyMessage(
    messageId: string,
    reason: 'read_by_recipient' | 'read_by_all' | 'ttl_expired'
  ): Promise<boolean> {
    logger.info(`Destroying message ${messageId} (reason: ${reason})`);

    // #3151 Phase D — PG-primary mutation: destroy the PG row (payload purge
    // first, stamp second). Legacy GDrive attachment blobs are purged too —
    // attachments still land on GDrive until their own follow-up phase, and a
    // secret that survives one layer down is the exact defect the survivors
    // guard exists for. Falls back to the file path when the row is unknown
    // or the PG write fails.
    if (isChannelPgPrimary()) {
      const reader = getChannelPgReader();
      if (reader) {
        const pgMessage = await getChannelMessageFromPg(reader, messageId);
        if (pgMessage) {
          if (pgMessage.destroyed_at) {
            logger.info(`Message ${messageId} already destroyed (PG)`);
            return true;
          }
          const attachmentRefs = pgMessage.attachments ?? [];
          const survivors: string[] = [];
          for (const ref of attachmentRefs) {
            try {
              // GDrive blob (legacy copies; absent = success, destruction is
              // idempotent — same contract as the file path below)
              const meta = await this.attachmentManager.getAttachmentMetadata(ref.uuid);
              if (meta !== null) {
                await this.attachmentManager.deleteAttachment(ref.uuid);
              }
            } catch (error) {
              survivors.push(ref.uuid);
              logger.error(`Failed to purge GDrive attachment ${ref.uuid} of ${messageId}`, error);
            }
          }
          if (survivors.length > 0) {
            logger.error(
              `Message ${messageId} NOT destroyed (PG primary): ${survivors.length}/${attachmentRefs.length} ` +
                `GDrive attachment(s) survived (${survivors.join(', ')}). Left un-stamped for retry.`
            );
            return false;
          }
          if (await destroyRooSyncMessageInStore(
            messageId,
            reason,
            attachmentRefs.map((ref) => ref.uuid)
          )) {
            this.updateInCache(messageId, {
              ...pgMessage,
              body: '[DESTROYED]',
              destroyed_at: new Date().toISOString(),
              destroyed_reason: reason,
            });
            logger.info(`Message ${messageId} destroyed (PG primary, ${reason})`);
            return true;
          }
          logger.warn(`[channel-pg] destroy: PG failed for ${messageId} — trying GDrive path`);
        }
      }
    }

    const filePath = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(filePath)) {
      logger.warn(`Message not found for destruction: ${messageId}`);
      return false;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const message: Message = JSON.parse(content);

      // Already destroyed
      if (message.destroyed_at) {
        logger.info(`Message ${messageId} already destroyed`);
        return true;
      }

      // Purge attachment blobs BEFORE stamping `destroyed_at`.
      //
      // Until this was wired, destruction wiped only `body` and left every attached
      // file in clear on the shared store — while the attachment is precisely the
      // channel mandated for secrets (value in the attachment, never in the indexed
      // body). The one payload that had to be purged was the only one that never was,
      // and `destroy_after` therefore bounded nothing.
      //
      // Ordering is deliberate: purge first, stamp second. A failure here leaves the
      // message un-stamped so the next `cleanupExpiredMessages` retries it. Stamping
      // first and purging best-effort would let us report a destroyed message whose
      // secret is still on disk — the exact defect this fixes, rebuilt one layer up.
      const attachmentRefs = message.attachments ?? [];
      const survivors: string[] = [];
      for (const ref of attachmentRefs) {
        try {
          // A missing attachment is a success, not an error: destruction is idempotent
          // and another machine may have removed it. Without this check the
          // `Attachment introuvable` throw would make cleanup retry the same message
          // on every pass, forever.
          //
          // Known narrow gap, stated rather than papered over: a directory whose
          // `metadata.json` is unreadable also reads as absent here, so a corrupt-metadata
          // blob would be skipped. Deleting on that signal alone would be worse (it would
          // delete on a read failure), so we accept the gap and surface it in the log below.
          const meta = await this.attachmentManager.getAttachmentMetadata(ref.uuid);
          if (meta === null) {
            logger.info(`Attachment ${ref.uuid} already absent for ${messageId}`);
            continue;
          }
          await this.attachmentManager.deleteAttachment(ref.uuid);
        } catch (error) {
          survivors.push(ref.uuid);
          logger.error(`Failed to purge attachment ${ref.uuid} of ${messageId}`, error);
        }
      }

      if (survivors.length > 0) {
        logger.error(
          `Message ${messageId} NOT destroyed: ${survivors.length}/${attachmentRefs.length} ` +
            `attachment(s) survived (${survivors.join(', ')}). Left un-stamped for retry.`
        );
        return false;
      }

      // Wipe sensitive content
      message.body = '[DESTROYED]';
      message.destroyed_at = new Date().toISOString();
      message.destroyed_reason = reason;

      await fs.writeFile(filePath, JSON.stringify(message, null, 2), 'utf-8');

      // Also update sent/ if exists
      const sentPath = join(this.sentPath, `${messageId}.json`);
      if (existsSync(sentPath)) {
        await fs.writeFile(sentPath, JSON.stringify(message, null, 2), 'utf-8');
      }

      // Also update archive/ if exists
      const archivePath = join(this.archivePath, `${messageId}.json`);
      if (existsSync(archivePath)) {
        await fs.writeFile(archivePath, JSON.stringify(message, null, 2), 'utf-8');
      }

      // #3151 Phase A.2 — propagate destruction to PG: wipe the body there too and
      // purge the bytea payloads. Reached only after every GDrive blob was purged
      // (the `survivors` guard above returns early otherwise), so PG is never wiped
      // for a message whose secret is still readable on the share.
      dualWriteRooSyncMessageDestroyed(
        messageId,
        reason,
        attachmentRefs.map((ref) => ref.uuid)
      ).catch(() => {});

      this.updateInCache(messageId, message);
      logger.info(`Message ${messageId} destroyed (${reason})`);
      return true;
    } catch (error) {
      logger.error(`Error destroying message ${messageId}`, error);
      return false;
    }
  }

  /**
   * Clean up expired auto-destruct messages (TTL-based).
   * Scans inbox for messages with expires_at in the past and destroys them.
   *
   * @returns Number of messages destroyed
   */
  async cleanupExpiredMessages(): Promise<number> {
    const now = new Date();
    let destroyed = 0;

    // Use cached inbox data instead of re-scanning GDrive directory
    const { full } = await this.ensureInboxCache();
    for (const message of full.values()) {
      if (message.auto_destruct && message.expires_at && !message.destroyed_at) {
        if (new Date(message.expires_at) <= now) {
          await this.destroyMessage(message.id, 'ttl_expired');
          destroyed++;
        }
      }
    }

    if (destroyed > 0) {
      logger.info(`Cleaned up ${destroyed} expired messages`);
    }
    return destroyed;
  }

  /**
   * Send expiry reminder messages for auto-destruct messages approaching TTL.
   * Reminder threshold: max(5 minutes, TTL × 10%).
   * Each message only gets one reminder (reminder_sent flag).
   *
   * @returns Number of reminders sent
   */
  async sendExpiryReminders(): Promise<number> {
    const now = Date.now();
    let remindersSent = 0;

    // Use cached inbox data instead of re-scanning GDrive directory
    const { full } = await this.ensureInboxCache();

    for (const message of full.values()) {
      // Only for auto-destruct messages with TTL that haven't been destroyed or reminded
      if (!message.auto_destruct || !message.expires_at || !message.destruct_after ||
          message.destroyed_at || message.reminder_sent) {
        continue;
      }

      const expiresAt = new Date(message.expires_at).getTime();
      if (expiresAt <= now) continue; // Already expired, cleanup will handle it

      // Calculate reminder threshold: max(5min, TTL × 10%)
      const ttlMs = MessageManager.parseDuration(message.destruct_after);
      if (!ttlMs) continue;

      const reminderThreshold = Math.max(5 * 60 * 1000, ttlMs * 0.1);
      const timeUntilExpiry = expiresAt - now;

      if (timeUntilExpiry <= reminderThreshold) {
        // Send reminder message
        const minutesLeft = Math.ceil(timeUntilExpiry / 60000);
        const reminderSubject = `[REMINDER] Message "${message.subject}" expires in ${minutesLeft}min`;
        const reminderBody = `⏰ **Rappel d'expiration**\n\nLe message auto-destructeur suivant va expirer :\n\n` +
          `- **ID:** \`${message.id}\`\n` +
          `- **Sujet:** ${message.subject}\n` +
          `- **De:** ${message.from}\n` +
          `- **Expire dans:** ~${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}\n\n` +
          `Lisez-le avant qu'il ne soit détruit automatiquement.`;

        await this.sendMessage(
          'system', message.to, reminderSubject, reminderBody,
          'HIGH', ['auto-destruct-reminder', 'system']
        );

        // Mark reminder as sent on the original message file
        message.reminder_sent = true;
        const msgFileName = `${message.id}.json`;
        const filePath = join(this.inboxPath, msgFileName);
        try {
          await fs.writeFile(filePath, JSON.stringify(message, null, 2));
        } catch {
          // Non-critical: cache is updated, file write may fail
        }

        // #3151 Phase A.2 — mirror the flag so a PG-side sweep does not remind twice.
        dualWriteRooSyncMessageReminderSent(message.id).catch(() => {});

        // Also update sent copy if exists
        const sentFile = join(this.sentPath, msgFileName);
        if (existsSync(sentFile)) {
          try {
            const sentContent = await fs.readFile(sentFile, 'utf-8');
            const sentMessage: Message = JSON.parse(sentContent);
            sentMessage.reminder_sent = true;
            await fs.writeFile(sentFile, JSON.stringify(sentMessage, null, 2));
          } catch {
            // Non-critical
          }
        }

        remindersSent++;
        logger.info(`Sent expiry reminder for message ${message.id} (${minutesLeft}min left)`);
      }
    }

    if (remindersSent > 0) {
      logger.info(`Sent ${remindersSent} expiry reminders`);
    }
    return remindersSent;
  }

  /**
   * Archive un message
   *
   * Déplace le message de l'inbox vers le répertoire archive
   * et met à jour son statut.
   *
   * @param messageId ID du message à archiver
   * @returns true si succès, false sinon
   */
  async archiveMessage(messageId: string): Promise<boolean> {
    logger.info(`Archiving message: ${messageId}`);

    // #3151 Phase D — PG-primary mutation: the archive transition is a row
    // update (status + archived_at), no file move. Idempotent on an already
    // archived row. Falls back to the file path when the row is unknown
    // (legacy message) or the PG write fails.
    if (isChannelPgPrimary()) {
      const reader = getChannelPgReader();
      if (reader) {
        const pgMessage = await getChannelMessageFromPg(reader, messageId);
        if (pgMessage) {
          if (pgMessage.status === 'archived') {
            logger.info(`Message already archived (PG): ${messageId}`);
            return true;
          }
          if (await updateRooSyncMessagePrimary(messageId, {
            status: 'archived',
            archived_at: new Date().toISOString(),
          })) {
            this.removeFromCache(messageId);
            logger.info('Message archived (PG primary)');
            return true;
          }
          logger.warn(`[channel-pg] archive: PG failed for ${messageId} — trying GDrive path`);
        }
      }
    }

    const inboxFile = join(this.inboxPath, `${messageId}.json`);
    if (!existsSync(inboxFile)) {
      // Phantom message fix (#2307 Phase 4): already archived = success (idempotent)
      const archiveFile = join(this.archivePath, `${messageId}.json`);
      if (existsSync(archiveFile)) {
        logger.info(`Message already archived: ${messageId}`);
        return true;
      }
      logger.warn(`Message not found in inbox or archive: ${messageId}`);
      return false;
    }

    try {
      const content = await fs.readFile(inboxFile, 'utf-8');
      const message: Message = JSON.parse(content);
      message.status = 'archived';

      // Déplacer vers archive
      const archiveFile = join(this.archivePath, `${messageId}.json`);
      await fs.writeFile(archiveFile, JSON.stringify(message, null, 2), 'utf-8');

      // Supprimer de inbox
      await fs.unlink(inboxFile);

      // #3151 Phase A.2 — PG equivalent of leaving inbox/. Without it a Phase B
      // mailbox read would keep returning messages the GDrive inbox has already drained.
      dualWriteRooSyncMessageArchived(messageId).catch(() => {});

      // Also update sent/ directory if message was sent from this machine
      const sentPath = join(this.sentPath, `${messageId}.json`);
      if (existsSync(sentPath)) {
        await fs.writeFile(sentPath, JSON.stringify(message, null, 2), 'utf-8');
        logger.info('Message also archived in sent/');
      }

      this.removeFromCache(messageId);
      logger.info('Message archived');
      return true;
    } catch (error) {
      logger.error('Error archiving message', error);
      return false;
    }
  }
  /**
   * Modifie le contenu d'un message envoyé (avant lecture)
   *
   * Permet de corriger un message non lu en préservant le contenu original
   * dans les métadonnées pour traçabilité. Restreint à l'émetteur uniquement.
   *
   * @param messageId ID du message à modifier
   * @param senderId ID de la machine émettrice (pour validation permissions)
   * @param newContent Nouveau contenu du message
   * @param reason Raison de l'amendement (optionnel)
   * @returns Résultat de l'amendement avec métadonnées
   */
  async amendMessage(
    messageId: string,
    senderId: string,
    newContent: string,
    reason?: string
  ): Promise<{
    success: boolean;
    message_id: string;
    amended_at: string;
    reason: string;
    original_content_preserved: boolean;
  }> {
    logger.info(`Amending message: ${messageId}`);

    // #3151 Phase D — PG-primary mutation: amend against the PG row when it
    // exists (validations identical — applyAmendment throws the same errors).
    // Falls back to the file path when the row is unknown or PG fails.
    if (isChannelPgPrimary()) {
      const reader = getChannelPgReader();
      if (reader) {
        const pgMessage = await getChannelMessageFromPg(reader, messageId);
        if (pgMessage) {
          MessageManager.applyAmendment(pgMessage, senderId, newContent, reason);
          if (await updateRooSyncMessagePrimary(messageId, {
            body: pgMessage.body,
            options: mapMessageToRow(pgMessage).options,
          })) {
            this.updateInCache(messageId, pgMessage);
            logger.info('Message amended successfully (PG primary)');
            return {
              success: true,
              message_id: pgMessage.id,
              amended_at: pgMessage.metadata!.amendment_timestamp!,
              reason: pgMessage.metadata!.amendment_reason!,
              original_content_preserved: !!pgMessage.metadata!.original_content
            };
          }
          logger.warn(`[channel-pg] amend: PG failed for ${messageId} — trying GDrive path`);
        }
      }
    }

    // Rechercher le message dans sent/
    const sentFile = join(this.sentPath, `${messageId}.json`);
    
    if (!existsSync(sentFile)) {
      throw new MessageManagerError(
        `Message non trouvé dans sent/ : ${messageId}. Seuls les messages envoyés peuvent être amendés.`,
        MessageManagerErrorCode.MESSAGE_NOT_FOUND,
        { messageId, location: 'sent', action: 'amend' }
      );
    }

    try {
      // Lire le message actuel
      const content = await fs.readFile(sentFile, 'utf-8');
      const message: Message = JSON.parse(content);

      // Validations + mutation — partagées avec la branche PG-primaire
      MessageManager.applyAmendment(message, senderId, newContent, reason);

      // Sauvegarder le message modifié dans sent/
      await fs.writeFile(sentFile, JSON.stringify(message, null, 2), 'utf-8');

      // Également mettre à jour dans inbox/ si le message y est présent
      const inboxFile = join(this.inboxPath, `${messageId}.json`);
      if (existsSync(inboxFile)) {
        await fs.writeFile(inboxFile, JSON.stringify(message, null, 2), 'utf-8');
        logger.info('Message updated in inbox as well');
      }

      this.updateInCache(messageId, message);
      // #3151 Phase A: propagate the amended body to PG (same id, fire-and-forget)
      dualWriteRooSyncMessageAmendment(message).catch(() => {});
      logger.info('Message amended successfully');

      // applyAmendment always assigns metadata — TS can't see it across the call
      const meta = message.metadata!;
      return {
        success: true,
        message_id: message.id,
        amended_at: meta.amendment_timestamp!,
        reason: meta.amendment_reason!,
        original_content_preserved: !!meta.original_content
      };
    } catch (error) {
      logger.error('Error amending message', error);
      throw error;
    }
  }

  /**
   * Shared amend validation + mutation — status must be unread, sender must
   * match at machine level, original content preserved on first amendment.
   * Throws the same MessageManagerErrors from whichever store the message
   * was loaded from (GDrive file or PG row, #3151 Phase D).
   */
  private static applyAmendment(
    message: Message,
    senderId: string,
    newContent: string,
    reason?: string
  ): void {
    if (message.status !== 'unread') {
      throw new MessageManagerError(
        `Impossible d'amender un message déjà lu ou archivé (status: ${message.status}).`,
        MessageManagerErrorCode.INVALID_MESSAGE_FORMAT,
        { messageId: message.id, status: message.status, expectedStatus: 'unread', action: 'amend' }
      );
    }

    // Validation : Vérifier que l'émetteur correspond (comparaison par machineId uniquement)
    // The sender may use a different workspace suffix (e.g., worktree vs main workspace)
    // so we compare at the machine level, not the full "machine:workspace" string
    const messageSender = parseMachineWorkspace(message.from);
    const currentSender = parseMachineWorkspace(senderId);
    if (messageSender.machineId !== currentSender.machineId) {
      throw new MessageManagerError(
        `Permission refusée : seul l'émetteur (${message.from}) peut amender ce message.`,
        MessageManagerErrorCode.MESSAGE_SEND_FAILED,
        { messageId: message.id, expectedSender: message.from, actualSender: currentSender.machineId, action: 'amend' }
      );
    }

    // Préserver le contenu original si c'est le premier amendement
    if (!message.metadata?.amended) {
      message.metadata = {
        ...message.metadata,
        amended: true,
        original_content: message.body
      };
    }

    message.body = newContent;
    message.metadata = {
      ...message.metadata,
      amendment_reason: reason || 'Aucune raison fournie',
      amendment_timestamp: new Date().toISOString()
    };
  }

  /**
   * Vérifie et retourne les nouveaux messages non lus
   *
   * Wrapper de convenance pour obtenir rapidement les messages
   * non lus pour une machine donnée. Utilisé par le système
   * de notifications push.
   *
   * @param machineId ID de la machine destinataire
   * @param workspaceId ID optionnel du workspace pour filtrage
   * @returns Liste des messages non lus
   */
  async checkNewMessages(machineId: string, workspaceId?: string): Promise<MessageListItem[]> {
    logger.info(`Checking for new messages for: ${machineId}${workspaceId ? ':' + workspaceId : ''}`);
    return await this.readInbox(machineId, 'unread', undefined, workspaceId);
  }

  /**
   * Performs a bulk operation (mark_read or archive) on messages matching filter criteria.
   *
   * All filter criteria are ANDed together. Only messages matching ALL criteria are affected.
   *
   * @param machineId ID of the receiving machine
   * @param operation Operation to perform: 'mark_read' or 'archive'
   * @param filters Filter criteria
   * @param workspaceId Optional workspace ID for recipient filtering
   * @returns Summary of the operation
   */
  async bulkOperation(
    machineId: string,
    operation: 'mark_read' | 'archive',
    filters: {
      /** Filter by sender machine ID (substring match) */
      from?: string;
      /** Filter by priority level */
      priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
      /** Filter by messages older than this ISO date */
      before_date?: string;
      /** Filter by subject substring (case-insensitive) */
      subject_contains?: string;
      /** Filter by tag */
      tag?: string;
      /** Only affect messages with this status */
      status?: 'unread' | 'read';
    },
    workspaceId?: string
  ): Promise<{
    operation: string;
    matched: number;
    processed: number;
    errors: number;
    message_ids: string[];
    failed_ids: string[];
    failed_reasons: Record<string, string>;
  }> {
    const effectiveWorkspaceId = workspaceId || getLocalWorkspaceId();
    logger.info(`Bulk ${operation} for ${machineId}:${effectiveWorkspaceId}`, { filters });

    // #2307 Phase 2: Defense-in-depth — reject archive without filters
    if (operation === 'archive') {
      const hasAnyFilter = !!(filters.from || filters.priority || filters.before_date || filters.subject_contains || filters.tag);
      if (!hasAnyFilter) {
        logger.warn(`Bulk archive rejected: no filters provided (would archive entire inbox)`);
        return { operation, matched: 0, processed: 0, errors: 0, message_ids: [], failed_ids: [], failed_reasons: { _guard: 'Bulk archive requires at least one filter to prevent inbox-wide deletion' } };
      }
    }

    if (!existsSync(this.inboxPath)) {
      return { operation, matched: 0, processed: 0, errors: 0, message_ids: [], failed_ids: [], failed_reasons: {} };
    }

    // Use cached data for filtering (#638 perf optimization)
    const { items, full } = await this.ensureInboxCache();
    const matchedIds: string[] = [];
    let errors = 0;
    const failedIds: string[] = [];

    for (const item of items) {
      const message = full.get(item.id);
      if (!message) continue;

      // Check recipient match
      if (!matchesRecipient(message.to, machineId, effectiveWorkspaceId)) {
        continue;
      }

      // Apply filters (AND logic)
      if (filters.from && !message.from.toLowerCase().includes(filters.from.toLowerCase())) {
        continue;
      }
      if (filters.priority && message.priority !== filters.priority) {
        continue;
      }
      if (filters.before_date && new Date(message.timestamp) >= new Date(filters.before_date)) {
        continue;
      }
      if (filters.subject_contains && !message.subject.toLowerCase().includes(filters.subject_contains.toLowerCase())) {
        continue;
      }
      if (filters.tag && (!message.tags || !message.tags.includes(filters.tag))) {
        continue;
      }
      if (filters.status) {
        const isBroadcast = message.to === 'all' || message.to === 'All';
        if (isBroadcast && message.read_by) {
          const readerMachineId = parseMachineWorkspace(machineId).machineId;
          const hasRead = message.read_by.includes(readerMachineId);
          if (filters.status === 'unread' && hasRead) continue;
          if (filters.status === 'read' && !hasRead) continue;
        } else {
          if (message.status !== filters.status) continue;
        }
      }

      matchedIds.push(message.id);
    }

    // Apply the operation to matched messages
    let processed = 0;
    const failedReasons: Record<string, string> = {};
    // #2730: pass the full readerId (machine:workspace) to markAsRead so the #2287
    // access-control guard (matchesRecipient) sees the workspace. bulkOperationHandler
    // forwards getLocalMachineId() (machine only), so without this, markAsRead received
    // a readerId with workspaceId=undefined → matchesRecipient rejected every message
    // targeting a specific workspace → "mark_read returned false" (unitary mark_read,
    // which passes getLocalFullId(), succeeded on the same messages).
    const readerId = `${machineId}:${effectiveWorkspaceId}`;
    for (const id of matchedIds) {
      try {
        if (operation === 'mark_read') {
          const success = await this.markAsRead(id, readerId);
          if (success) processed++;
          else { errors++; failedIds.push(id); failedReasons[id] = 'mark_read returned false'; }
        } else if (operation === 'archive') {
          const success = await this.archiveMessage(id);
          if (success) processed++;
          else { errors++; failedIds.push(id); failedReasons[id] = 'archive returned false'; }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Error processing message ${id}`, error);
        errors++;
        failedIds.push(id);
        failedReasons[id] = msg;
      }
    }

    logger.info(`Bulk ${operation} complete: ${processed}/${matchedIds.length} processed`);
    return {
      operation,
      matched: matchedIds.length,
      processed,
      errors,
      message_ids: matchedIds,
      failed_ids: failedIds,
      failed_reasons: failedReasons
    };
  }

  /**
   * Returns inbox statistics for a machine
   *
   * @param machineId ID of the receiving machine
   * @param workspaceId Optional workspace ID
   * @returns Inbox statistics
   */
  /**
   * Auto-archive messages older than the given age threshold.
   * Moves old read messages from inbox/ to archive/ to keep inbox small.
   * Called opportunistically during inbox reads (#638 Phase 3).
   *
   * #3150: `onlyRead` alone never fires on a shared inbox. `inbox/` is a single
   * folder shared by the whole fleet, so a message addressed to another machine
   * stays `unread` forever — no machine can mark someone else's mail read. Those
   * messages accumulated (1059 of them older than 15 days, May-July 2026) and were
   * re-read in full on every cold cache rebuild. The `unreadMaxAgeDays` lane
   * archives them past a much longer horizon: a message nobody opened in 90 days
   * will not be opened. Nothing is deleted — `archiveMessage` moves inbox/ ->
   * archive/, keeps the sent/ copy, and `getMessage` still resolves archived ids.
   *
   * @param maxAgeDays Maximum age in days before auto-archiving read messages (default: 30)
   * @param onlyRead If true, unread messages are spared until `unreadMaxAgeDays` (default: true)
   * @param unreadMaxAgeDays Age past which unread messages are archived too. 0 disables
   *                         the lane, restoring the pre-#3150 behaviour (default: 90)
   * @returns Number of messages archived
   */
  async autoArchiveOld(
    maxAgeDays: number = 30,
    onlyRead: boolean = true,
    unreadMaxAgeDays: number = 90
  ): Promise<number> {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeDays * DAY_MS;
    const unreadCutoff = Date.now() - unreadMaxAgeDays * DAY_MS;
    logger.info(
      `Auto-archiving messages older than ${maxAgeDays} days ` +
      `(onlyRead=${onlyRead}, unreadMaxAgeDays=${unreadMaxAgeDays})`
    );

    const { items, full } = await this.ensureInboxCache();
    const toArchive: string[] = [];

    for (const item of items) {
      const msgTime = new Date(item.timestamp).getTime();
      if (msgTime >= cutoff) continue;

      if (onlyRead) {
        const message = full.get(item.id);
        const isUnread = !message || message.status === 'unread';
        // Unread messages are spared until the much longer abandoned horizon (#3150).
        if (isUnread && (unreadMaxAgeDays <= 0 || msgTime >= unreadCutoff)) continue;
      }

      toArchive.push(item.id);
    }

    if (toArchive.length === 0) {
      logger.info('No messages to auto-archive');
      return 0;
    }

    let archived = 0;
    for (const id of toArchive) {
      const success = await this.archiveMessage(id);
      if (success) archived++;
    }

    logger.info(`Auto-archived ${archived}/${toArchive.length} messages`);
    return archived;
  }

  /**
   * Rétention PG du canal (#3151 Phase D) : purge des rows archivés plus
   * vieux que `retentionDays` jours, avec leurs payloads d'attachment bytea,
   * en une transaction. Le GDrive n'est JAMAIS touché (archive legacy en
   * lecture seule — « pas de suppression avant preuve »).
   *
   * No-op silencieux tant que la fenêtre n'est pas positive ; piloté par
   * UNIFIED_STORE_CHANNEL_RETENTION_DAYS (voir le runbook ops, §Phase D).
   *
   * @returns nombre de rows purgées (0 = rien à purger ou PG indisponible)
   */
  async purgeArchivedFromStore(retentionDays: number): Promise<number> {
    return purgeArchivedChannelMessages(retentionDays);
  }

  /**
   * Start a background daemon that periodically archives old read messages.
   *
   * #809: prevents inbox/ from growing unbounded. Volume grew x100 between
   * Jan 2026 (~30 msgs/month) and May 2026 (~140 msgs/day), causing
   * `roosync_messages` cold reads to take 2m+ on 4000-file inboxes.
   *
   * Strategy:
   * - Initial run 30s after boot (let server complete handshake first)
   * - Periodic re-run every `intervalHours` (default 6h)
   * - Fire-and-forget: errors log but don't crash the server
   * - Idempotent: noop if daemon already running
   *
   * Concurrency: every machine in the fleet runs this daemon against the same
   * shared inbox/. That is safe — `archiveMessage` treats an already-archived id
   * as success, so a race between two machines converges instead of failing.
   *
   * @param maxAgeDays Archive read messages older than N days (default 30)
   * @param intervalHours Re-run interval in hours (default 6)
   * @param unreadMaxAgeDays Archive unread messages older than N days (#3150, default 90)
   */
  startAutoArchiveDaemon(
    maxAgeDays: number = 30,
    intervalHours: number = 6,
    unreadMaxAgeDays: number = 90
  ): void {
    if (this.autoArchiveTimer !== null) {
      logger.warn('AutoArchive daemon already running, ignoring duplicate start');
      return;
    }
    this.autoArchiveConfig = { maxAgeDays, intervalHours, unreadMaxAgeDays };

    const runOnce = async () => {
      const startedAt = Date.now();
      try {
        const archived = await this.autoArchiveOld(maxAgeDays, true, unreadMaxAgeDays);
        this.autoArchiveLastRun = { at: new Date().toISOString(), archived, durationMs: Date.now() - startedAt };
        if (archived > 0) {
          logger.info(
            `[AutoArchive] Archived ${archived} messages ` +
            `(read >${maxAgeDays}d, unread >${unreadMaxAgeDays}d)`
          );
        }
      } catch (err) {
        this.autoArchiveLastRun = {
          at: new Date().toISOString(),
          archived: 0,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err)
        };
        logger.error('[AutoArchive] Run failed', err as Record<string, any>);
      }
    };

    // Initial run after 30s — let server boot handshake complete first
    setTimeout(() => { void runOnce(); }, 30_000);

    // Then every intervalHours
    this.autoArchiveTimer = setInterval(() => { void runOnce(); }, intervalHours * 3600 * 1000);
    logger.info(`[AutoArchive] Daemon started (maxAge=${maxAgeDays}d, interval=${intervalHours}h)`);
  }

  /**
   * Stop the auto-archive daemon. Used in tests and graceful shutdown.
   */
  stopAutoArchiveDaemon(): void {
    if (this.autoArchiveTimer !== null) {
      clearInterval(this.autoArchiveTimer);
      this.autoArchiveTimer = null;
      logger.info('[AutoArchive] Daemon stopped');
    }
  }

  /**
   * Rotation observability (#3292).
   *
   * Running state, horizons and last run of the #809/#3150 daemon. `lastRun`
   * survives a stop (config too): a `running: false` WITH a last run says "the
   * daemon was started and someone stopped it", not "it never ran".
   */
  getAutoArchiveStatus(): {
    running: boolean;
    config: { maxAgeDays: number; intervalHours: number; unreadMaxAgeDays: number } | null;
    lastRun: { at: string; archived: number; durationMs: number; error?: string } | null;
  } {
    return {
      running: this.autoArchiveTimer !== null,
      config: this.autoArchiveConfig,
      lastRun: this.autoArchiveLastRun
    };
  }

  /**
   * Start the GDrive→PG channel reconcile daemon (#3292).
   *
   * Closes the three measured dual-write loss classes continuously — hard
   * kills (the fire-and-forget INSERT never fails, the process just vanishes),
   * PG outages (INSERT fails while PG is down), and machine state regressions
   * (dual-write silently stops) — by id-diffing the lookback window of
   * `messages/{inbox,archive,sent}` against `roosync_messages` and inserting
   * what is missing (ON CONFLICT DO NOTHING). Any armed machine heals the
   * whole fleet's pool: the pool is shared.
   *
   * Strategy mirrors the auto-archive daemon: initial run 60 s after boot
   * (staggered +30 s vs the archive daemon's own first pass, so the two
   * never collide on DriveFS), periodic every `intervalHours`, fire-and-forget
   * errors, idempotent start.
   *
   * Concurrency: safe across machines — the insert is ON CONFLICT DO NOTHING,
   * so two reconciles racing on the same id converge.
   *
   * @param intervalHours Re-run interval (default 6, matches the archive daemon)
   * @param lookbackDays Re-scan window (default 7 — covers outages and the
   *   boot-gap of short-lived worker sessions, bounded so a run never degrades
   *   into the O(pool) scan #3292 was opened for)
   */
  startChannelReconcileDaemon(
    intervalHours: number = 6,
    lookbackDays: number = 7
  ): void {
    if (this.channelReconcileTimer !== null) {
      logger.warn('ChannelReconcile daemon already running, ignoring duplicate start');
      return;
    }
    this.channelReconcileConfig = { intervalHours, lookbackDays };

    const runOnce = async () => {
      const at = new Date().toISOString();
      try {
        const result = await reconcileChannelFromGDrive({
          messagesRoot: this.messagesPath,
          lookbackDays,
        });
        this.channelReconcileLastRun = { at, result };
        if (result.status === 'ok' && result.reconciled > 0) {
          logger.info(
            `[ChannelReconcile] Reconciled ${result.reconciled} message(s) into PG ` +
            `(window ${result.candidateIds} ids / ${result.sinceId}, ${result.errors} error(s))`
          );
        }
      } catch (err) {
        this.channelReconcileLastRun = {
          at,
          error: err instanceof Error ? err.message : String(err),
        };
        logger.error('[ChannelReconcile] Run failed', err as Record<string, any>);
      }
    };

    // Initial run after 60s — staggered vs the archive daemon's 30s first pass
    setTimeout(() => { void runOnce(); }, 60_000);

    this.channelReconcileTimer = setInterval(() => { void runOnce(); }, intervalHours * 3600 * 1000);
    logger.info(`[ChannelReconcile] Daemon started (interval=${intervalHours}h, lookback=${lookbackDays}d)`);
  }

  /**
   * Stop the channel reconcile daemon. Used in tests and graceful shutdown.
   */
  stopChannelReconcileDaemon(): void {
    if (this.channelReconcileTimer !== null) {
      clearInterval(this.channelReconcileTimer);
      this.channelReconcileTimer = null;
      logger.info('[ChannelReconcile] Daemon stopped');
    }
  }

  /**
   * Reconcile observability (#3292) — same contract as getAutoArchiveStatus():
   * lastRun survives a stop so `running: false` + a last run reads as "was
   * started, then stopped", not "never ran".
   */
  getChannelReconcileStatus(): {
    running: boolean;
    config: { intervalHours: number; lookbackDays: number } | null;
    lastRun: { at: string; result?: ChannelReconcileResult; error?: string } | null;
  } {
    return {
      running: this.channelReconcileTimer !== null,
      config: this.channelReconcileConfig,
      lastRun: this.channelReconcileLastRun,
    };
  }

  /**
   * Age histogram of the SHARED inbox pool (#3292), from filenames only.
   *
   * Ids embed `msg-YYYYMMDDTHHMMSS`, so a single readdir — no per-file open,
   * no cache dependency — yields the distribution. Bucket edges mirror the
   * rotation knobs: 7d = read-mail grace (opportunistic archive on reads),
   * 30d = read-mail daemon horizon, 90d = dead-letter (unread) horizon.
   * The 7-90d band is dead-addressed mail by construction (read mail leaves
   * at the 7d/30d lanes); its size is the cost of the chosen horizon.
   */
  async getInboxPoolAges(): Promise<{
    total: number;
    d0_7: number;
    d7_30: number;
    d30_90: number;
    d90_plus: number;
    undated: number;
  }> {
    const buckets = { total: 0, d0_7: 0, d7_30: 0, d30_90: 0, d90_plus: 0, undated: 0 };
    if (!existsSync(this.inboxPath)) return buckets;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const dateInName = /^msg-(\d{4})(\d{2})(\d{2})T\d{6}/;
    for (const f of await fs.readdir(this.inboxPath)) {
      if (!f.endsWith('.json')) continue;
      buckets.total++;
      const m = dateInName.exec(f);
      if (!m) {
        buckets.undated++;
        continue;
      }
      const ageDays = (Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / DAY_MS;
      if (ageDays < 7) buckets.d0_7++;
      else if (ageDays < 30) buckets.d7_30++;
      else if (ageDays < 90) buckets.d30_90++;
      else buckets.d90_plus++;
    }
    return buckets;
  }

  async getInboxStats(
    machineId: string,
    workspaceId?: string
  ): Promise<{
    total: number;
    unread: number;
    read: number;
    by_priority: Record<string, number>;
    by_sender: Record<string, number>;
    oldest_unread: string | null;
  }> {
    const effectiveWorkspaceId = workspaceId || getLocalWorkspaceId();
    logger.info(`Getting inbox stats for ${machineId}:${effectiveWorkspaceId}`);

    const stats = {
      total: 0,
      unread: 0,
      read: 0,
      by_priority: {} as Record<string, number>,
      by_sender: {} as Record<string, number>,
      oldest_unread: null as string | null
    };

    // Use cached data (#638 perf optimization)
    const { items, full } = await this.ensureInboxCache();
    let oldestUnreadDate: Date | null = null;

    for (const item of items) {
      const message = full.get(item.id);
      if (!message) continue;

      if (!matchesRecipient(message.to, machineId, effectiveWorkspaceId)) {
        continue;
      }

      stats.total++;

      // Per-machine read status for broadcasts (#629)
      const isBroadcast = message.to === 'all' || message.to === 'All';
      let isUnreadForThisMachine: boolean;
      if (isBroadcast && message.read_by) {
        const readerMachineId = parseMachineWorkspace(machineId).machineId;
        isUnreadForThisMachine = !message.read_by.includes(readerMachineId);
      } else {
        isUnreadForThisMachine = message.status === 'unread';
      }

      if (isUnreadForThisMachine) {
        stats.unread++;
        const msgDate = new Date(message.timestamp);
        if (!oldestUnreadDate || msgDate < oldestUnreadDate) {
          oldestUnreadDate = msgDate;
          stats.oldest_unread = message.timestamp;
        }
      } else {
        stats.read++;
      }

      // Count by priority
      const prio = message.priority || 'MEDIUM';
      stats.by_priority[prio] = (stats.by_priority[prio] || 0) + 1;

      // Count by sender (machine ID only)
      const sender = parseMachineWorkspace(message.from).machineId;
      stats.by_sender[sender] = (stats.by_sender[sender] || 0) + 1;
    }

    return stats;
  }
}

/**
 * Singleton MessageManager instance (#809 perf fix).
 * Ensures the in-memory inbox cache (TTL 30s) survives across tool calls.
 * Without this, each tool invocation created a new MessageManager, making the cache useless.
 */
let _singletonInstance: MessageManager | null = null;

/**
 * Returns the singleton MessageManager instance.
 * Creates it on first call using getSharedStatePath().
 *
 * @returns The shared MessageManager instance
 */
export function getMessageManager(): MessageManager {
  if (!_singletonInstance) {
    // #1110 FIX: Inline getSharedStatePath() to avoid importing server-helpers.js
    // at module load time, breaking the ESM circular dependency deadlock.
    const sharedStatePath = process.env.ROOSYNC_SHARED_PATH;
    if (!sharedStatePath) {
      throw new Error('ROOSYNC_SHARED_PATH environment variable is required for MessageManager');
    }
    _singletonInstance = new MessageManager(sharedStatePath);
  }
  return _singletonInstance;
}

/**
 * Reset the singleton instance (for tests only).
 * @internal
 */
export function _resetMessageManagerSingleton(): void {
  _singletonInstance = null;
}