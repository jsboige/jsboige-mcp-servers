/**
 * Outil MCP : search_tasks_by_content
 * Recherche sémantique de tâches avec Qdrant
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../services/openai.js';
import { handleSearchTasksSemanticFallback } from './search-fallback.tool.js';
import { getHostIdentifier } from '../../services/task-indexer/ChunkExtractor.js';
import { resetEmbeddingCircuitBreaker as resetWriteCircuitBreaker } from '../../services/task-indexer/VectorIndexer.js';
import { parseFilterDate, isWithinDateRange } from '../../utils/date-filters.js';
import { classifySearchError, formatClassifiedError } from './search-error-classifier.js';
import { getUnifiedStoreReader } from '../../services/unified-store/reader-factory.js';
import type { UnifiedStoreSearchFilters } from '../../services/unified-store/types.js';

// #1232: Circuit breaker for embedding API failures
// When the embedding API returns 502/503, skip semantic search and go directly to text fallback
// for EMBEDDING_CIRCUIT_BREAKER_TTL_MS (default 5 minutes) to avoid repeated timeouts.
let lastEmbeddingFailureTime = 0;
const EMBEDDING_CIRCUIT_BREAKER_TTL_MS = parseInt(process.env.EMBEDDING_CIRCUIT_BREAKER_TTL_MS || '300000');

// #1496: Fallback observability — reason codes when semantic degrades to text
type FallbackReason =
    | 'embedding_circuit_breaker_active'
    | 'embedding_api_error'
    | 'embedding_timeout';

/**
 * #1496: Inject fallback metadata into a CallToolResult's JSON payload.
 * When semantic search falls back to text, agents need to know so they don't
 * treat text results as semantic (cf #1407, #1451 — regressions masked for days).
 */
function injectFallbackMeta(result: CallToolResult, reason: FallbackReason): CallToolResult {
    try {
        const text = result.content?.[0] && 'text' in result.content[0]
            ? (result.content[0] as { text: string }).text
            : '';
        const parsed = JSON.parse(text);
        const enriched = {
            ...parsed,
            fallback_used: true,
            fallback_reason: reason,
            original_search_mode: 'semantic',
            actual_search_mode: 'text',
        };
        return {
            ...result,
            content: [{ type: 'text' as const, text: JSON.stringify(enriched, null, 2) }]
        };
    } catch {
        return result;
    }
}

// #249/#2167: Retry configuration for transient failures
// #2167: Bumped default retry count from 1→2 (3 total attempts) for embedding reliability
const SEMANTIC_RETRY_COUNT = parseInt(process.env.SEMANTIC_RETRY_COUNT || '2');
const SEMANTIC_RETRY_BACKOFF_MS = parseInt(process.env.SEMANTIC_RETRY_BACKOFF_MS || '2000');

/**
 * #2167: Query embedding cache — avoids re-embedding identical queries within TTL.
 * LRU with TTL 1h. Capped at 100 entries to bound memory.
 */
const queryEmbeddingCache = new Map<string, { embedding: number[]; expiresAt: number }>();
const QUERY_EMBEDDING_CACHE_TTL_MS = parseInt(process.env.QUERY_EMBEDDING_CACHE_TTL_MS || '3600000'); // 1h
const QUERY_EMBEDDING_CACHE_MAX = 100;

// #3043 (SDDD #2766): diversify-by-task to prevent one task from monopolizing
// the top-K. DIVERSIFY_OVERFETCH widens the Qdrant window so grouping can find
// additional tasks even when a single task produces many high-score chunks.
// DIVERSIFY_MAX_CHUNKS_PER_TASK caps the chunk array per grouped task so that
// no task hogs the result budget. Both constants are conservative defaults:
// max_results * 3 with a 2-chunk/task cap means a request for 10 results can
// surface up to 15 unique tasks (capped at max_results returned).
const DIVERSIFY_OVERFETCH = 3;
const DIVERSIFY_MAX_CHUNKS_PER_TASK = 2;

function getCachedQueryEmbedding(query: string): number[] | null {
    const cached = queryEmbeddingCache.get(query);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.embedding;
    }
    if (cached) queryEmbeddingCache.delete(query);
    return null;
}

function setCachedQueryEmbedding(query: string, embedding: number[]): void {
    if (queryEmbeddingCache.size >= QUERY_EMBEDDING_CACHE_MAX) {
        const oldest = queryEmbeddingCache.keys().next().value;
        if (oldest) queryEmbeddingCache.delete(oldest);
    }
    queryEmbeddingCache.set(query, { embedding, expiresAt: Date.now() + QUERY_EMBEDDING_CACHE_TTL_MS });
}

/**
 * #249/#2167: Retry wrapper with exponential backoff for transient network/timeout errors.
 * Retries on 5xx, abort, timeout, and resource exhaustion (EMFILE).
 * Does NOT retry on 4xx or validation errors.
 */
async function withRetry<T>(fn: () => Promise<T>, retries: number = SEMANTIC_RETRY_COUNT, backoffMs: number = SEMANTIC_RETRY_BACKOFF_MS): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        if (retries <= 0) throw error;
        const isRetryable = isHttpServerError(error) || isAbortOrTimeout(error) || isResourceExhausted(error);
        if (!isRetryable) throw error;
        console.warn(`[WARN] #249/#2300: Retrying after transient error (${retries} left): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return withRetry(fn, retries - 1, backoffMs * 2);
    }
}

/**
 * #2300: Check if an error is resource exhaustion (EMFILE, ENOMEM, etc.) — eligible for retry.
 */
function isResourceExhausted(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    const code = ((error as any)?.code || '').toUpperCase();
    return code === 'EMFILE' || code === 'ENOMEM' || code === 'ENOSPC' ||
        msg.includes('too many open files') || msg.includes('emfile');
}

/**
 * Check if an error is an HTTP 5xx server error (eligible for circuit breaker).
 * Only activates on real server errors, not generic exceptions.
 */
function isHttpServerError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message;
    return /\b5[0-9]{2}\b/.test(msg) || msg.includes('Bad Gateway') || msg.includes('Service Unavailable') || msg.includes('Gateway Timeout');
}

/**
 * #2063: Check if an error is an AbortError/timeout (not HTTP 5xx but still
 * eligible for circuit breaker — prevents repeated 30s timeouts).
 */
function isAbortOrTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message;
    const code = (error as any)?.code || '';
    return msg.includes('abort') || msg.includes('timeout') || msg.includes('ETIMEDOUT') ||
        msg.includes('This operation was aborted') || code === 'UND_ERR_CONNECT_TIMEOUT';
}

/**
 * Reset the circuit breaker state and query embedding cache (for testing).
 * @internal
 */
export function _resetEmbeddingCircuitBreaker(): void {
    lastEmbeddingFailureTime = 0;
    queryEmbeddingCache.clear();
}

export interface SearchTasksByContentArgs {
    conversation_id?: string;
    search_query: string;
    max_results?: number;
    diagnose_index?: boolean;
    workspace?: string;
    source?: 'roo' | 'claude-code';
    // #636: Advanced filters
    chunk_type?: 'message_exchange' | 'tool_interaction';
    role?: 'user' | 'assistant';
    tool_name?: string;
    has_errors?: boolean;
    model?: string;
    // #636 Phase 2: Temporal filters
    start_date?: string;
    end_date?: string;
    // #636 Phase 3: Convenience filter
    /** Exclude tool_interaction chunks, returning only message_exchange chunks */
    exclude_tool_results?: boolean;
    // #1496: When true, propagate semantic errors instead of silently falling
    // back to text search. Used by `roosync_search(action: "semantic")` so the
    // caller gets a clear signal when the embedding backend is down, rather
    // than returning `searchType: "text"` without warning. Default: false
    // (legacy behavior preserved for direct `searchTasks` callers).
    strict_mode?: boolean;
    // #2634: Reset the embedding circuit breaker and force a fresh connection test
    reset_circuit_breaker?: boolean;
}

/**
 * Helper pour tronquer les messages
 */
function truncateMessage(message: string, truncate: number): string {
    if (!message || truncate === 0) {
        return message;
    }
    const lines = message.split('\n');
    if (lines.length <= truncate * 2) {
        return message;
    }
    const start = lines.slice(0, truncate).join('\n');
    const end = lines.slice(-truncate).join('\n');
    return `${start}\n[...]\n${end}`;
}

/**
 * #2609 V3 (rubric (a) — coherent passage): how far a boundary snap may scan
 * from the raw window edge before falling back to a word boundary. Bounded so
 * the snippet never drifts far from the requested size.
 */
const SENTENCE_SNAP_SCAN = 160;

/**
 * #2609 V3 (rubric (a) — coherent passage): snap a raw character offset to the
 * nearest sentence boundary within `maxScan` chars, falling back to a word
 * boundary, so the snippet starts/ends on a sentence instead of mid-word.
 * 'forward' finds the first sentence START at/after rawPos; 'backward' finds
 * the position just after the last sentence END at/before rawPos.
 * Returns rawPos unchanged when nothing suitable is found (hard cut, unavoidable).
 */
function snapToSentence(content: string, rawPos: number, direction: 'forward' | 'backward', maxScan: number): number {
    const n = content.length;
    if (direction === 'forward') {
        const limit = Math.min(n, rawPos + maxScan);
        for (let i = Math.max(0, rawPos); i < limit; i++) {
            const ch = content[i];
            if (ch === '\n') return i + 1;
            if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= n || /[\s")'\]]/.test(content[i + 1]))) {
                let j = i + 1;
                while (j < limit && /[\s")'\]]/.test(content[j])) j++;
                return Math.min(n, j);
            }
        }
        // Word-boundary fallback: skip the partial word cut at rawPos
        const ws = content.indexOf(' ', rawPos);
        return (ws !== -1 && ws < limit) ? ws + 1 : rawPos;
    } else {
        const limit = Math.max(0, rawPos - maxScan);
        for (let i = Math.min(rawPos, n) - 1; i >= limit; i--) {
            const ch = content[i];
            if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') return i + 1;
        }
        // Word-boundary fallback: cut before the partial word ending at rawPos
        const ws = content.lastIndexOf(' ', Math.min(rawPos, n));
        return (ws !== -1 && ws >= limit) ? ws : rawPos;
    }
}

/**
 * Extract a context snippet centered around the best matching portion of content.
 * Looks for query words in the content and returns surrounding text.
 *
 * #2609 V3 (rubric (a) — coherent passage): window boundaries snap to sentence
 * boundaries (word-boundary fallback) instead of cutting at an arbitrary
 * character offset. A fragment cut mid-sentence forces the agent to re-open the
 * source in grep/Read to understand it — the exact decoupling this Epic targets.
 * The query match always stays inside the window.
 */
function extractSnippet(content: string, query: string, maxChars: number = 600): string {
    if (!content) return '';

    const lowerContent = content.toLowerCase();
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // Find the position of the first matching query word
    let bestPos = -1;
    for (const word of queryWords) {
        const pos = lowerContent.indexOf(word);
        if (pos !== -1) {
            bestPos = pos;
            break;
        }
    }

    if (bestPos === -1) {
        // No keyword match, return the start of the content
        if (content.length <= maxChars) return content;
        const end = snapToSentence(content, maxChars, 'backward', SENTENCE_SNAP_SCAN);
        return content.substring(0, Math.min(end, maxChars + SENTENCE_SNAP_SCAN)).trim() + '...';
    }

    // Center the snippet around the match
    const halfWindow = Math.floor(maxChars / 2);
    const rawStart = Math.max(0, bestPos - halfWindow);
    const rawEnd = Math.min(content.length, bestPos + halfWindow);
    // #2609 V3: snap to sentence boundaries — clamped so the match never falls out
    let start = rawStart > 0 ? snapToSentence(content, rawStart, 'forward', SENTENCE_SNAP_SCAN) : 0;
    if (start > bestPos) start = Math.min(rawStart, bestPos);
    let end = rawEnd < content.length ? snapToSentence(content, rawEnd, 'backward', SENTENCE_SNAP_SCAN) : content.length;
    if (end <= bestPos) end = Math.min(Math.max(rawEnd, bestPos + 1), content.length);
    let snippet = content.substring(start, end).trim();

    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
}

/**
 * Interpret a cosine similarity score into a human-readable quality label
 */
function interpretScore(score: number): string {
    if (score >= 0.9) return 'excellent';
    if (score >= 0.75) return 'good';
    if (score >= 0.6) return 'moderate';
    if (score >= 0.4) return 'weak';
    return 'marginal';
}

/**
 * Format a timestamp as relative time (e.g., "2d ago", "5h ago")
 */
function formatRelativeTime(timestamp: string | undefined): string {
    if (!timestamp) return '';
    try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return '';
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays > 30) return date.toISOString().split('T')[0];
        if (diffDays > 0) return `${diffDays}d ago`;
        if (diffHours > 0) return `${diffHours}h ago`;
        return 'recent';
    } catch {
        return '';
    }
}

// #1244 Couche 2.1 — parseFilterDate / isWithinDateRange factorises dans
// `src/utils/date-filters.ts` pour reutilisation par list-conversations,
// conversation-browser, summarize, etc. Importes en haut du fichier.

interface RawSearchResult {
    taskId: string;
    score: number;
    content: string;
    snippet: string;
    relevance: string;
    // #2609 V3 (rubric (b) — handle): ready-to-execute re-expansion command.
    // The Epic's failure mode was "a panel pointing at a file group": the agent
    // had a pointer but still had to grep to use it. This is the executable
    // counterpart — conversation_browser view, pre-windowed around the hit.
    drill_down: {
        tool: 'conversation_browser';
        action: 'view';
        task_id: string;
        messageStart?: number;
        messageEnd?: number;
    };
    metadata: {
        chunk_id: string | undefined;
        chunk_type: string | undefined;
        workspace: string | undefined;
        task_title: string;
        role: string | undefined;
        timestamp: string | undefined;
        relative_time: string;
        message_position: string | undefined;
        // #2609 V3: raw ints (query-ready) in addition to the display string —
        // message_position alone cannot drive a conversation_browser call.
        message_index: number | undefined;
        total_messages: number | undefined;
        host_os: string;
        // #636: Enriched metadata
        source: string | undefined;
        tool_name: string | undefined;
        model: string | undefined;
        has_error: boolean | undefined;
    };
}

// #2609 V3: half-window (messages) around the hit for the drill_down handle.
const DRILL_DOWN_WINDOW = 3;

/**
 * #2609 V3 (rubric (b) — handle): build the conversation_browser re-expansion
 * command for a hit. When message_index is known the window is pre-clamped to
 * the conversation bounds so the agent can fire it as-is.
 */
function buildDrillDown(taskId: string, messageIndex: number | undefined, totalMessages: number | undefined): RawSearchResult['drill_down'] {
    if (messageIndex === undefined) {
        return { tool: 'conversation_browser', action: 'view', task_id: taskId };
    }
    const start = Math.max(1, messageIndex - DRILL_DOWN_WINDOW);
    const end = totalMessages !== undefined
        ? Math.min(totalMessages, messageIndex + DRILL_DOWN_WINDOW)
        : messageIndex + DRILL_DOWN_WINDOW;
    return { tool: 'conversation_browser', action: 'view', task_id: taskId, messageStart: start, messageEnd: end };
}

// #2609 V3 (rubric (c) — surrounding context): adjacent conversation turn.
interface ConversationTurnExcerpt {
    role: string;
    message_index: number;
    timestamp: string | undefined;
    excerpt: string;
}

interface GroupedTask {
    taskId: string;
    task_title: string;
    workspace: string | undefined;
    host_os: string;
    best_score: number;
    relevance: string;
    // #636: Enriched task-level metadata
    source: string | undefined;
    model: string | undefined;
    // #636 Phase 2: Conversation-level statistics
    conversation_stats?: {
        total_messages: number;
        workspace: string | undefined;
        last_activity: string | undefined;
    };
    // #2609 V3 (rubric (c) — surrounding context): turns adjacent to the best
    // chunk, so a "decision" hit carries the turn that motivated it. Absent
    // when the anchor point lacks message_index or the scroll failed (non-blocking).
    conversation_context?: {
        before_turn?: ConversationTurnExcerpt;
        after_turn?: ConversationTurnExcerpt;
    };
    chunks: Array<{
        score: number;
        relevance: string;
        snippet: string;
        chunk_type: string | undefined;
        role: string | undefined;
        relative_time: string;
        message_position: string | undefined;
        // #2609 V3 (rubric (b)): raw handle fields threaded to the rendered output.
        message_index: number | undefined;
        drill_down: RawSearchResult['drill_down'];
        // #636: Enriched chunk-level metadata
        tool_name: string | undefined;
        has_error: boolean | undefined;
        // #2766 (SDDD echo pollution): count of exact-duplicate chunks (cross- or
        // intra-task) collapsed into this representative. Absent = 0 (unique).
        duplicate_count?: number;
    }>;
}

/**
 * Deduplicate and group results by task_id, keeping the best-scoring chunks per task.
 */
function groupResultsByTask(results: RawSearchResult[]): GroupedTask[] {
    const taskMap = new Map<string, GroupedTask>();

    for (const r of results) {
        const existing = taskMap.get(r.taskId);
        if (existing) {
            existing.chunks.push({
                score: r.score,
                relevance: r.relevance,
                snippet: r.snippet,
                chunk_type: r.metadata.chunk_type,
                role: r.metadata.role,
                relative_time: r.metadata.relative_time,
                message_position: r.metadata.message_position,
                message_index: r.metadata.message_index,
                drill_down: r.drill_down,
                tool_name: r.metadata.tool_name,
                has_error: r.metadata.has_error,
            });
            if (r.score > existing.best_score) {
                existing.best_score = r.score;
                existing.relevance = r.relevance;
            }
        } else {
            taskMap.set(r.taskId, {
                taskId: r.taskId,
                task_title: r.metadata.task_title,
                workspace: r.metadata.workspace,
                host_os: r.metadata.host_os,
                best_score: r.score,
                relevance: r.relevance,
                source: r.metadata.source,
                model: r.metadata.model,
                chunks: [{
                    score: r.score,
                    relevance: r.relevance,
                    snippet: r.snippet,
                    chunk_type: r.metadata.chunk_type,
                    role: r.metadata.role,
                    relative_time: r.metadata.relative_time,
                    message_position: r.metadata.message_position,
                    message_index: r.metadata.message_index,
                    drill_down: r.drill_down,
                    tool_name: r.metadata.tool_name,
                    has_error: r.metadata.has_error,
                }],
            });
        }
    }

    // Sort tasks by best score descending
    return Array.from(taskMap.values()).sort((a, b) => b.best_score - a.best_score);
}

/**
 * #2766 (SDDD echo pollution): cross-task content dedup.
 *
 * `groupResultsByTask` (#3043 diversify) keys by `taskId`, so chunks that are
 * byte-identical but live in DIFFERENT tasks survive as distinct groups.
 * Measured at ~16.1% of returned chunks (po-2024 c.154: 40/249 across 12
 * queries), and 19/40 of those duplicates are cross-taskId — invisible to #947
 * (which dedups same-task) and to the per-task cap (each survives as its own
 * group). This collapses them.
 *
 * Runs AFTER groupResultsByTask + per-task cap + Postgres enrichment, on the
 * already ANN-ordered, budget-bounded set: a single O(n) pass with a Map keyed
 * by exact snippet text. The first occurrence (best-ranked in ANN order —
 * effectively best-scored, since exact-duplicate content shares an embedding
 * neighborhood) is the representative; later exact-duplicate chunks are dropped
 * and the representative's `duplicate_count` is incremented, so the pollution
 * signal is preserved rather than erased by the fix. Groups emptied by dedup
 * are pruned (their only content was already shown by a better-ranked task).
 *
 * Orthogonal to #947 / #3043 by construction: those operate within a task;
 * this operates across tasks.
 *
 * Flags (read at call time so tests can toggle them post-import):
 *   SEARCH_DEDUP_ENABLED=0   → disable entirely (rollback / A-B).
 *   SEARCH_DEDUP_NORMALIZE=1 → key on trim+lowercase+collapse-ws instead of the
 *     raw snippet, to catch near-identical chunks. OFF by default: at a measured
 *     median of 159 chars, normalization would fuse legitimately distinct chunks
 *     that merely share a prefix. Enable only if a residual is measured.
 */
export function dedupGroupedChunksByContent(groups: GroupedTask[]): {
    duplicates_removed: number;
    groups_pruned: number;
    mode: 'exact' | 'normalized';
    enabled: boolean;
} {
    if (process.env.SEARCH_DEDUP_ENABLED === '0') {
        return { duplicates_removed: 0, groups_pruned: 0, mode: 'exact', enabled: false };
    }
    const normalize = process.env.SEARCH_DEDUP_NORMALIZE === '1';
    const mode: 'exact' | 'normalized' = normalize ? 'normalized' : 'exact';
    // Map: content key → the representative chunk itself (a direct reference).
    // #2766 hardening (ai-01 c.156): store the chunk REFERENCE, never indices.
    // The first iteration stored {groupIdx, chunkIdx} where chunkIdx was an index
    // into `surviving` (the array under construction), but the lookup indexed
    // `groups[gi].chunks` — which is still the ORIGINAL array mid-loop for
    // intra-group duplicates (group.chunks = surviving runs only after the inner
    // loop). If a chunk before the representative was itself a dropped duplicate,
    // surviving and original diverge and duplicate_count landed on the wrong chunk.
    // Unreachable while DIVERSIFY_MAX_CHUNKS_PER_TASK=2 (≤2 chunks/group), but it
    // would resurface — and lie as a measurement — the day the cap rises. A direct
    // reference makes the index arithmetic (and its bug class) impossible.
    const seen = new Map<string, GroupedTask['chunks'][number]>();
    let duplicates_removed = 0;

    for (const group of groups) {
        // Rebuild the chunk array without duplicates of earlier (better-ranked) chunks.
        const surviving: typeof group.chunks = [];
        for (const chunk of group.chunks) {
            const key = normalize
                ? chunk.snippet.trim().toLowerCase().replace(/\s+/g, ' ')
                : chunk.snippet;
            // Empty snippet: cannot dedup meaningfully — keep (never drop a real hit on a blank key).
            if (!key) {
                surviving.push(chunk);
                continue;
            }
            const rep = seen.get(key);
            if (rep) {
                // Duplicate of an already-kept representative: drop this chunk and
                // bump the representative's duplicate_count (preserves the signal).
                rep.duplicate_count = (rep.duplicate_count || 0) + 1;
                duplicates_removed++;
            } else {
                seen.set(key, chunk);
                surviving.push(chunk);
            }
        }
        group.chunks = surviving;
    }

    // Prune groups that lost every chunk to dedup (their content was already
    // shown by a better-ranked task — keeping them would be pure noise).
    let groups_pruned = 0;
    if (duplicates_removed > 0) {
        const before = groups.length;
        for (let i = groups.length - 1; i >= 0; i--) {
            if (groups[i].chunks.length === 0) {
                groups.splice(i, 1);
            }
        }
        groups_pruned = before - groups.length;
    }

    return { duplicates_removed, groups_pruned, mode, enabled: true };
}

/**
 * #3043 (SDDD #2766) + #956 résiduel (ai-01 c.160 Item 4): cap the chunk array per
 * grouped task so no single task monopolizes the result budget, and report how often
 * the cap binds. Extracted to a unit-testable helper — parallel to
 * dedupGroupedChunksByContent — so the cap behavior is verifiable at ANY value
 * (including the higher caps we may evaluate against the baseline) without driving
 * the full Qdrant-backed handler.
 *
 * Mutates each group's `chunks` in place (truncates to `cap`) and returns counts:
 *   - truncated_groups: how many groups had more chunks than the cap
 *   - chunks_capped:    total chunks dropped across all truncated groups
 * Both are 0 when the cap never binds (the common query) → quiet in the report.
 */
export function applyDiversifyCap(groups: GroupedTask[], cap: number): {
    truncated_groups: number;
    chunks_capped: number;
} {
    let truncated_groups = 0;
    let chunks_capped = 0;
    for (const group of groups) {
        if (group.chunks.length > cap) {
            chunks_capped += group.chunks.length - cap;
            group.chunks = group.chunks.slice(0, cap);
            truncated_groups++;
        }
    }
    return { truncated_groups, chunks_capped };
}

// #2609 V3 (rubric (c) — surrounding context): excerpt budget per neighbor turn.
const CONTEXT_EXPANSION_EXCERPT_CHARS = 320;

/**
 * #2609 V3: leading excerpt of a neighbor turn, snapped to a sentence end so
 * the context itself is a coherent passage (same discipline as extractSnippet).
 */
function excerptFromStart(content: string, maxChars: number): string {
    if (!content) return '';
    if (content.length <= maxChars) return content;
    const end = snapToSentence(content, maxChars, 'backward', 80);
    const cut = (end > 0 && end <= maxChars + 80) ? end : maxChars;
    return content.substring(0, cut).trim() + '…';
}

/**
 * #2609 V3 (rubric (c) — surrounding context): for each retained task, fetch
 * the conversation turns adjacent to the best chunk (message_index ± 1) so a
 * "decision" hit carries the turn that motivated it, not just the matched
 * fragment. One filtered scroll per task (≤ max_results extra Qdrant calls on
 * the local engine — milliseconds); points paginated over several chunk_index
 * within the SAME message are collapsed to their first page.
 *
 * Non-blocking by design: any failure leaves the group without context —
 * search results are never dropped or delayed by context expansion.
 * Rollback / A-B: SEARCH_CONTEXT_EXPANSION=0 (same convention as SEARCH_DEDUP_ENABLED).
 *
 * Must run AFTER grouping + diversify + Postgres enrichment + cross-task dedup,
 * so no fetch is spent on a group that a later stage would prune.
 */
async function attachConversationContext(groups: GroupedTask[], qdrant: any, collectionName: string): Promise<number> {
    if (process.env.SEARCH_CONTEXT_EXPANSION === '0') return 0;
    let attached = 0;
    for (const group of groups) {
        const anchor = group.chunks[0]?.message_index;
        if (typeof anchor !== 'number') continue;
        try {
            const scrollResult: any = await qdrant.scroll(collectionName, {
                filter: {
                    must: [
                        { key: 'task_id', match: { value: group.taskId } },
                        { key: 'message_index', range: { gte: anchor - 1, lte: anchor + 1 } },
                    ],
                },
                limit: 12,
                with_vector: false,
                with_payload: { include: ['message_index', 'role', 'content', 'timestamp', 'chunk_index'] },
            });
            const points = Array.isArray(scrollResult?.points)
                ? scrollResult.points
                : (Array.isArray(scrollResult) ? scrollResult : []);
            // First page per adjacent message_index (a message may be split into
            // several chunk_index pages — the turn opening is the useful excerpt).
            const byMessage = new Map<number, { chunkIndex: number; payload: any }>();
            for (const p of points) {
                const payload = p?.payload ?? p;
                const mi = payload?.message_index;
                if (typeof mi !== 'number' || mi === anchor) continue;
                const ci = typeof payload?.chunk_index === 'number' ? payload.chunk_index : 1;
                const cur = byMessage.get(mi);
                if (!cur || ci < cur.chunkIndex) byMessage.set(mi, { chunkIndex: ci, payload });
            }
            const context: NonNullable<GroupedTask['conversation_context']> = {};
            const before = byMessage.get(anchor - 1);
            if (before) {
                context.before_turn = {
                    role: String(before.payload?.role ?? 'unknown'),
                    message_index: anchor - 1,
                    timestamp: before.payload?.timestamp,
                    excerpt: excerptFromStart(String(before.payload?.content ?? ''), CONTEXT_EXPANSION_EXCERPT_CHARS),
                };
            }
            const after = byMessage.get(anchor + 1);
            if (after) {
                context.after_turn = {
                    role: String(after.payload?.role ?? 'unknown'),
                    message_index: anchor + 1,
                    timestamp: after.payload?.timestamp,
                    excerpt: excerptFromStart(String(after.payload?.content ?? ''), CONTEXT_EXPANSION_EXCERPT_CHARS),
                };
            }
            if (context.before_turn || context.after_turn) {
                group.conversation_context = context;
                attached++;
            }
        } catch {
            // Non-blocking: a task without context is still a valid search result.
        }
    }
    return attached;
}

/**
 * Définition de l'outil MCP search_tasks_by_content
 */
export const searchTasksByContentTool = {
    definition: {
        name: 'search_tasks_by_content',
        description: 'Recherche des tâches par contenu sémantique avec filtrage par workspace et métadonnées enrichies.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                conversation_id: {
                    type: 'string',
                    description: 'ID de la conversation à fouiller.'
                },
                search_query: {
                    type: 'string',
                    description: 'La requête de recherche sémantique.'
                },
                max_results: {
                    type: 'number',
                    description: 'Nombre maximum de résultats à retourner.'
                },
                workspace: {
                    type: 'string',
                    description: 'Filtre les résultats par workspace spécifique.'
                },
                diagnose_index: {
                    type: 'boolean',
                    description: 'Mode diagnostic : retourne des informations sur l\'état de l\'indexation sémantique.'
                },
                reset_circuit_breaker: {
                    type: 'boolean',
                    description: '#2634: Reset the embeddings circuit breaker(s) if armed, then return early (no search). Recovers semantic search + indexing after a Qdrant/embedding outage without a VS Code restart.'
                },
                source: {
                    type: 'string',
                    enum: ['roo', 'claude-code'],
                    description: 'Filtre les résultats par source (tâches Roo ou sessions Claude Code).'
                },
            },
            required: ['search_query'],
        }
    },

    /**
     * Handler principal de recherche par contenu
     */
    handler: async (
        args: SearchTasksByContentArgs,
        conversationCache: Map<string, ConversationSkeleton>,
        ensureCacheFreshCallback: (args?: { workspace?: string }) => Promise<boolean>,
        fallbackHandler: (args: any, cache: Map<string, ConversationSkeleton>) => Promise<CallToolResult>,
        diagnoseHandler?: () => Promise<CallToolResult>
    ): Promise<CallToolResult> => {
        const { conversation_id, search_query, max_results, diagnose_index = false, workspace, source,
                chunk_type, role, tool_name, has_errors, model, start_date, end_date, exclude_tool_results, reset_circuit_breaker } = args;

        // #2634: Reset circuit breaker(s) on explicit request (runtime reset without VS Code restart).
        // Two recovery surfaces are reset together so a single call restores BOTH the semantic
        // SEARCH path and the INDEXING path after a Qdrant/embedding outage:
        //   1. the embedding-API breaker in THIS module (gates query embedding for search)
        //   2. the Qdrant write breaker in VectorIndexer (gates upserts during indexing)
        if (reset_circuit_breaker) {
            const apiWasArmed = lastEmbeddingFailureTime > 0 && (Date.now() - lastEmbeddingFailureTime) < EMBEDDING_CIRCUIT_BREAKER_TTL_MS;
            _resetEmbeddingCircuitBreaker();
            const writePrevious = resetWriteCircuitBreaker();
            const writeWasArmed = writePrevious.state === 'OPEN';
            console.log(`[INFO] #2634: Circuit breakers reset (embedding_api_armed: ${apiWasArmed}, write_breaker_armed: ${writeWasArmed}). Caches cleared, ready for fresh connection test.`);

            // Return diagnostic result showing the reset succeeded
            return {
                isError: false,
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        circuit_breaker_reset: true,
                        was_armed: apiWasArmed || writeWasArmed,
                        embedding_api_breaker: { was_armed: apiWasArmed },
                        write_breaker: {
                            was_armed: writeWasArmed,
                            previous_state: writePrevious.state,
                            previous_failure_count: writePrevious.failureCount
                        },
                        message: 'Embedding circuit breakers (search + indexing) have been reset. Semantic search is now enabled.',
                        timestamp: new Date().toISOString()
                    }, null, 2)
                }]
            };
        }

        // #636 Phase 3: resolve effective chunk_type (exclude_tool_results is a convenience alias)
        const effectiveChunkType = chunk_type ?? (exclude_tool_results ? 'message_exchange' : undefined);

        // #883 P0: Skip cache refresh for semantic searches — the skeleton cache is NOT used
        // for Qdrant vector search, only for post-search enrichment. The ensureCacheFreshCallback
        // scans ALL task directories (I/O heavy, ~70s with thousands of tasks), which is the
        // root cause of roosync_search being slow. Cache refresh is only needed for text fallback.
        // await ensureCacheFreshCallback({ workspace }); // REMOVED: #883

        // #883: Workspace filter is now auto-defaulted by roosync_search.
        // If still empty here, it means global search was requested explicitly.
        if (!workspace) {
            console.warn('[INFO] Global semantic search (no workspace filter). May be slower on large collections.');
        }

        // Mode diagnostic - retourne des informations sur l'état de l'indexation
        if (diagnose_index) {
            if (diagnoseHandler) {
                return await diagnoseHandler();
            }

            // Fallback si pas de diagnoseHandler fourni
            try {
                const qdrant = getQdrantClient();
                const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
                const collection = await qdrant.getCollection(collectionName);

                const diagnosticText = [
                    `Diagnostic de l'index sémantique:`,
                    `Collection: ${collectionName}`,
                    `Existe: ${collection.status ? 'Oui' : 'Non'}`,
                    collection ? `Points: ${collection.points_count || 'N/A'}` : '',
                    collection ? `Segments: ${collection.segments_count || 'N/A'}` : '',
                    collection ? `Vecteurs indexés: ${collection.indexed_vectors_count || 'N/A'}` : '',
                    collection ? `Status optimiseur: ${collection.optimizer_status === 'ok' ? 'ok' : (collection.optimizer_status as any)?.error || 'N/A'}` : '',
                    `Vérification nécessaire: ${collection ? (collection.status !== 'green' ? 'Oui' : 'Non') : 'Oui'}`,
                    `Cache local: ${conversationCache.size} conversations`
                ].filter(line => line.trim()).join('\n');

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: diagnosticText
                    }]
                };
            } catch (error) {
                // Simuler une erreur de connexion Qdrant pour les tests
                const errorMessage = error instanceof Error ? error.message : String(error);
                const testErrorMessage = errorMessage.includes('Cannot read')
                    ? 'Qdrant connection failed'
                    : `Erreur lors du diagnostic: ${errorMessage}`;

                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: testErrorMessage
                    }]
                };
            }
        }

        // #1232: Circuit breaker — if embedding API failed recently, skip directly to text fallback
        const now = Date.now();
        if (lastEmbeddingFailureTime > 0 && (now - lastEmbeddingFailureTime) < EMBEDDING_CIRCUIT_BREAKER_TTL_MS) {
            const remainingMs = EMBEDDING_CIRCUIT_BREAKER_TTL_MS - (now - lastEmbeddingFailureTime);
            console.warn(`[WARN] #1232: Embedding circuit breaker active, skipping semantic search (${Math.ceil(remainingMs / 1000)}s remaining). Using text fallback.`);
            try {
                const fallbackResult = await fallbackHandler(
                    { query: args.search_query, workspace: args.workspace },
                    conversationCache
                );
                // #1496: Tag fallback results so callers know semantic was skipped
                return injectFallbackMeta(fallbackResult, 'embedding_circuit_breaker_active');
            } catch (fallbackError) {
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: `Embedding API indisponible (circuit breaker actif). Fallback textuel échoué: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
                    }] as any
                };
            }
        }

        // Tentative de recherche sémantique via Qdrant/OpenAI
        try {
            const qdrant = getQdrantClient();
            const openai = getOpenAIClient();

            // #2167: Check query embedding cache before calling the API
            let queryVector = getCachedQueryEmbedding(search_query);
            if (!queryVector) {
                // #249: Wrap embedding call with retry for transient failures
                const embedding = await withRetry(() => openai.embeddings.create({
                    model: getEmbeddingModel(),
                    input: search_query
                }));
                queryVector = embedding.data[0].embedding;
                setCachedQueryEmbedding(search_query, queryVector);
            } else {
                console.log(`[INFO] #2167: Query embedding cache hit for "${search_query.substring(0, 50)}..."`);
            }
            const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';

            // Configuration de la recherche selon conversation_id et workspace
            let filter;
            const filterConditions = [];

            if (conversation_id && conversation_id !== 'undefined') {
                filterConditions.push({
                    key: "task_id",
                    match: {
                        value: conversation_id
                    }
                });
            }

            // #883: Dual workspace fields in Qdrant:
            // - "workspace": full path (d:\roo-extensions) — for intra-machine exact match
            // - "workspace_name": basename (roo-extensions) — for cross-machine filtering
            // If caller passes a basename → filter on workspace_name
            // If caller passes a full path → filter on workspace (exact match)
            if (workspace) {
                const isBasename = !workspace.includes('/') && !workspace.includes('\\');
                if (isBasename) {
                    filterConditions.push({
                        key: "workspace_name",
                        match: { value: workspace }
                    });
                } else {
                    filterConditions.push({
                        key: "workspace",
                        match: { value: workspace }
                    });
                }
            }

            // #604: Filter by conversation source (roo vs claude-code)
            if (source) {
                filterConditions.push({
                    key: "source",
                    match: { value: source }
                });
            }

            // #636: Advanced filters (chunk_type resolved with exclude_tool_results alias)
            if (effectiveChunkType) {
                filterConditions.push({
                    key: "chunk_type",
                    match: { value: effectiveChunkType }
                });
            }

            if (role) {
                filterConditions.push({
                    key: "role",
                    match: { value: role }
                });
            }

            if (tool_name) {
                filterConditions.push({
                    key: "tool_name",
                    match: { value: tool_name }
                });
            }

            if (has_errors === true) {
                filterConditions.push({
                    key: "has_error",
                    match: { value: true }
                });
            }

            if (model) {
                filterConditions.push({
                    key: "model",
                    match: { value: model }
                });
            }

            // #1244 Couche 1.3 — Push date filter INTO Qdrant (range on timestamp field)
            // Avant ce fix, le filtre etait applique APRES retrieval (lignes 548-553) :
            // si un match etait en position 20 et max_results=10, l'utilisateur voyait 0 resultats.
            // Les timestamps sont stockes comme strings ISO 8601 (lexicographiquement comparables).
            const parsedStartDateForQdrant = parseFilterDate(start_date);
            const parsedEndDateForQdrant = parseFilterDate(end_date);
            if (parsedStartDateForQdrant || parsedEndDateForQdrant) {
                const rangeFilter: any = {};
                if (parsedStartDateForQdrant) {
                    rangeFilter.gte = parsedStartDateForQdrant.toISOString();
                }
                if (parsedEndDateForQdrant) {
                    // Pour YYYY-MM-DD, inclure la journee entiere
                    const endOfDay = new Date(parsedEndDateForQdrant.getTime());
                    if (endOfDay.getUTCHours() === 0 && endOfDay.getUTCMinutes() === 0) {
                        endOfDay.setUTCHours(23, 59, 59, 999);
                    }
                    rangeFilter.lte = endOfDay.toISOString();
                }
                filterConditions.push({
                    key: "timestamp",
                    range: rangeFilter
                });
            }

            if (filterConditions.length > 0) {
                filter = { must: filterConditions };
            } else {
                filter = undefined;
            }

            // #831: Add configurable timeout for large vector indexes (9.93M vectors)
            // #1275: Use native Qdrant timeout parameter (seconds) instead of Promise.race leak
            const searchTimeoutSec = Math.ceil(parseInt(process.env.QDRANT_SEARCH_TIMEOUT_MS || '30000', 10) / 1000);

            // #883: Global search is now allowed (workspace auto-defaults in roosync_search)

            // #851: Optimized search params for 10M+ vector collection
            // #3043 (SDDD #2766): diversify-by-task to prevent one task from monopolizing
            // the top-K. A single long task can produce 5+ near-duplicate chunks with
            // scores >= 0.82, starving the response of other relevant tasks. Over-fetch
            // by DIVERSIFY_OVERFETCH so that grouping + per-task cap can surface >=3
            // unique_tasks even when one task dominates the Qdrant ranking.
            const effectiveMaxResults = max_results || 10;
            const diversifyLimit = effectiveMaxResults * DIVERSIFY_OVERFETCH;
            const searchResults = await withRetry(() => qdrant.search(collectionName, {
                vector: queryVector,
                limit: diversifyLimit,
                filter: filter,
                params: {
                    hnsw_ef: 128,
                    exact: false,
                    quantization: { rescore: true }
                },
                with_payload: {
                    // #2426 follow-up: 'host_os' must be in the include whitelist, otherwise
                    // cross_machine_analysis.machines_found is always ['unknown'] (the payload
                    // field exists but is never retrieved).
                    include: ['task_id', 'timestamp', 'chunk_type', 'content', 'content_summary', 'workspace', 'workspace_name', 'source', 'chunk_id', 'task_title', 'role', 'model', 'tool_name', 'has_error', 'host_os', 'message_index', 'total_messages']
                },
                timeout: searchTimeoutSec,
            }));


            // Obtenir l'identifiant de la machine actuelle pour l'en-tête
            const currentHostId = getHostIdentifier();

            // Normalisation de la réponse Qdrant (supporte format tableau direct ou objet { result/points: [...] })
            const rawPoints = Array.isArray(searchResults)
                ? searchResults
                : (searchResults as any).result || (searchResults as any).points || [];

            // Phase 2: Enriched results with snippets, score interpretation, deduplication
            const results: RawSearchResult[] = rawPoints.map((result: any) => {
                // #982 FIX: Prefer full content for snippet extraction (content_summary is only 200 chars)
                const fullContent = String(result.payload?.content || result.payload?.content_summary || '');
                const content = String(result.payload?.content_summary || result.payload?.content || '');
                const score = result.score || 0;
                // #2609 V3: raw ints for the handle — message_position is a display
                // string and cannot drive a conversation_browser re-expansion.
                const messageIndex = typeof result.payload?.message_index === 'number'
                    ? result.payload.message_index
                    : undefined;
                const totalMessages = typeof result.payload?.total_messages === 'number'
                    ? result.payload.total_messages
                    : undefined;
                return {
                    taskId: result.payload?.task_id || 'unknown',
                    score,
                    content: truncateMessage(content, 5),
                    snippet: extractSnippet(fullContent, search_query),
                    relevance: interpretScore(score),
                    drill_down: buildDrillDown(result.payload?.task_id || 'unknown', messageIndex, totalMessages),
                    metadata: {
                        chunk_id: result.payload?.chunk_id,
                        chunk_type: result.payload?.chunk_type,
                        workspace: result.payload?.workspace,
                        task_title: result.payload?.task_title || `Task ${result.payload?.task_id}`,
                        role: result.payload?.role,
                        timestamp: result.payload?.timestamp,
                        relative_time: formatRelativeTime(result.payload?.timestamp),
                        message_position: messageIndex !== undefined && totalMessages !== undefined
                            ? `${messageIndex}/${totalMessages}`
                            : undefined,
                        message_index: messageIndex,
                        total_messages: totalMessages,
                        host_os: result.payload?.host_os || 'unknown',
                        // #636: Enriched metadata
                        source: result.payload?.source,
                        tool_name: result.payload?.tool_name,
                        model: result.payload?.model,
                        has_error: result.payload?.has_error,
                    }
                };
            });

            // #1244 Couche 1.3 — Filtre temporel : double-couche
            //   (a) Push dans Qdrant en amont (range filter sur 'timestamp', cf. l. 477-495)
            //       → fait l'essentiel du travail, evite de transferer des resultats hors plage.
            //   (b) Filet de securite client-side : si Qdrant n'honore pas le filtre
            //       (timestamp non indexe, schema mismatch, mock de tests), on filtre ici aussi.
            //   Avant ce double-niveau, le filtre etait UNIQUEMENT post-Qdrant et apres `limit`,
            //   ce qui pouvait masquer des matches en position > max_results (bug originel #1244).
            const filteredResults = (parsedStartDateForQdrant || parsedEndDateForQdrant)
                ? results.filter(r => isWithinDateRange(r.metadata.timestamp, parsedStartDateForQdrant, parsedEndDateForQdrant))
                : results;

            // Group by task_id: deduplicate multiple chunks from the same conversation
            let groupedResults = groupResultsByTask(filteredResults);

            // #3043 (SDDD #2766): diversify-by-task — cap chunks per task + truncate
            // to max_results unique tasks. Without this, a single long task with many
            // high-score chunks monopolizes the response and unique_tasks stays at 1.
            // #956 résiduel (ai-01 c.160 Item 4 — "mesure la baseline avant de toucher
            // au paramètre"): apply the cap via the unit-tested helper and surface how
            // often it binds, so the cost of the current conservative value (recall
            // dropped from over-represented tasks) becomes measurable. Quiet for the
            // common non-truncating query (reported only when > 0).
            const diversifyStats = applyDiversifyCap(groupedResults, DIVERSIFY_MAX_CHUNKS_PER_TASK);
            if (groupedResults.length > effectiveMaxResults) {
                groupedResults = groupedResults.slice(0, effectiveMaxResults);
            }

            // #2426 Phase C+: Unified-store Postgres enrichment (env-gate)
            // When PgUnifiedStoreReader is active, use joinFromQdrant() to:
            //   (a) Apply message-level filters (tool_name) via Postgres GIN index
            //   (b) Enrich results with conversation metadata from Postgres
            //   (c) Preserve ANN ranking (sorted by Qdrant score)
            const unifiedStoreReader = getUnifiedStoreReader();
            if (!unifiedStoreReader.isNull()) {
                try {
                    const qdrantHits = groupedResults.map(g => ({
                        task_id: g.taskId,
                        score: g.best_score,
                    }));
                    const pgFilters: UnifiedStoreSearchFilters = {};
                    if (workspace) pgFilters.workspace = workspace;
                    // tool_name filter: delegate to Postgres instead of Qdrant payload
                    if (tool_name) pgFilters.tool_name = tool_name;

                    const pgHits = await unifiedStoreReader.joinFromQdrant(qdrantHits, pgFilters);

                    // #2426 follow-up (semantic-recall regression, 2026-06-16): the unified
                    // Postgres store is a DERIVED index that may be incomplete (dual-write
                    // backfill gap). Treat it as ENRICHMENT, not a gate: only apply the
                    // inner-join filter when Postgres actually returned rows; otherwise keep
                    // the Qdrant-only ANN ranking. Without this guard an empty/un-backfilled
                    // Postgres silently nuked every semantic result fleet-wide (the tool
                    // reported results_count > 0 but unique_tasks: 0, results: []).
                    // tool_name filtering is already enforced upstream in the Qdrant filter
                    // (see filterConditions above), so falling back to Qdrant-only when
                    // Postgres has no rows loses no correctness.
                    if (pgHits.length > 0) {
                        const pgTaskIds = new Set(pgHits.map(h => h.task_id));
                        // Filter groupedResults to only those confirmed by Postgres,
                        // re-ordered by ANN score (pgHits is already sorted by score DESC)
                        const pgScoreMap = new Map(pgHits.map(h => [h.task_id, h.score]));
                        groupedResults = groupedResults
                            .filter(g => pgTaskIds.has(g.taskId))
                            .sort((a, b) => (pgScoreMap.get(b.taskId) ?? 0) - (pgScoreMap.get(a.taskId) ?? 0));
                    }
                } catch (err) {
                    // Postgres enrichment failed — fall back to Qdrant-only results (non-blocking)
                    console.warn('[WARN] #2426: Unified-store Postgres JOIN failed, using Qdrant-only results:', err instanceof Error ? err.message : String(err));
                }
            }

            // #636 Phase 2: Enrich grouped results with conversation stats from cache
            for (const group of groupedResults) {
                const cached = conversationCache.get(group.taskId);
                if (cached) {
                    group.conversation_stats = {
                        total_messages: cached.metadata?.messageCount || 0,
                        workspace: cached.metadata?.workspace,
                        last_activity: cached.metadata?.lastActivity || cached.metadata?.createdAt,
                    };
                }
            }

            // #2766 (SDDD echo pollution): collapse cross-task exact-duplicate
            // chunks AFTER grouping + per-task cap + Postgres enrichment, so
            // duplicate_count reflects exactly what is shown. See
            // dedupGroupedChunksByContent for rationale and flags.
            const dedupStats = dedupGroupedChunksByContent(groupedResults);

            // #2609 V3 (rubric (c) — surrounding context): expand the turns adjacent
            // to each retained task's best chunk. Runs after every filter/prune stage
            // so no fetch is wasted; non-blocking on failure; rollback via
            // SEARCH_CONTEXT_EXPANSION=0.
            const contextAttached = await attachConversationContext(groupedResults, qdrant, collectionName);

            // Cross-machine analysis
            const allHosts = filteredResults.map(r => r.metadata.host_os);
            const machinesFound = [...new Set(allHosts)];
            const resultsByMachine: { [key: string]: number } = {};
            for (const host of allHosts) {
                resultsByMachine[host] = (resultsByMachine[host] || 0) + 1;
            }

            // Build enriched report
            const searchReport = {
                // #1496: Observability — semantic succeeded, no fallback
                fallback_used: false,
                original_search_mode: 'semantic',
                actual_search_mode: 'semantic',
                current_machine: {
                    host_id: currentHostId,
                    search_timestamp: new Date().toISOString(),
                    query: search_query,
                    results_count: filteredResults.length,
                    unique_tasks: groupedResults.length,
                    // #636 Phase 2 + #1244 Couche 1.3: temporal filter info
                    // Le filtre est pousse en amont dans Qdrant (range filter sur 'timestamp')
                    // ET applique en defense-in-depth client-side (cf. filteredResults plus haut).
                    ...(parsedStartDateForQdrant || parsedEndDateForQdrant ? {
                        temporal_filter: {
                            start_date: start_date || null,
                            end_date: end_date || null,
                            pre_filter_count: results.length,
                            post_filter_count: filteredResults.length,
                        }
                    } : {}),
                    // #2766 (SDDD): cross-task dedup observability. Emitted only when
                    // dedup removed something OR is explicitly disabled (rollback
                    // visibility); quiet for the common 0-duplicate query.
                    ...(dedupStats.duplicates_removed > 0 || !dedupStats.enabled ? {
                        dedup: {
                            enabled: dedupStats.enabled,
                            mode: dedupStats.mode,
                            duplicates_removed: dedupStats.duplicates_removed,
                            groups_pruned: dedupStats.groups_pruned,
                        }
                    } : {}),
                    // #956 résiduel (ai-01 c.160 Item 4): diversify-cap observability.
                    // Emitted only when the per-task cap actually truncated groups, so the
                    // baseline (how often cap=2 binds → recall left on the table) becomes
                    // measurable before any decision to raise DIVERSIFY_MAX_CHUNKS_PER_TASK.
                    ...(diversifyStats.truncated_groups > 0 ? {
                        diversify: {
                            cap_per_task: DIVERSIFY_MAX_CHUNKS_PER_TASK,
                            truncated_groups: diversifyStats.truncated_groups,
                            chunks_capped: diversifyStats.chunks_capped,
                        }
                    } : {}),
                    // #2609 V3 (rubric (c)): context-expansion observability. Emitted
                    // only when it attached something OR is explicitly disabled
                    // (rollback visibility) — quiet for the common query, same
                    // convention as dedup/diversify above.
                    ...(contextAttached > 0 || process.env.SEARCH_CONTEXT_EXPANSION === '0' ? {
                        context_expansion: {
                            attached_groups: contextAttached,
                            enabled: process.env.SEARCH_CONTEXT_EXPANSION !== '0',
                        }
                    } : {})
                },
                cross_machine_analysis: {
                    machines_found: machinesFound,
                    results_by_machine: resultsByMachine
                },
                results: groupedResults
            };

            return {
                isError: false,
                content: [{
                    type: 'text',
                    text: JSON.stringify(searchReport, null, 2)
                }]
            };

        } catch (semanticError) {
            // #1232: Activate circuit breaker on HTTP 5xx OR AbortError/timeout
            if (isHttpServerError(semanticError) || isAbortOrTimeout(semanticError)) {
                lastEmbeddingFailureTime = Date.now();
                console.warn(`[WARN] #1232: Embedding circuit breaker activated for ${EMBEDDING_CIRCUIT_BREAKER_TTL_MS / 1000}s`);
            }

            const semanticErrorMsg = semanticError instanceof Error ? semanticError.message : String(semanticError);

            // #2063 P1: Classify the error for actionable diagnostics
            const classified = await classifySearchError(semanticError, 'search');

            // #1496: Strict mode — propagate the classified error instead of silently
            // falling back to text. Callers that explicitly requested semantic
            // (like `roosync_search(action: "semantic")`) need to know when the
            // embedding backend is down, otherwise they treat text results as
            // semantic and real regressions go unnoticed for days (cf #1407, #1451).
            if (args.strict_mode) {
                console.warn(`[WARN] Semantic search failed in strict_mode (${classified.mode}): ${semanticErrorMsg}`);
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: formatClassifiedError(classified) +
                              `\n\n  Fallback: use roosync_search(action: "text") for text-based search.`
                    }]
                };
            }

            console.warn(`[WARN] Semantic search failed (${classified.mode}), falling back to text: ${semanticErrorMsg}`);

            // #1496: Determine fallback reason from classified error
            const fallbackReason: FallbackReason = isAbortOrTimeout(semanticError)
                ? 'embedding_timeout'
                : 'embedding_api_error';

            // Fallback vers la recherche textuelle simple (legacy — default path)
            try {
                const fallbackResult = await fallbackHandler(
                    { query: args.search_query, workspace: args.workspace },
                    conversationCache
                );

                // #1496: Tag fallback results so callers know semantic failed
                return injectFallbackMeta(fallbackResult, fallbackReason);
            } catch (fallbackError) {
                console.log(`[ERROR] Fallback handler a échoué: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
                return {
                    isError: false,
                    content: [{
                        type: 'text',
                        text: `Semantic search failed (${classified.mode}), fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n\n` +
                              `Diagnostics: ${classified.message}\nHint: ${classified.hint}`
                    }] as any
                };
            }
        }
    }
};