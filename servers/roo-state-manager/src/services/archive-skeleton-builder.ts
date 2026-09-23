/**
 * Archive → ConversationSkeleton conversion helper.
 *
 * Issue #1244 - Couche 1.1: Multi-tier skeleton cache
 *
 * Converts an `ArchivedTask` (cross-machine archive format on GDrive) into a
 * `ConversationSkeleton` so it can be merged into the standard skeleton cache.
 *
 * The archive format is intentionally minimal (metadata + plain messages) and
 * loses tool/action structure. We surface that by marking each message as
 * `isTruncated: false` (the archive content is what we have) and producing zero
 * action metadata. The `dataSource: 'archive'` marker on the metadata lets
 * downstream tools know this skeleton came from a cold-tier source.
 */

import { ConversationSkeleton, MessageSkeleton } from '../types/conversation.js';
import { ArchivedTask } from './task-archiver/types.js';
import { stripXmlTags, truncateAtBoundary } from '../utils/text-preview.js';

/**
 * Preview truncation lengths — MUST mirror the listing extraction in
 * list-conversations.tool.ts (firstUser 900, lastUser 500, lastAny 500) so a
 * stub renders the same preview fields as a full skeleton built on the same
 * archive (#3661 review: stub listing must not regress to title-only).
 */
const PREVIEW_FIRST_USER_MAX = 900;
const PREVIEW_LAST_USER_MAX = 500;
const PREVIEW_LAST_MESSAGE_MAX = 500;

/**
 * Convert an `ArchivedTask` (cross-machine GDrive archive) into a `ConversationSkeleton`.
 *
 * Notes:
 * - Messages keep their role/content/timestamp from the archive.
 * - `metadata.dataSource = 'archive'` flags this skeleton as cold-tier.
 * - `metadata.machineId` is preserved from the archive (cross-machine attribution).
 * - `actionCount` and `totalSize` are 0 because the archive does not contain
 *   tool/action metadata or original byte sizes.
 */
export function archiveToSkeleton(archive: ArchivedTask): ConversationSkeleton {
    const sequence: MessageSkeleton[] = (archive.messages || []).map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || archive.archivedAt,
        isTruncated: false,
    }));

    const fallbackTimestamp = archive.archivedAt;

    return {
        taskId: archive.taskId,
        parentTaskId: archive.metadata?.parentTaskId,
        isCompleted: archive.metadata?.isCompleted ?? false,
        metadata: {
            title: archive.metadata?.title,
            workspace: archive.metadata?.workspace,
            mode: archive.metadata?.mode,
            createdAt: archive.metadata?.createdAt ?? fallbackTimestamp,
            lastActivity: archive.metadata?.lastActivity ?? fallbackTimestamp,
            messageCount: archive.metadata?.messageCount ?? sequence.length,
            actionCount: 0,
            totalSize: 0,
            machineId: archive.machineId,
            source: archive.metadata?.source ?? 'roo',
            parentTaskId: archive.metadata?.parentTaskId,
            dataSource: 'archive',
        },
        sequence,
    };
}

/**
 * #3661 — Variante stub du Tier 3 : metadata seule, AUCUNE construction de
 * sequence (le mapping des messages est la partie chère — c'est elle qu'on
 * ne paie pas au cold load). Le corps se charge à la demande via
 * `SkeletonCacheService.ensureConversationHydrated()`, ou se lit en
 * différé borné via `metadata.archiveFilePath` (recherche par contenu).
 *
 * L'aperçu du listing (premier/dernier message) est calculé ICI, pendant que
 * l'archive complète est déjà en mémoire : sans ça, le listing ne verrait que
 * `metadata.title` et perdrait la visibilité cross-machine (#3661 review).
 * Les champs `_stub*` suivent le pattern des replis `_claude*` du listing.
 * `lastAction`/`completionMessage` ne sont pas portés : les archives ne
 * contiennent pas de structure d'outils (messages simples role+content).
 */
export function archiveToStub(archive: ArchivedTask, filePath: string): ConversationSkeleton {
    const fallbackTimestamp = archive.archivedAt;

    const messages = archive.messages || [];
    let firstUserMessage: string | undefined;
    let lastUserMessage: string | undefined;
    let lastMessage: string | undefined;
    let lastMessageRole: 'user' | 'assistant' | undefined;
    let userMessageCount = 0;
    let assistantMessageCount = 0;

    for (const msg of messages) {
        if (!msg || !msg.content) continue;
        if (msg.role === 'user') {
            userMessageCount++;
            if (!firstUserMessage) {
                firstUserMessage = truncateAtBoundary(stripXmlTags(msg.content) || msg.content, PREVIEW_FIRST_USER_MAX);
            }
            lastUserMessage = truncateAtBoundary(stripXmlTags(msg.content) || msg.content, PREVIEW_LAST_USER_MAX);
        } else if (msg.role === 'assistant') {
            assistantMessageCount++;
        }
        // Dernier message de tout rôle (user ou assistant) — même règle que le listing.
        lastMessage = truncateAtBoundary(stripXmlTags(msg.content) || msg.content, PREVIEW_LAST_MESSAGE_MAX);
        lastMessageRole = msg.role;
    }

    return {
        taskId: archive.taskId,
        parentTaskId: archive.metadata?.parentTaskId,
        isCompleted: archive.metadata?.isCompleted ?? false,
        metadata: {
            title: archive.metadata?.title,
            workspace: archive.metadata?.workspace,
            mode: archive.metadata?.mode,
            createdAt: archive.metadata?.createdAt ?? fallbackTimestamp,
            lastActivity: archive.metadata?.lastActivity ?? fallbackTimestamp,
            messageCount: archive.metadata?.messageCount ?? (archive.messages?.length ?? 0),
            actionCount: 0,
            totalSize: 0,
            machineId: archive.machineId,
            source: archive.metadata?.source ?? 'roo',
            parentTaskId: archive.metadata?.parentTaskId,
            dataSource: 'gdrive-archive',
            hydrated: false,
            archiveFilePath: filePath,
        },
        sequence: [],
        _stubFirstUserMessage: firstUserMessage,
        _stubLastUserMessage: lastUserMessage,
        _stubLastMessage: lastMessage,
        _stubLastMessageRole: lastMessageRole,
        _stubUserCount: userMessageCount,
        _stubAssistantCount: assistantMessageCount,
    } as ConversationSkeleton & {
        _stubFirstUserMessage?: string;
        _stubLastUserMessage?: string;
        _stubLastMessage?: string;
        _stubLastMessageRole?: 'user' | 'assistant';
        _stubUserCount?: number;
        _stubAssistantCount?: number;
    };
}
