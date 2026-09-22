import { promises as fs, createReadStream } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { v5 as uuidv5 } from 'uuid';
import { StateManagerError } from '../../types/errors.js';

// Namespace pour UUID v5 (généré aléatoirement une fois, constant pour le projet)
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * #2018: Compute a deterministic chunk_id from logical chunk identity.
 *
 * Same (task_id, chunk_type, sequence_order, content) → same UUID.
 * Re-indexation upserts existing points instead of creating duplicates.
 *
 * Seed: `${task_id}|${chunk_type}|seq:${sequence_order}|${sha256_16}`
 * sha256 truncated to 16 hex chars: 64-bit collision resistance, sufficient
 * intra-task where the seq+task_id already disambiguate non-content collisions.
 */
export function computeChunkId(
    taskId: string,
    _chunkType: string,
    sequenceOrder: number,
    content: string
): string {
    // #2247: chunk_type removed from seed — future taxonomy fixes won't break UUIDs
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const seed = `${taskId}|seq:${sequenceOrder}|${contentHash}`;
    return uuidv5(seed, UUID_NAMESPACE);
}

/**
 * #1758: Maximum chunks per task_id before hard truncation.
 * Prevents runaway indexing of worker sessions with 200K+ messages.
 * Default: 50,000 chunks ≈ ~2000 messages (25 chunks/msg average).
 * Configurable via MAX_CHUNKS_PER_TASK env var.
 */
export const MAX_CHUNKS_PER_TASK = parseInt(process.env.MAX_CHUNKS_PER_TASK || '50000', 10);

/**
 * #1758: Maximum messages per task before warning + early truncation.
 * Sessions exceeding this are likely runaway workers (--continue loops).
 * Default: 10,000 messages. Configurable via MAX_MESSAGES_PER_TASK env var.
 */
export const MAX_MESSAGES_PER_TASK = parseInt(process.env.MAX_MESSAGES_PER_TASK || '10000', 10);

/**
 * #2825 (volet A / G1): Maximum sub-chunks a single message/tool chunk may split into.
 *
 * Replaces the former mid-content truncation (`truncateForIndexing`, which dropped the
 * MIDDLE of any content > 20k chars — silently losing the reasoning inside long assistant
 * messages). Content is now carried in FULL into chunks and split losslessly downstream by
 * `splitChunk`. This budget preserves the #1758 anti-explosion intent as a *bounded, logged*
 * backstop for pathological single values (e.g. multi-MB tool dumps) instead of a silent
 * amputation: 2,000 sub-chunks × 800 chars (MAX_CHUNK_SIZE) ≈ 1.6 MB fully indexed per message.
 * Any residual beyond the budget is `console.warn`-ed, never dropped silently.
 * Configurable via MAX_SUBCHUNKS_PER_CHUNK env var (raise it to index even larger single values).
 */
export const MAX_SUBCHUNKS_PER_CHUNK = parseInt(process.env.MAX_SUBCHUNKS_PER_CHUNK || '2000', 10);

export interface ToolDetails {
  tool_name: string;
  parameters: any;
  status: 'success' | 'failure' | 'in_progress';
  summary?: string;
  result?: any;
}

export interface Chunk {
  chunk_id: string;
  task_id: string;
  parent_task_id: string | null;
  root_task_id: string | null;
  chunk_type: 'message_exchange' | 'tool_interaction' | 'task_summary' | 'code_citation';
  sequence_order: number;
  timestamp: string;
  indexed: boolean;
  content: string;
  content_summary?: string;
  participants?: ('user' | 'assistant')[];
  tool_details?: ToolDetails | null;
  custom_tags?: string[];
  workspace?: string;           // Full path (e.g., "d:/roo-extensions") — intra-machine filtering
  workspace_name?: string;      // Basename (e.g., "roo-extensions") — cross-machine filtering
  task_title?: string;
  message_index?: number;
  total_messages?: number;
  role?: 'user' | 'assistant' | 'system';
  host_os?: string;
  source?: 'roo' | 'claude-code';
  // #636: Enriched metadata for advanced search filters
  model?: string;          // LLM model used (e.g., 'opus', 'sonnet', 'glm-5')
  tool_name?: string;      // Flattened from tool_details for Qdrant filtering
  has_error?: boolean;     // Whether this chunk contains an error
  // Nouveaux champs pour la traçabilité du chunking
  chunk_index?: number;  // Index de ce chunk (commence à 1)
  total_chunks?: number; // Nombre total de chunks pour ce message
  original_chunk_id?: string; // ID original avant split (pour traçabilité)
  // #2825 (volet A / G3): pagination metadata for lossless splitting of oversized
  // conversations. When a task exceeds MAX_MESSAGES_PER_TASK, the extractor emits
  // the overflow as additional "child units" with synthetic task_ids
  // (`${taskId}#unit-${N}`); `child_unit_index` is the 1-based page number and
  // `child_unit_total` is the total page count. (root_task_id is declared above
  // as `string | null`; pagination lineage is conveyed via parent_task_id chain.)
  child_unit_index?: number;
  child_unit_total?: number;
  // #2825 (volet A / G5): chunk_type 'task_summary' is the first-class type for
  // condensation outputs — already declared in the union above; this comment is
  // the marker for downstream consumers (search filters, dashboards).
}

// Fichiers de conversation bruts
export interface ApiMessage {
    role: 'user' | 'assistant' | 'system';
    content: any; // Can be string or array
    tool_calls?: any[];
    timestamp?: string;
}

export interface UiMessage {
    author: 'user' | 'agent';
    text: string;
    timestamp: string;
}

export function getHostIdentifier() {
    // Crée un identifiant unique basé sur les informations système
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();
    return `${hostname}-${platform}-${arch}`;
}

/**
 * #3344: separator-robust basename for workspace paths.
 *
 * Indexed workspaces carry both separator styles (Roo metadata uses forward
 * slashes, Claude Code `cwd` uses backslashes on Windows), and `path.basename`
 * only handles the separator convention of the CURRENT platform — breaking
 * under the Ubuntu CI while working on the Windows fleet. Splitting on both
 * separators is deterministic everywhere.
 */
export function workspaceBasename(ws: string): string {
    const parts = ws.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || ws;
}

/**
 * #2247 follow-up (po-204 c.161, ai-01 c.160 SDDD): classify code citations.
 *
 * Returns true if the content is predominantly a cited code block (a fenced
 * block OR an indented code sample) rather than a message exchange. The aim is
 * to disambiguate the echo-pollution family where a `[tool_result]` payload
 * (often JSON, often a snippet from a baseline/settings file) is currently
 * emitted as `chunk_type='message_exchange'` and re-ingested as if it were a
 * fresh user turn — so the same JSON turns up in `codebase_search` results
 * ranked above the actual conversation content.
 *
 * Heuristic (intentionally conservative — false-negatives are cheap, false
 * positives cost signal):
 *   - fenced block ratio >= 0.5 (the fenced code occupies the majority of the
 *     trimmed content), OR
 *   - ratio of lines that *look like code* (indented, or ending in `{ } ; :`
 *     outside natural-language punctuation) >= 0.5 AND the first non-empty
 *     line is itself code-shaped (no prose prefix).
 *
 * The helper is exported for unit testing; production callers should reach
 * for the union type `'code_citation'` rather than re-implementing the check.
 */
export function isCodeCitation(content: string): boolean {
    if (!content) return false;
    const trimmed = content.trim();
    if (trimmed.length < 40) return false; // too short to classify reliably
    const fenceMatches = trimmed.match(/```[\s\S]*?(?:```|$)/g) || [];
    const fenceChars = fenceMatches.reduce((acc, m) => acc + m.length, 0);
    if (fenceChars > 0 && fenceChars / trimmed.length >= 0.5) return true;

    const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length < 3) return false;
    const codeLineRe = /^[ \t].*[{}\];:]|^[ \t]*(?:def |class |function |const |let |var |import |export |from |#|\/\/|\/\*|if |for |while |return |[a-zA-Z_][\w]*\s*\()[\s\S]*[{}\];:]$/;
    let codeLike = 0;
    for (const line of lines) {
        if (codeLineRe.test(line)) codeLike++;
    }
    if (codeLike / lines.length < 0.5) return false;
    // First non-empty line must also be code-shaped — guards against "Here's
    // the snippet:\n  foo();\n  bar();" where the prose prefix should keep
    // the chunk in message_exchange territory.
    const firstNonEmpty = lines[0];
    return codeLineRe.test(firstNonEmpty) || /^[ \t]/.test(firstNonEmpty);
}

/**
 * #2949: Extract tool_result block text (Anthropic format) for indexing.
 *
 * Claude Code stores tool results as `{type:'tool_result', content:'...'}` content blocks
 * inside user-role messages. The text extraction above only keeps `type:'text'` blocks, so
 * tool outputs were dropped → `contentText=''` → the message chunk was skipped → tool output
 * was never indexed in Qdrant and invisible to `roosync_search(semantic)`.
 *
 * Serializes each tool_result with a `[tool_result] Result:` marker (same shape as the fix
 * in claude-storage-detector.extractContent, #894) so the content is both searchable and
 * recognizable as a tool output. `content` may be a string or an array of `{type:'text'}` blocks.
 */
function extractToolResultText(content: any[]): string {
    return content
        .filter((block: any) => block && typeof block === 'object' && block.type === 'tool_result')
        .map((block: any) => {
            const rc = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content
                        .map((b: any) => (b && typeof b.text === 'string') ? b.text : '')
                        .join('')
                    : '';
            return `[tool_result] Result: ${rc}`;
        })
        .join('\n\n');
}

/**
 * #3763: Inline condensation-boundary detection.
 *
 * Long Claude Code sessions are condensed several times during their lifetime;
 * each condensation is a natural chapter break in the timeline, and the
 * synthetic condensation-fallback tasks already produced by dashboard.ts carry
 * well-known content markers. We re-use those markers here to detect chapter
 * heads embedded in a *single* long task, so the extractor can split child
 * units at chapter boundaries instead of at arbitrary `MAX_MESSAGES_PER_TASK`
 * counts. When no markers are present (Roo sessions, sessions never condensed,
 * Claude Code JSONL whose runtime uses different markers) we fall back to the
 * count-based paging — no regression for the un-marked case.
 *
 * Patterns detected (intentionally narrow — false-negatives are cheap, false
 * positives corrupt lineage):
 *   - `[CONDENSATION ARCHIVE]` — user-message prefix written by dashboard.ts:2745
 *   - `[Condensation summary]` — synthetic-task title written by dashboard.ts:2715
 *
 * @param messages Array of messages in chronological order. Each entry may be
 *                 an ApiMessage (`{role, content, ...}`) or a UiMessage
 *                 (`{author, text, ...}`); the helper extracts the relevant
 *                 text field transparently.
 * @returns 1-based indices into the `messages` array where a boundary starts
 *          (i.e., the message AT the index is the head of a new chapter).
 *          Empty array = no boundaries detected → caller falls back to count.
 */
export function detectCondensationBoundaries(messages: any[]): number[] {
    const boundaries: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m) continue;
        // UiMessage uses `text`; ApiMessage uses `content` (string or array of
        // text blocks). We only inspect the leading string — the synthetic
        // markers are written verbatim at message head.
        let head = '';
        if (typeof m.text === 'string') {
            head = m.text;
        } else if (typeof m.content === 'string') {
            head = m.content;
        } else if (Array.isArray(m.content)) {
            const first = m.content[0];
            if (first && typeof first.text === 'string') head = first.text;
        }
        if (
            head.startsWith('[CONDENSATION ARCHIVE]') ||
            head.startsWith('[Condensation summary]')
        ) {
            // 1-based: message N is the start of chapter N (not chapter N-1).
            boundaries.push(i + 1);
        }
    }
    return boundaries;
}

/**
 * #3763: Pick the cut points for child-unit paging.
 *
 * If condensation boundaries were detected, use them as cut points (so each
 * chapter becomes its own child unit). Otherwise fall back to count-based
 * paging every `MESSAGES_PER_CHILD_UNIT` messages. Always includes 1 (head)
 * and the count past the last message so callers can iterate uniformly.
 *
 * @param totalMessages Total emitted-message count (api + ui combined).
 * @param boundaries 1-based indices where a boundary begins (output of
 *                   `detectCondensationBoundaries`).
 * @param messagesPerChildUnit Count-based paging budget (#1758/#2825 G2).
 * @returns Sorted, deduped 1-based cut points. Always includes 1 and
 *          `totalMessages + 1`.
 */
export function pickChildUnitCutPoints(
    totalMessages: number,
    boundaries: number[],
    messagesPerChildUnit: number
): number[] {
    if (totalMessages <= 0) return [1];
    const cuts = new Set<number>([1]);
    if (boundaries.length > 0) {
        // Use the detected boundaries as cut points (1-based; cap to totalMessages).
        for (const b of boundaries) {
            if (b >= 1 && b <= totalMessages) cuts.add(b);
        }
    } else {
        // No boundaries — fall back to count-based paging every N messages.
        for (let n = messagesPerChildUnit; n < totalMessages; n += messagesPerChildUnit) {
            cuts.add(n + 1);
        }
    }
    cuts.add(totalMessages + 1);
    return Array.from(cuts).sort((a, b) => a - b);
}

/**
 * #3763: Map a 1-based message index to its child-unit index, given the cut
 * points from `pickChildUnitCutPoints`.
 *
 * @param messageIndex1 1-based index of the message within the emitted sequence.
 * @param cutPoints Sorted 1-based cut points; child unit K spans
 *                  `[cutPoints[K-1], cutPoints[K])`.
 * @returns 1-based child unit index.
 */
export function childUnitIndexFor(
    messageIndex1: number,
    cutPoints: number[]
): number {
    for (let i = 0; i < cutPoints.length; i++) {
        const start = cutPoints[i];
        const end = i + 1 < cutPoints.length ? cutPoints[i + 1] : Number.POSITIVE_INFINITY;
        if (messageIndex1 >= start && messageIndex1 < end) return i + 1;
    }
    return cutPoints.length;
}

/**
 * Extrait et structure les chunks d'une tâche selon la stratégie granulaire.
 * @param taskId L'ID de la tâche.
 * @param taskPath Le chemin vers le répertoire de la tâche.
 * @returns Un tableau de chunks structurés.
 */
export async function extractChunksFromTask(taskId: string, taskPath: string): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
    const metadataPath = path.join(taskPath, 'task_metadata.json');
    let sequenceOrder = 0;

    // Variables pour les métadonnées extraites
    let messageIndex = 0;
    let parentTaskId : string | undefined;
    let workspace : string | undefined;
    let taskTitle : string | undefined;
    let totalMessages : number | undefined;
    let taskModel : string | undefined; // #636: Model from task metadata
    // #2825 (volet A / G5): when a task's metadata.source === 'condensation-fallback',
    // the chunks we emit carry chunk_type='task_summary' (instead of 'message_exchange')
    // so search consumers can filter condensation outputs. Set after metadata read below.
    let sourceKind: 'roo' | 'claude-code' | 'condensation-fallback' | null = null;
    // #2825 (volet A / G2): child-unit paging constants. Declared in outer scope so the
    // ui_messages loop below (separate try block) shares the same paging — both loops
    // count toward the same child-unit boundary, preserving lineage across message sources.
    let MESSAGES_PER_CHILD_UNIT = MAX_MESSAGES_PER_TASK;
    let childUnitCount = 1;
    // #3763: chapter-boundary state. Hoisted to function scope so the api
    // loop (try block), ui loop (sibling block), and post-loop patch can all
    // share the same accumulators. Pre-computing the boundary sets here (vs.
    // inside the api try block) also avoids recomputing them when an api-read
    // exception rethrows before the loop runs.
    let emittedBoundaryPositions: number[] = [];
    let childUnitIdx = 1;
    let apiRawIndex = 0;
    let uiRawIndex = 0;
    let rawApiBoundaries: Set<number> = new Set();
    let rawUiBoundaries: Set<number> = new Set();

    // 🎯 CORRECTION CRITIQUE - Extraction des métadonnées hiérarchiques
    // Utilisation de la même logique que roo-storage-detector.ts pour cohérence
    try {
        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        // Nettoyage explicite du BOM (Byte Order Mark)
        const cleanMetadata = metadataContent.charCodeAt(0) === 0xFEFF
            ? metadataContent.slice(1)
            : metadataContent;
        const rawMetadata = JSON.parse(cleanMetadata);

        // ✅ LOGIQUE UNIFIÉE : Même extraction que roo-storage-detector.ts:426
        parentTaskId = rawMetadata.parentTaskId || rawMetadata.parent_task_id;

        // 🚫 SUPPRIMÉ : inferParentTaskIdFromContent - impasse remontante
        // Le parentId doit être enregistré de façon descendante au moment de la création
        if (!parentTaskId) {
            console.log(`[extractChunksFromTask] Task ${taskId} sans parentTaskId - normal pour tâche racine ou parentId non encore enregistré`);
        }

        workspace = rawMetadata.workspace;
        taskTitle = rawMetadata.title;
        // #636: Extract model info from metadata if available
        taskModel = rawMetadata.model || rawMetadata.apiConfiguration?.apiModelId;
        // #2825 (G5): detect synthetic condensation tasks so we emit chunk_type='task_summary'
        if (rawMetadata.source === 'condensation-fallback') {
            sourceKind = 'condensation-fallback';
        }

        console.log(`📊 [extractChunksFromTask] Extracted metadata for ${taskId}: parentTaskId=${parentTaskId}, workspace=${workspace}`);
    } catch (error) {
        console.warn(`⚠️ [extractChunksFromTask] Could not read metadata for ${taskId}:`, error);
        // Continuer sans métadonnées - ne pas faire planter l'indexation
    }

    // #2828 nit 1: Pre-read ui_messages to compute an accurate childUnitCount.
    // Previously, childUnitCount was derived from apiMessages.length only, but
    // messageIndex is incremented in both the api and ui loops — ui messages can
    // push the index past childUnitCount * MESSAGES_PER_CHILD_UNIT, producing
    // child_unit_index values that exceed child_unit_total.
    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
    let uiMessages: UiMessage[] = [];
    try {
        const uiMessagesContent = await fs.readFile(uiMessagesPath, 'utf-8');
        const parsed = JSON.parse(uiMessagesContent);
        if (Array.isArray(parsed)) uiMessages = parsed;
    } catch {
        // File may not exist or be malformed — no ui messages
    }

    try {
        await fs.access(apiHistoryPath);
        const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8');
        const apiMessages: ApiMessage[] = JSON.parse(apiHistoryContent);

        // #3344: derive workspace when task_metadata.json omits it (48.2% of sampled
        // points indexed with NEITHER workspace NOR workspace_name — ai-01 counter-
        // sample 2026-08-31). Same regex as roo-storage-detector.ts skeleton-level
        // detection: the Roo system prompt embeds "Current Workspace Directory (<path>)".
        if (!workspace) {
            const wsMatch = apiHistoryContent.match(/Current Workspace Directory \(([^)]+)\)/);
            if (wsMatch?.[1]) {
                workspace = wsMatch[1].trim();
                console.log(`[extractChunksFromTask] #3344: derived workspace "${workspace}" from api_conversation_history (metadata had none) for ${taskId}`);
            }
        }

        // #2825 (volet A / G2): page through ALL messages — no silent drop.
        // The previous `slice(0, MAX_MESSAGES_PER_TASK)` amputated 90%+ of runaway
        // worker sessions with no recovery. We now iterate over every message and
        // emit child unit IDs (${taskId}#unit-N) when crossing the budget boundary,
        // so the entire conversation stays searchable in Qdrant. The split is
        // LOGGED (not silently truncated) per the "no silent caps" principle.
        // The #1758 anti-runaway intent is preserved as a *budget per child unit*,
        // not as a hard ceiling on indexed content.
        const totalMessagesCount = apiMessages.length;
        // #2828 nit 1: include ui_messages in the count so child_unit_total reflects
        // the true number of child units across api + ui combined.
        const combinedCount = totalMessagesCount + uiMessages.length;
        if (combinedCount > MAX_MESSAGES_PER_TASK) {
            console.warn(`⚠️ [#2825/G2] Task ${taskId} has ${combinedCount} messages (api=${totalMessagesCount}, ui=${uiMessages.length}) — exceeds MAX_MESSAGES_PER_TASK=${MAX_MESSAGES_PER_TASK}; splitting into child units (NO DROP, all messages will be indexed).`);
        }
        // Reassign the outer-scope paging constants (declared at function top).
        MESSAGES_PER_CHILD_UNIT = MAX_MESSAGES_PER_TASK;

        // #3763: detect inline condensation boundaries on the raw arrays, then
        // track emitted-boundary indices in step with `messageIndex` inside the
        // loops below. `emittedBoundaryPositions` is appended each time an
        // emitted message carries a known condensation marker; the resulting
        // 1-based list feeds `pickChildUnitCutPoints` once both loops finish.
        // We index the api and ui streams separately because filtering (system
        // role, empty content) shifts the emitted index away from the raw index,
        // and the mapping is computed at emit-time, not pre-scan-time.
        rawApiBoundaries = new Set(detectCondensationBoundaries(apiMessages));
        rawUiBoundaries = new Set(detectCondensationBoundaries(uiMessages));

        for (const msg of apiMessages) {
            apiRawIndex++;
            // #3763: detect a boundary marker on this RAW api message. We check
            // at raw-index time so that empty-content / system-role skips don't
            // shift the boundary off the marker. Only the emitted count matters
            // for paging, and `emittedBoundaryPositions` records the EMITTED
            // 1-based index below when the message is actually emitted.
            const isApiBoundary = rawApiBoundaries.has(apiRawIndex);
            if (msg.role === 'system') continue;
            if (msg.content) {
                messageIndex++;

                // Handle both string and array content (OpenAI format) with improved safety
                let contentText: string = '';
                if (typeof msg.content === 'string') {
                    contentText = msg.content;
                } else if (Array.isArray(msg.content)) {
                    // Safely extract text from complex array content
                    contentText = (msg.content as any[])
                        .map((part: any) => {
                            if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
                                return part.text;
                            }
                            return '';
                        })
                        .join(' ')
                        .trim();

                    // #2949: Fold tool_result blocks (Anthropic format — user messages returning
                    // tool output) into contentText so the output is indexed/searchable. Without
                    // this, a user message containing only a tool_result serializes to '' and is
                    // skipped at the `if (contentText.trim())` guard below → tool output never
                    // reaches Qdrant. Emitted FIRST so any downstream leading-anchor logic holds.
                    const toolResultText = extractToolResultText(msg.content as any[]);
                    if (toolResultText) {
                        contentText = toolResultText + (contentText ? '\n\n' + contentText : '');
                    }

                    // #2336 D2 étape B: Extract tool_use blocks (Anthropic format) → populate msg.tool_calls
                    // so the existing handler below (line ~260) can emit tool_interaction chunks.
                    if (!msg.tool_calls) {
                        const toolUseBlocks = (msg.content as any[]).filter(
                            (part: any) => part && typeof part === 'object' && part.type === 'tool_use'
                        );
                        if (toolUseBlocks.length > 0) {
                            msg.tool_calls = toolUseBlocks.map((block: any) => ({
                                function: {
                                    name: block.name || 'unknown',
                                    arguments: typeof block.input === 'string'
                                        ? block.input
                                        : JSON.stringify(block.input || {}),
                                },
                            }));
                        }
                    }
                } else if (msg.content) {
                    // Fallback for any other type, ensuring it becomes a string
                    contentText = String(msg.content);
                }

                if (contentText.trim()) {
                    // #2825 (G1): content carried in FULL — split losslessly downstream by splitChunk (no mid-content amputation).
                    // #636: Detect error patterns in content
                    const lowerContent = contentText.toLowerCase();
                    const hasError = lowerContent.includes('error') ||
                        lowerContent.includes('failed') ||
                        lowerContent.includes('exception') ||
                        lowerContent.includes('❌') ||
                        lowerContent.includes('erreur');

                    const seq = sequenceOrder++;
                    // #3763: provisional child-unit index from the running estimate
                    // (placeholder cut points until both api + ui loops close).
                    // Final index is patched below after `pickChildUnitCutPoints`
                    // runs against `emittedBoundaryPositions`.
                    const unitIndex0 = Math.floor((messageIndex - 1) / MESSAGES_PER_CHILD_UNIT);
                    childUnitIdx = unitIndex0 + 1;
                    if (isApiBoundary) {
                        // Record the EMITTED 1-based index where the boundary starts.
                        emittedBoundaryPositions.push(messageIndex);
                    }
                    const isOverflowUnit = childUnitIdx > 1;
                    const effectiveTaskId = isOverflowUnit
                        ? `${taskId}#unit-${childUnitIdx}`
                        : taskId;
                    // #2825 (G5): chunk_type 'task_summary' for condensation outputs
                    // po-204 c.161 (SDDD echo half): route code citations to a distinct
                    // chunk_type so search filters can demote them vs genuine prose turns.
                    // Task summary wins — condensation outputs must not be re-tagged.
                    let chunkType: Chunk['chunk_type'];
                    if (sourceKind === 'condensation-fallback') {
                        chunkType = 'task_summary';
                    } else if (isCodeCitation(contentText)) {
                        chunkType = 'code_citation';
                    } else {
                        chunkType = 'message_exchange';
                    }
                    chunks.push({
                        chunk_id: computeChunkId(effectiveTaskId, chunkType, seq, contentText),
                        task_id: effectiveTaskId,
                        parent_task_id: isOverflowUnit ? taskId : (parentTaskId || null),
                        root_task_id: parentTaskId || (isOverflowUnit ? taskId : null),
                        chunk_type: chunkType,
                        sequence_order: seq,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true,
                        content: contentText,
                        content_summary: String(contentText || '').substring(0, 200),
                        participants: [msg.role],
                        tool_details: null,
                        workspace: workspace,
                        workspace_name: workspace ? workspaceBasename(workspace) : undefined,
                        task_title: taskTitle,
                        message_index: messageIndex,
                        total_messages: totalMessages,
                        role: msg.role,
                        host_os: getHostIdentifier(),
                        // #636: Enriched metadata
                        model: taskModel,
                        has_error: hasError || undefined,
                        // #2825 (G2/G3): pagination metadata so search can reassemble siblings
                        child_unit_index: childUnitIdx,
                        child_unit_total: childUnitCount,
                    });
                }
            }
            if (msg.tool_calls) {
                for (const toolCall of msg.tool_calls) {
                    // Parse tool arguments safely
                    let parsedArgs: any = {};
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch {
                        parsedArgs = { raw: toolCall.function.arguments };
                    }

                    // #2825 (G1): full args carried — split losslessly downstream by splitChunk.
                    const toolContent = `Tool call: ${toolCall.function.name} with args ${toolCall.function.arguments}`;

                    const seq = sequenceOrder++;
                    // #2825 (G2/G3): tool calls belong to the same child unit as their
                    // parent message (use messageIndex as the paging anchor).
                    // #3763: keep `toolChildUnitIdx` in lockstep with the text chunk's
                    // provisional index — both are patched post-loop.
                    const toolUnitIndex0 = Math.floor((messageIndex - 1) / MESSAGES_PER_CHILD_UNIT);
                    const toolChildUnitIdx = toolUnitIndex0 + 1;
                    const toolIsOverflow = toolChildUnitIdx > 1;
                    const toolEffectiveTaskId = toolIsOverflow
                        ? `${taskId}#unit-${toolChildUnitIdx}`
                        : taskId;
                    chunks.push({
                        chunk_id: computeChunkId(toolEffectiveTaskId, 'tool_interaction', seq, toolContent),
                        task_id: toolEffectiveTaskId,
                        parent_task_id: toolIsOverflow ? taskId : (parentTaskId || null),
                        root_task_id: parentTaskId || (toolIsOverflow ? taskId : null),
                        chunk_type: 'tool_interaction',
                        sequence_order: seq,
                        timestamp: msg.timestamp || new Date().toISOString(),
                        indexed: true, // #2247: tool interactions are valuable search targets
                        content: toolContent,
                        tool_details: {
                            tool_name: toolCall.function.name,
                            parameters: parsedArgs,
                            status: 'success',
                        },
                        // #636: Enriched metadata for Qdrant filtering
                        tool_name: toolCall.function.name,
                        model: taskModel,
                        workspace: workspace,
                        workspace_name: workspace ? workspaceBasename(workspace) : undefined,
                        task_title: taskTitle,
                        host_os: getHostIdentifier(),
                        // #3763 (review fix): tool chunks carry their PARENT
                        // message's emitted index — the post-loop unit patch
                        // reads `message_index` directly instead of inventing
                        // one from a cursor (which drifted at boundaries).
                        message_index: messageIndex,
                        // #2825 (G2/G3): pagination metadata
                        child_unit_index: toolChildUnitIdx,
                        child_unit_total: childUnitCount,
                    });
                }
            }
        }
    } catch (error) {
        /**
         * ✅ CORRECTION P0 (2025-10-15) - Amélioration gestion d'erreur
         * Plus de faux succès : propager l'erreur pour diagnostic
         */
        console.error('❌ ERREUR CRITIQUE extraction chunks:', error);
        console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack');
        console.error(`Fichier problématique: ${apiHistoryPath}`);
        console.error(`Task ID: ${taskId}`);

        // Propager l'erreur pour éviter faux succès silencieux
        throw new StateManagerError(
            `Extraction chunks échouée pour ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            'CHUNK_EXTRACTION_FAILED',
            'ChunkExtractor',
            { taskId, apiHistoryPath },
            error instanceof Error ? error : undefined
        );
    }

    // #2828 nit 1: ui_messages were pre-read above (before the api loop) to compute
    // an accurate childUnitCount. Iterate the in-memory array here — no second read.
    {
        for (const msg of uiMessages) {
            uiRawIndex++;
            // #636: Detect error patterns
            const uiLower = (msg.text || '').toLowerCase();
            const uiHasError = uiLower.includes('error') || uiLower.includes('failed') || uiLower.includes('❌');

            const uiContent = msg.text || ''; // #2825 (G1): full content — split losslessly downstream by splitChunk.

            const seq = sequenceOrder++;
            // #2825 (G2/G3): UI messages count toward the same child-unit paging as api messages.
            // #3763: provisional child-unit index — final index is patched below
            // after both api + ui loops close, from `pickChildUnitCutPoints`.
            const uiMessageIndex = ++messageIndex;
            const uiUnitIndex0 = Math.floor((uiMessageIndex - 1) / MESSAGES_PER_CHILD_UNIT);
            const uiChildUnitIdx = uiUnitIndex0 + 1;
            // #3763: detect condensation boundary on this ui message (raw index).
            if (rawUiBoundaries.has(uiRawIndex)) {
                emittedBoundaryPositions.push(uiMessageIndex);
            }
            const uiIsOverflow = uiChildUnitIdx > 1;
            const uiEffectiveTaskId = uiIsOverflow
                ? `${taskId}#unit-${uiChildUnitIdx}`
                : taskId;
            // #2825 (G5): chunk_type 'task_summary' for condensation outputs
            // po-204 c.161: same code_citation routing as the api loop above.
            let uiChunkType: Chunk['chunk_type'];
            if (sourceKind === 'condensation-fallback') {
                uiChunkType = 'task_summary';
            } else if (isCodeCitation(uiContent)) {
                uiChunkType = 'code_citation';
            } else {
                uiChunkType = 'message_exchange';
            }
            chunks.push({
                chunk_id: computeChunkId(uiEffectiveTaskId, uiChunkType, seq, uiContent),
                task_id: uiEffectiveTaskId,
                parent_task_id: uiIsOverflow ? taskId : (parentTaskId || null),
                root_task_id: parentTaskId || (uiIsOverflow ? taskId : null),
                chunk_type: uiChunkType,
                sequence_order: seq,
                timestamp: msg.timestamp || new Date().toISOString(),
                indexed: true,
                content: uiContent,
                content_summary: (uiContent || '').substring(0, 200),
                participants: [msg.author === 'agent' ? 'assistant' : 'user'],
                tool_details: null,
                workspace: workspace,
                workspace_name: workspace ? workspaceBasename(workspace) : undefined,
                task_title: taskTitle,
                host_os: getHostIdentifier(),
                // #636: Enriched metadata
                model: taskModel,
                has_error: uiHasError || undefined,
                // #3763 (review fix): ui chunks carry their own emitted index
                // so the post-loop unit patch reads `message_index` directly
                // (the old cursor fallback invented indices here).
                message_index: uiMessageIndex,
                // #2825 (G2/G3): pagination metadata — provisional, patched post-loop
                child_unit_index: uiChildUnitIdx,
                child_unit_total: childUnitCount,
            });
        }
    }

    // #3763: post-loop patch. Now that BOTH api and ui loops have closed,
    // `emittedBoundaryPositions` holds the FINAL 1-based emitted indices
    // where condensation chapters begin. Compute the real cut points and
    // rebuild each chunk's pagination metadata so the boundaries — when
    // present — supersede the count-based paging.
    const finalCutPoints = pickChildUnitCutPoints(
        messageIndex,
        emittedBoundaryPositions,
        MESSAGES_PER_CHILD_UNIT
    );
    const finalChildUnitTotal = Math.max(1, finalCutPoints.length - 1);
    // #3763 (review fix): every emission site now stamps `message_index`
    // (api text = its own index, api tool = parent message index, ui = its
    // own `uiMessageIndex`), so the emitted index is read directly. The
    // cursor heuristic that invented indices for unstamped tool/ui chunks
    // corrupted unit assignment exactly at boundaries — it is gone.
    for (const chunk of chunks) {
        const emittedIdx = chunk.message_index!;
        const newUnitIdx = childUnitIndexFor(emittedIdx, finalCutPoints);
        const newIsOverflow = newUnitIdx > 1;
        chunk.child_unit_index = newUnitIdx;
        chunk.child_unit_total = finalChildUnitTotal;
        chunk.task_id = newIsOverflow ? `${taskId}#unit-${newUnitIdx}` : taskId;
        chunk.parent_task_id = newIsOverflow ? taskId : (parentTaskId || null);
        chunk.root_task_id = parentTaskId || (newIsOverflow ? taskId : null);
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}

export function splitChunk(chunk: Chunk, maxSize: number): Chunk[] {
    if (!chunk.content || chunk.content.length <= maxSize) {
        // Chunk unique, on ajoute les métadonnées de traçabilité
        return [{
            ...chunk,
            chunk_index: 1,
            total_chunks: 1
        }];
    }

    // Calcul du nombre total de chunks nécessaires
    const fullTotal = Math.ceil(chunk.content.length / maxSize);
    // #2825 (G1): bound runaway embedding for pathological single values (preserves #1758 intent),
    // but do it as a *bounded, logged* cap here instead of a silent mid-content amputation upstream.
    const totalChunks = Math.min(fullTotal, MAX_SUBCHUNKS_PER_CHUNK);
    const subChunks: Chunk[] = [];
    let content = chunk.content;
    let chunkIndex = 1;

    while (content.length > 0 && chunkIndex <= totalChunks) {
        const contentPart = content.substring(0, maxSize);
        content = content.substring(maxSize);

        // #2018: chunk.chunk_id is now deterministic upstream (computeChunkId),
        // so the split parts inherit determinism: same input → same UUIDs.
        const compositeId = `${chunk.chunk_id}_part_${chunkIndex}`;
        const deterministicUuid = uuidv5(compositeId, UUID_NAMESPACE);

        subChunks.push({
            ...chunk,
            chunk_id: deterministicUuid, // UUID valide au lieu de string arbitraire
            content: contentPart,
            content_summary: `Chunk ${chunkIndex}/${totalChunks}: ${contentPart.substring(0, 100)}...`,
            // Nouveaux champs de traçabilité
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            original_chunk_id: chunk.chunk_id // Garder trace de l'ID original
        });
        chunkIndex++;
    }

    // #2825 (G1): never a silent drop — surface any residual per the "no silent caps" principle.
    if (content.length > 0) {
        console.warn(`⚠️ [splitChunk] chunk ${chunk.chunk_id} exceeded MAX_SUBCHUNKS_PER_CHUNK=${MAX_SUBCHUNKS_PER_CHUNK} (content ${chunk.content.length} chars, maxSize=${maxSize}, full split would be ${fullTotal} parts); ${content.length} residual chars NOT indexed. Raise MAX_SUBCHUNKS_PER_CHUNK to index the whole value.`);
    }

    console.log(`🔪 Split large chunk into ${subChunks.length} parts (original size: ${chunk.content.length} chars${fullTotal > totalChunks ? `, capped from ${fullTotal}` : ''})`);
    return subChunks;
}

/**
 * Extract chunks from a Claude Code JSONL session file.
 * Reads the JSONL format (one JSON object per line) and converts
 * user/assistant messages to indexable chunks.
 *
 * #852 FIX: Now accepts a project directory and scans all JSONL files within it.
 *
 * @param taskId The session identifier (prefixed with 'claude-')
 * @param projectPath Path to the project directory (will scan for .jsonl files) OR direct .jsonl file path
 * @param metadata Optional metadata (workspace, title)
 * @returns Chunk array suitable for Qdrant indexation
 */
export async function extractChunksFromClaudeSession(
    taskId: string,
    projectPath: string,
    metadata?: { workspace?: string; title?: string }
): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    let sequenceOrder = 0;
    let messageIndex = 0;
    // #3344: workspace derived from JSONL `cwd` when the caller passes no metadata
    // (28% of sampled claude-code points on ai-01 carried NEITHER workspace NOR
    // workspace_name). Same priority as claude-storage-detector detectWorkspace()
    // (PRIORITÉ 1: entry.cwd) — but applied at CHUNK level so indexed points carry it.
    let derivedWorkspace: string | undefined;

    try {
        // #852 FIX: Accept project directory and scan for JSONL files
        const stat = await fs.stat(projectPath);
        let jsonlFiles: string[];

        if (stat.isDirectory()) {
            // projectPath is a directory - scan for JSONL files
            const entries = await fs.readdir(projectPath);
            jsonlFiles = entries
                .filter(e => e.endsWith('.jsonl'))
                .map(e => path.join(projectPath, e));

            if (jsonlFiles.length === 0) {
                console.log(`[Claude] No JSONL files found in ${projectPath}`);
                return [];
            }
            console.log(`[Claude] Found ${jsonlFiles.length} JSONL files in ${projectPath}`);
        } else {
            // projectPath is a file - use directly (backward compatibility)
            jsonlFiles = [projectPath];
        }

        // Process all JSONL files - collect partial results on error
        const fileErrors: { file: string; error: string }[] = [];

        for (const jsonlFile of jsonlFiles) {
            try {
                // Stream JSONL instead of loading entire file into memory.
                // 112 MB files cause 300s+ timeout when read+split all at once.
                // #2825 (G2): process every line inline — do NOT cap the in-memory
                // buffer at MAX_MESSAGES_PER_TASK. Each line is emitted as a chunk
                // tagged with `child_unit_index` (its page number) so the full
                // conversation stays searchable in Qdrant. Memory stays bounded
                // because chunks are pushed (not accumulated as strings).
                const fileStream = createReadStream(jsonlFile, 'utf-8');
                const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

                let totalLines = 0;
                let fileMessageCount = 0;
                // #3763: track condensation boundaries per emitted-message index.
                // Each emitted (post-filter) message that starts with a known
                // marker pushes its global `messageIndex` here. Post-stream we
                // patch every chunk from this file with the chapter-aligned
                // child-unit index and total (same patch pattern as #2828 nit 2,
                // which already runs in the `fileMessageCount > MAX_MESSAGES_PER_TASK`
                // branch below).
                const fileBoundaryPositions: number[] = [];
                // Capture the global messageIndex at file start so we can map
                // emitted-index <-> local-index within this file. `messageIndex`
                // is global (not reset between files in this loop), so without
                // this offset the boundary-patch branch would map boundaries
                // from earlier files into the current file's range.
                const fileStartGlobal = messageIndex + 1;

                for await (const line of rl) {
                    if (!line.trim()) continue;
                    totalLines++;
                    try {
                        const entry = JSON.parse(line);
                        if (!derivedWorkspace && entry.cwd) derivedWorkspace = entry.cwd;

                        // Claude Code JSONL has entries with type and message fields
                        const entryType = entry.type;
                        const message = entry.message;

                        // Only index user and assistant messages (not tool results, system, etc.)
                        if (!message || !message.content) continue;
                        if (entryType !== 'user' && entryType !== 'assistant') continue;

                        const role: 'user' | 'assistant' = entryType === 'user' ? 'user' : 'assistant';

                        // Extract text content (can be string or array of content blocks)
                        let contentText = '';
                        let claudeToolUseBlocks: any[] = [];
                        if (typeof message.content === 'string') {
                            contentText = message.content;
                        } else if (Array.isArray(message.content)) {
                            contentText = message.content
                                .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
                                .map((block: any) => block.text)
                                .join(' ')
                                .trim();

                            // #2949: Fold tool_result blocks (Anthropic format) into contentText
                            // so tool output is indexed/searchable. Same fix as the API path above
                            // and as claude-storage-detector.extractContent (#894).
                            const toolResultText = extractToolResultText(message.content);
                            if (toolResultText) {
                                contentText = toolResultText + (contentText ? '\n\n' + contentText : '');
                            }

                            // #2336 D2 étape B: Collect tool_use blocks for tool_interaction chunks
                            claudeToolUseBlocks = message.content.filter(
                                (block: any) => block && typeof block === 'object' && block.type === 'tool_use'
                            );
                        }

                        if (!contentText.trim() && claudeToolUseBlocks.length === 0) continue;

                        // #2825 (G1): content carried in FULL — split losslessly downstream by splitChunk (no mid-content amputation).
                        messageIndex++;
                        fileMessageCount++;
                        // #3763: detect inline condensation boundary on this emitted
                        // Claude Code message. We reuse the same marker regex as
                        // `detectCondensationBoundaries` (synthetic condensation
                        // archive prefix) — Claude Code's runtime may not emit
                        // these markers natively, so detection on this path is
                        // best-effort and the count-based fallback still dominates.
                        if (
                            contentText.startsWith('[CONDENSATION ARCHIVE]') ||
                            contentText.startsWith('[Condensation summary]')
                        ) {
                            fileBoundaryPositions.push(messageIndex);
                        }
                        // #636: Detect error patterns and extract model
                        const ccLower = contentText.toLowerCase();
                        const ccHasError = ccLower.includes('error') || ccLower.includes('failed') || ccLower.includes('❌');

                        // #2828 nit 2: page on emitted-message count (fileMessageCount),
                        // NOT raw line count (totalLines). Lines skipped by `continue` (no
                        // content, parse errors, non-user/assistant types) inflate totalLines
                        // and create phantom child units that hold zero chunks.
                        const claudeUnitIndex0 = Math.floor((fileMessageCount - 1) / MAX_MESSAGES_PER_TASK);
                        const claudeChildUnitIdx = claudeUnitIndex0 + 1;
                        const claudeIsOverflow = claudeChildUnitIdx > 1;
                        // Running estimate — patched post-stream with the final total below.
                        const claudeChildUnitTotal = Math.max(1, claudeChildUnitIdx);
                        const claudeEffectiveTaskId = claudeIsOverflow
                            ? `${taskId}#unit-${claudeChildUnitIdx}`
                            : taskId;

                        const seq = sequenceOrder++;
                        // po-204 c.161: route code citations to chunk_type='code_citation'
                        // in the Claude Code path too — the JSONL session can carry
                        // tool_result payloads (often JSON / code) re-ingested as fresh turns.
                        const claudeChunkType: Chunk['chunk_type'] = isCodeCitation(contentText)
                            ? 'code_citation'
                            : 'message_exchange';
                        const chunkWorkspace = metadata?.workspace || derivedWorkspace;
                        chunks.push({
                            chunk_id: computeChunkId(claudeEffectiveTaskId, claudeChunkType, seq, contentText),
                            task_id: claudeEffectiveTaskId,
                            parent_task_id: claudeIsOverflow ? taskId : null,
                            root_task_id: claudeIsOverflow ? taskId : null,
                            chunk_type: claudeChunkType,
                            sequence_order: seq,
                            timestamp: entry.timestamp || new Date().toISOString(),
                            indexed: true,
                            content: contentText,
                            content_summary: contentText.substring(0, 200),
                            participants: [role],
                            tool_details: null,
                            workspace: chunkWorkspace,
                            workspace_name: chunkWorkspace ? workspaceBasename(chunkWorkspace) : undefined,
                            task_title: metadata?.title,
                            message_index: messageIndex,
                            role,
                            host_os: getHostIdentifier(),
                            source: 'claude-code',
                            // #636: Enriched metadata
                            model: entry.model || message?.model,
                            has_error: ccHasError || undefined,
                            // #2825 (G2/G3): pagination metadata
                            child_unit_index: claudeChildUnitIdx,
                            child_unit_total: claudeChildUnitTotal,
                        });

                        // #2336 D2 étape B: Emit tool_interaction chunks for Claude Code tool_use blocks
                        for (const toolBlock of claudeToolUseBlocks) {
                            const toolName = toolBlock.name || 'unknown';
                            let parsedInput: any = {};
                            try {
                                parsedInput = typeof toolBlock.input === 'string'
                                    ? JSON.parse(toolBlock.input)
                                    : (toolBlock.input || {});
                            } catch { parsedInput = { raw: toolBlock.input }; }

                            // #2825 (G1): full args carried — split losslessly downstream by splitChunk.
                            const toolContent = `Tool call: ${toolName} with args ${JSON.stringify(parsedInput)}`;

                            // #2825 (G2/G3): tool chunks follow the same child-unit paging as their message
                            const toolSeq = sequenceOrder++;
                            chunks.push({
                                chunk_id: computeChunkId(claudeEffectiveTaskId, 'tool_interaction', toolSeq, toolContent),
                                task_id: claudeEffectiveTaskId,
                                parent_task_id: claudeIsOverflow ? taskId : null,
                                root_task_id: claudeIsOverflow ? taskId : null,
                                chunk_type: 'tool_interaction',
                                sequence_order: toolSeq,
                                timestamp: entry.timestamp || new Date().toISOString(),
                                indexed: true, // #2247: tool interactions are valuable search targets
                                content: toolContent,
                                tool_details: {
                                    tool_name: toolName,
                                    parameters: parsedInput,
                                    status: 'success',
                                },
                                tool_name: toolName,
                                model: entry.model || message?.model,
                                workspace: chunkWorkspace,
                                workspace_name: chunkWorkspace ? workspaceBasename(chunkWorkspace) : undefined,
                                task_title: metadata?.title,
                                host_os: getHostIdentifier(),
                                source: 'claude-code',
                                // #3763 (review fix): tool chunks carry their
                                // PARENT message's emitted index — the per-file
                                // unit patch below reads `message_index`
                                // directly (the old `?? fileStartLocal`
                                // fallback pinned every tool chunk to unit 1).
                                message_index: messageIndex,
                                // #2825 (G2/G3): pagination metadata
                                child_unit_index: claudeChildUnitIdx,
                                child_unit_total: claudeChildUnitTotal,
                            });
                        }
                    } catch (parseError) {
                        // Skip malformed lines but log for debugging
                        console.warn(`[Claude] Skipping malformed line in ${jsonlFile}: ${parseError}`);
                        continue;
                    }
                }
                rl.close();
                fileStream.destroy();

                if (fileMessageCount > MAX_MESSAGES_PER_TASK) {
                    const claudeChildUnitCount = Math.max(1, Math.ceil(fileMessageCount / MAX_MESSAGES_PER_TASK));
                    console.warn(`⚠️ [#2825/G2] Claude session ${taskId} has ${fileMessageCount} emitted messages (from ${totalLines} raw lines) — exceeds MAX_MESSAGES_PER_TASK=${MAX_MESSAGES_PER_TASK}; splitting into ${claudeChildUnitCount} child units (NO DROP, all messages indexed).`);
                    // #2828 nit 2: patch all chunks from this file with the accurate
                    // child_unit_total (the running estimate during streaming is a lower
                    // bound — only after the full file is read do we know the real total).
                    for (const chunk of chunks) {
                        if (chunk.source === 'claude-code') {
                            chunk.child_unit_total = claudeChildUnitCount;
                        }
                    }
                }
                // #3763: post-stream patch for chapter-aligned cut points. When
                // boundaries were detected in this file, recompute cut points
                // from `fileBoundaryPositions` and re-stamp each chunk from this
                // file with the boundary-aligned child-unit index + total +
                // task_id + parent_task_id + root_task_id (so the lineage chain
                // stays reconstructible via `conversation_browser`).
                if (fileBoundaryPositions.length > 0) {
                    // `messageIndex` at file close is the GLOBAL emitted count;
                    // `fileStartGlobal` captured at file start, so the file
                    // occupies global indices [fileStartGlobal, messageIndex].
                    const fileEndLocal = fileMessageCount;
                    const fileStartLocal = 1;
                    const localBoundaries = fileBoundaryPositions
                        .filter(b => b >= fileStartGlobal && b <= messageIndex)
                        .map(b => b - fileStartGlobal + 1);
                    const localCutPoints = pickChildUnitCutPoints(
                        fileMessageCount,
                        localBoundaries,
                        MAX_MESSAGES_PER_TASK
                    );
                    const localChildUnitTotal = Math.max(1, localCutPoints.length - 1);
                    for (const chunk of chunks) {
                        if (chunk.source !== 'claude-code') continue;
                        // #3763 (review fix): translate the chunk's global
                        // message_index to a local (1-based) emitted index
                        // within this file — read directly, every emission
                        // site stamps it (the old `?? fileStartLocal` fallback
                        // collapsed all tool chunks onto unit 1).
                        const localIdx = chunk.message_index! - fileStartGlobal + 1;
                        if (localIdx < fileStartLocal || localIdx > fileEndLocal) continue;
                        const newUnitIdx = childUnitIndexFor(localIdx, localCutPoints);
                        const newIsOverflow = newUnitIdx > 1;
                        chunk.child_unit_index = newUnitIdx;
                        chunk.child_unit_total = localChildUnitTotal;
                        chunk.task_id = newIsOverflow ? `${taskId}#unit-${newUnitIdx}` : taskId;
                        chunk.parent_task_id = newIsOverflow ? taskId : null;
                        chunk.root_task_id = newIsOverflow ? taskId : null;
                    }
                }

                console.log(`[Claude] Extracted ${fileMessageCount} chunks from ${path.basename(jsonlFile)}`);
            } catch (fileError) {
                // Log file-level errors but continue processing other files
                const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
                fileErrors.push({ file: jsonlFile, error: errorMsg });
                console.error(`[Claude] Error reading ${jsonlFile}: ${errorMsg}`);
            }
        }

        // Log summary if there were file errors
        if (fileErrors.length > 0) {
            console.warn(`[Claude] Completed with ${fileErrors.length} file error(s): ${fileErrors.map(e => e.file).join(', ')}`);
        }
    } catch (error) {
        // Only throw for critical errors (e.g., directory not found, permission denied)
        console.error(`❌ Critical error extracting chunks from Claude session ${projectPath}:`, error);
        throw new StateManagerError(
            `Extraction chunks échouée pour Claude session ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            'CHUNK_EXTRACTION_FAILED',
            'ChunkExtractor',
            { taskId, projectPath },
            error instanceof Error ? error : undefined
        );
    }

    return chunks.sort((a, b) => a.sequence_order - b.sequence_order);
}